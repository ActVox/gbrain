/**
 * #6712 PR 4b (design v3.2 §2.2, §3.1-§3.5, §8, §9; v3 §3.1-§3.3, §3.5): the live level-triggered pass of a managed,
 * non-company source. Under the source's drain lease it pins the target (`HEAD`), decides the pass kind, and runs rounds:
 *
 * - **Pin.** The pass row, `sync.admission`, `HEAD` and the mode (a detached `HEAD` forces working mode) are read; the
 *   row is written with a new `pass_id` and the lease's token (`writePassRow(..., { pin: true })` after `assertDrainLease`).
 *   An unfinished legacy cursor is superseded first (§3.5): its open requests are waited for, its options seed the episode.
 * - **Idle** (§2.2): nothing moved since the converged stamp, so only `last_sync_at` is stamped (`up_to_date`).
 * - **Rounds** (§3.1): round k reads the level (sync-pass.ts `readShadowLevel`) and classifies; `C_k = unsettled − S`.
 *   Candidates are admitted in batches of at most 10,000 (deletes, then imports) through the cursor machinery of
 *   sync-run.ts on an in-memory batch (sync-pass-batch.ts): freeze, screen, waive, group, admit, await and settle; every
 *   settled `(path, level)` joins `S` and is never admitted again in the pass. With nothing unsettled and nothing in
 *   flight, the stamp (sync-prepare.ts `applyPassCheckpoint`) publishes the converged state. Four rounds without
 *   converging stop `resumable` (`not_converged`).
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import type { Cursor, RetryWait } from './sync-run.ts';
import { syncExcludePatterns, syncGit, type ManagedSyncContext, type SyncSlugCollision } from './sync-discovery.ts';
import type { SyncAuthority, SyncProcessingOptions } from './sync-authority.ts';
import type { PassStamp, SyncCursorOptions } from './sync-prepare.ts';
import { OPEN_AT_STAMP_CAP, passFingerprint, readPassRow, SYNC_ORIGIN_DELETED_OP, writePassRow, type ManagedSyncPassValue, type PassEpisode,
  type PassKind, type PassOutcome, type SyncSelection } from './sync-pass-row.ts';
import { readSyncAdmission, type SyncAdmission } from './sync-admission.ts';
import { passIdleProbe, readShadowLevel, workingIdleChange, type ShadowLevel, type ShadowPath } from './sync-pass.ts';
import { recallWorkingStatCache, rememberWorkingStatCache } from './sync-git-stream.ts';
import { syncPassKind } from './sync-classify.ts';
import { PASS_BATCH_KEY_PREFIX, readConvergedWatermark, SyncAdmissionPaused, type PassEntry } from './sync-pass-batch.ts';
import { assertDrainLease, currentDrainLease } from './sync-lease.ts';
import { digest } from './digest.ts';
import { readSyncTail } from './sync-tail-record.ts';
import { holdRescreenDue, readGitHoldRetryPaths, readGitSourceHolds, syncImportParserFor } from './sync-holds.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { clearManagedSyncFailureAfterSuccess } from './sync-failures.ts';
import { managedCursorKey, resolveManagedCursor, retireManagedCursor } from './sync-cursor-key.ts';
import { withCoordinatedWrite } from './context.ts';
import { principalAttribution } from './attribution.ts';
import { resolveSlugForPath } from '../sync.ts';
import { syncOriginPath } from './sync-origin.ts';
import { originMarkerFingerprint } from './sync-markers.ts';
import { passResumeArgs } from './sync-pass-readers.ts';
import { applyPassRound, finishPassApply, newPassApplyState, passApplyCounts } from './sync-pass-apply.ts';
import { passCostDecision, passEpisodeClosure, readReservedUsd, registerPassCost, unregisterPassCost } from './sync-pass-episode.ts';
import { currentEmbeddingPricePerMTok } from '../embedding.ts';

/** Rounds a pass runs before it stops `not_converged` (design §3.1). */
export const PASS_MAX_ROUNDS = 4;
/** Candidates per round batch (design §3.1). */
export const PASS_BATCH_MAX = 10_000;
/** Waits for in-flight work a pass makes before it stops `writer_pending`, each bounded by the wait budget. */
const IN_FLIGHT_WAITS = 4;

export interface SyncPassInput {
  opts: SyncOpts; slice?: { maxPages: number; maxMs: number }; context: ManagedSyncContext; authority: SyncAuthority;
  processingOptions: SyncProcessingOptions; syncOptions: SyncCursorOptions; assertActive: () => void; signal?: AbortSignal;
  state: { sourceId?: string; incarnation?: string; remote?: boolean }; runStartedAt: string;
  /** Drains one round batch through sync-run.ts's cursor loop: the batch back when it drained, or the result it stopped with. */
  drainBatch: (key: string, batch: Cursor, sliceBase: { started: number; pages: number }) => Promise<SyncResult | Cursor>;
}

/** The selection a pass syncs (design §6), with the configured one's test: no selection flag differs from the source's configuration. */
async function passSelection(engine: BrainEngine, opts: SyncOpts, context: ManagedSyncContext, mode: SyncSelection['mode']): Promise<SyncSelection> {
  const exclude = [...await syncExcludePatterns(engine, opts.exclude)].sort();
  const includeHidden = [...new Set([...opts.includeHidden ?? [], ...(await engine.getConfig('sync.include_hidden') ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)]
    .map(v => v.endsWith('/') ? `${v}**` : v))].sort();
  return { exclude, includeHidden, strategy: opts.strategy ?? (context.source.config?.strategy as string | undefined) ?? 'markdown', srcSubpath: opts.srcSubpath ?? null, mode };
}

/** The parser fingerprint every import kind records (Markdown, code, image); a change makes the next pass a full round. */
const parserFingerprint = () => digest(['x.md', 'x.ts', 'x.png'].map(path => syncImportParserFor(path, null)));

/**
 * Design §3.5: the source's legacy cursors go on the first pass of an incarnation. Every unfinished one is superseded under
 * the lease (queued requests cancelled, a running, recovering or publishing one waited for); a finished one is deleted.
 * The newest unfinished cursor's options seed the episode (`inherited.from = 'legacy_cursor'`; a `--full` cursor seeds a
 * full episode). A remote caller retires nothing: an unfinished cursor leaves it to the brain host.
 */
async function retireLegacyCursors(engine: BrainEngine, input: { sourceId: string; incarnation: string; remote: boolean; assertActive: () => void }):
  Promise<{ wait?: RetryWait; hostRequired?: true; episode?: PassEpisode }> {
  const resolution = await resolveManagedCursor(engine, { sourceId: input.sourceId, incarnation: input.incarnation, company: undefined, assertActive: input.assertActive, foldIn: !input.remote });
  if (resolution.waitFor) return { wait: { ...resolution.waitFor, retry_after_ms: 5000 } };
  const [row] = await engine.executeRaw<{ header: { runId?: string; done?: boolean; processingOptions?: SyncProcessingOptions; syncOptions?: SyncCursorOptions & { exclude?: string[]; includeHidden?: string[]; strategy?: string; srcSubpath?: string; workingTree?: boolean } } | null }>(
    "SELECT completed_keys->0 AS header FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [resolution.key]);
  const header = row?.header;
  if (!header) return {};
  if (input.remote) return header.done ? {} : { hostRequired: true };
  const busy = await retireManagedCursor(engine, { sourceId: input.sourceId, incarnation: input.incarnation, key: resolution.key, runId: header.runId ?? null, done: header.done === true });
  input.assertActive();
  if (busy) return { wait: { ...busy, retry_after_ms: 5000 } };
  if (header.done) return {};
  const options = header.processingOptions, sync = header.syncOptions;
  return { episode: { opened_at: new Date().toISOString(), ...(sync?.full ? { full_id: randomUUID() } : {}),
    selection: { exclude: [...sync?.exclude ?? []].sort(), includeHidden: [...sync?.includeHidden ?? []].sort(), strategy: sync?.strategy ?? null, srcSubpath: sync?.srcSubpath ?? null,
      mode: sync?.workingTree ? 'working' : 'committed' },
    inherited: { noEmbed: options?.noEmbed === true, noExtract: options?.noExtract === true, noSchemaPack: options?.noSchemaPack === true, from: 'legacy_cursor' } } };
}

/** The path forms of one level path: root-relative (`SyncEntry.path`) and the recorded origin (`sourcePath`). */
function entryPaths(level: ShadowLevel, gitPath: string): { path: string; sourcePath: string } {
  const path = level.scope ? gitPath.slice(level.scope.length + 1) : gitPath;
  return { path, sourcePath: level.slugMode === 'source-root' && level.scope ? path : gitPath };
}

/**
 * The round's candidates as batch entries, with the identities discovery resolves (`discoverManagedSync`): a live page
 * at the origin is the import's page; a new origin takes the slug its path names, and the page holding that slug is
 * taken over when its own origin leaves in this pass (`renameFrom`, its deletion retired), a collision when its origin
 * stays; one new origin whose bytes equal a page leaving at another origin is that page's Git rename (`renameFrom`, the
 * page moves to the new slug). Deletes first, then imports.
 */
async function batchEntries(engine: BrainEngine, level: ShadowLevel, deletes: ShadowPath[], imports: ShadowPath[]):
  Promise<{ entries: PassEntry[]; collisions: SyncSlugCollision[]; skipped: ShadowPath[] }> {
  const working = (entry: ShadowPath) => level.mode === 'working' && entry.state.level !== entry.state.tree;
  const deleteEntries = new Map<string, PassEntry>(deletes.map(entry => [entry.path, { ...entryPaths(level, entry.path), action: 'delete' as const, working: level.mode === 'working',
    slug: entry.slug!, pageId: entry.pageId, revision: entry.revision, level: null }]));
  const leaving = new Map(deletes.map(entry => [entry.path, entry]));
  const fresh = imports.filter(entry => !entry.state.page);
  const slugOf = new Map(fresh.map(entry => [entry.path, resolveSlugForPath(entryPaths(level, entry.path).sourcePath)]));
  const slugs = [...new Set([...slugOf.values()].filter(Boolean))];
  const holders = new Map((slugs.length ? await engine.executeRaw<{ id: number | string; slug: string; source_path: string | null; revision: string; deleted: boolean }>(
    'SELECT id, slug, source_path, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])', [level.sourceId, slugs]) : [])
    .map(page => [page.slug, page]));
  const gitPathOfOrigin = (origin: string) => level.slugMode === 'source-root' && level.scope ? `${level.scope}/${syncOriginPath(origin)}` : syncOriginPath(origin);
  const entries: PassEntry[] = [], collisions: SyncSlugCollision[] = [], skipped: ShadowPath[] = [];
  const claims = new Map<string, ShadowPath[]>();
  for (const entry of imports) {
    const paths = entryPaths(level, entry.path);
    const base = { ...paths, action: 'import' as const, working: working(entry), level: entry.state.level, ...(entry.result.cls === 'drift' && entry.result.side && entry.result.side !== 'deleted' ? { drift: entry.result.side } : {}) };
    if (entry.state.page) { entries.push({ ...base, slug: entry.slug!, pageId: entry.pageId, revision: entry.revision }); continue; }
    const slug = slugOf.get(entry.path);
    if (!slug) { skipped.push(entry); continue; }
    claims.set(slug, [...claims.get(slug) ?? [], entry]);
  }
  const renamed = new Set<string>();
  for (const [slug, claimants] of claims) {
    const holder = holders.get(slug);
    const holderPath = holder?.source_path ? gitPathOfOrigin(holder.source_path) : null;
    const kept = holder && !holder.deleted && holderPath !== null && !leaving.has(holderPath) ? holderPath : null;
    const winner = kept === null ? claimants.find(entry => /\.mdx?$/i.test(entry.path) && entryPaths(level, entry.path).sourcePath.replace(/\.mdx?$/i, '') === slug) ?? claimants[0]! : null;
    const losers = claimants.filter(entry => entry !== winner);
    if (losers.length) collisions.push({ slug, kept: kept ?? entryPaths(level, winner!.path).sourcePath, skipped: losers.map(entry => entryPaths(level, entry.path).sourcePath) });
    if (!winner) continue;
    const paths = entryPaths(level, winner.path);
    const base = { ...paths, action: 'import' as const, working: working(winner), level: winner.state.level, slug };
    if (holder) {
      entries.push({ ...base, pageId: Number(holder.id), revision: holder.revision,
        ...(holder.source_path !== null ? { renameFrom: { sourcePath: holder.source_path, slug, pageId: Number(holder.id), revision: holder.revision } } : {}) });
      if (holderPath !== null && deleteEntries.delete(holderPath)) renamed.add(holderPath);
      continue;
    }
    const moved = [...leaving.values()].filter(gone => deleteEntries.has(gone.path) && !renamed.has(gone.path) && gone.state.record?.blobOids.includes(winner.state.level ?? ''));
    const twins = fresh.filter(other => other.state.level === winner.state.level);
    if (moved.length === 1 && twins.length === 1) {
      const gone = moved[0]!;
      const origin = entryPaths(level, gone.path).sourcePath;
      entries.push({ ...base, pageId: null, revision: null, renameFrom: { sourcePath: origin, slug: gone.slug!, pageId: gone.pageId!, revision: gone.revision! } });
      deleteEntries.delete(gone.path); renamed.add(gone.path);
      continue;
    }
    entries.push({ ...base, pageId: null, revision: null });
  }
  return { entries: [...deleteEntries.values(), ...entries.sort((a, b) => a.path.localeCompare(b.path))], collisions, skipped };
}

/** Waits (bounded) until no open request or Git effect of the worktree names one of the in-flight pages or origins. */
async function awaitInFlight(engine: BrainEngine, level: ShadowLevel, inFlight: ShadowPath[], budgetMs: number, assertActive: () => void): Promise<void> {
  const pageIds = inFlight.flatMap(entry => entry.pageId === null ? [] : [entry.pageId]);
  const origins = inFlight.map(entry => entryPaths(level, entry.path).sourcePath);
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    const [open] = await engine.executeRaw(`SELECT 1 FROM persistence_requests r WHERE r.source_id=$1 AND (r.state IN ('queued','running','recovering')
        OR EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.state IN ('queued','running')))
      AND (r.page_id=ANY($2::int[]) OR r.intent->>'sourcePath'=ANY($3::text[])) LIMIT 1`, [level.sourceId, pageIds, origins]);
    assertActive();
    if (!open) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Design §2.7 (b1): the incarnation's first pass writes a `legacy` marker, with its deletion proof, for each page-less path deleted before PR 4. */
async function writeLegacyMarkers(engine: BrainEngine, level: ShadowLevel): Promise<number> {
  const rows = level.paths.filter(entry => entry.legacyPageless && entry.state.level).map(entry => ({
    fingerprint: originMarkerFingerprint(level.sourceId, level.incarnation, entryPaths(level, entry.path).sourcePath),
    value: { source_id: level.sourceId, incarnation: level.incarnation, kind: 'legacy', blob_oids: [entry.state.level], deletion: entry.state.marker?.deletion ?? null, at: new Date().toISOString() } }));
  if (!rows.length) return 0;
  await engine.transaction(async tx => {
    await assertDrainLease(tx, level.sourceId);
    await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
      SELECT $1, row->>'fingerprint', jsonb_build_array(row->'value'), now() FROM jsonb_array_elements($2::text::jsonb) AS row ON CONFLICT (op,fingerprint) DO NOTHING`,
    [SYNC_ORIGIN_DELETED_OP, JSON.stringify(rows)]);
  });
  return rows.length;
}

/** The pass of one managed, non-company source (module header). */
export async function runSyncPass(engine: BrainEngine, input: SyncPassInput): Promise<SyncResult> {
  const { opts, context, authority, assertActive } = input;
  const { sourceId, incarnation } = context;
  const remote = authority.writer.remote;
  const lease = currentDrainLease(sourceId);
  if (!lease) throw new Error(`The live sync pass of ${sourceId} runs only under the source's drain lease.`);
  const started = Date.now(), startedAt = new Date(started).toISOString();
  const handover = await retireLegacyCursors(engine, { sourceId, incarnation, remote, assertActive });
  const empty = (status: SyncResult['status'], reason?: SyncResult['reason']): SyncResult => ({ status, fromCommit: remote ? null : context.source.last_commit, toCommit: remote ? '' : context.source.last_commit ?? '',
    added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], filesImported: 0, bankedFiles: 0, ...(reason ? { reason } : {}) });
  if (handover.wait) return { ...empty('partial', 'writer_pending'), ...(remote ? {} : { retryWait: handover.wait }) };
  if (handover.hostRequired) return empty('blocked_by_failures', 'reconcile_host_required');

  // Pin (design §2.2): the row, sync.admission, HEAD and the mode.
  const [prior, admission, configuredWorking] = await Promise.all([readPassRow(engine, sourceId, incarnation), readSyncAdmission(engine), engine.getConfig('sync.include_working_tree')]);
  assertActive();
  const head = syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
  const detached = syncGit(context.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD';
  const mode: SyncSelection['mode'] = detached || (opts.workingTree ?? configuredWorking === 'true') ? 'working' : 'committed';
  const selection = await passSelection(engine, opts, context, mode);
  const configured = !remote && !opts.exclude?.length && !opts.includeHidden?.length && !opts.strategy && opts.srcSubpath === undefined
    && (detached || opts.workingTree === undefined || opts.workingTree === (configuredWorking === 'true'));
  const selectionFp = digest(selection), parserFp = parserFingerprint();
  const pack = (await loadActivePackForEngine(engine, { remote: false, sourceId }).catch(() => null))?.identity ?? null;
  const obligations: ManagedSyncPassValue['obligations'] = prior ? structuredClone(prior.value.obligations)
    : { baseline_commit: context.source.last_commit, mismatch: {}, not_converged_streak: 0, faults: {} };
  obligations.mismatch ??= {}; obligations.faults ??= {}; obligations.not_converged_streak ??= 0;
  if (handover.episode && !obligations.episode) obligations.episode = handover.episode;
  const passId = randomUUID();
  const requested = input.processingOptions;
  if (opts.full && !obligations.episode?.full_id) obligations.episode = { opened_at: startedAt, full_id: passId, selection,
    inherited: { noEmbed: requested.noEmbed, noExtract: requested.noExtract, noSchemaPack: requested.noSchemaPack, from: obligations.episode?.inherited.from ?? 'flag' } };
  // A pass that admits under an opt-out opens an episode carrying it (design §6), when it admits its first batch.
  const optOutEpisode: PassEpisode | null = !obligations.episode && (requested.noEmbed || requested.noExtract || requested.noSchemaPack) ? { opened_at: startedAt, selection,
    inherited: { noEmbed: requested.noEmbed, noExtract: requested.noExtract, noSchemaPack: requested.noSchemaPack, from: 'flag' } } : null;
  let episode = obligations.episode;
  // A flagless pass keeps the open episode's opt-outs (#6712 PR 1's inherited_options contract).
  const processingOptions: SyncProcessingOptions = { noEmbed: requested.noEmbed || !!episode?.inherited.noEmbed, noExtract: requested.noExtract || !!episode?.inherited.noExtract,
    noSchemaPack: requested.noSchemaPack || !!episode?.inherited.noSchemaPack };
  const inherited = (['noEmbed', 'noExtract', 'noSchemaPack'] as const).filter(key => processingOptions[key] && !requested[key]);

  // The kind (design §2.2), from the real converged state.
  const converged = obligations.converged;
  const [probe, tail, retry, sourceHolds] = await Promise.all([
    converged ? passIdleProbe(engine, { sourceId, incarnation, worktreeId: context.binding.worktree_id, requestHwm: converged.request_hwm, openAtStamp: converged.open_at_stamp ?? [] }) : null,
    readSyncTail(engine, sourceId), readGitHoldRetryPaths(engine, sourceId, incarnation), readGitSourceHolds(engine, { sourceIds: [sourceId] })]);
  assertActive();
  const holds = (sourceHolds[0]?.holds ?? []).filter(hold => hold.incarnation === incarnation);
  // Working mode (design §2.2): the stat cache this process kept from the round its last stamp used; a cold process has none.
  const cacheKey = passFingerprint(sourceId, incarnation);
  const working = mode === 'working' && converged ? await workingIdleChange(context, recallWorkingStatCache(cacheKey)) : { changed: mode === 'working', cache: null };
  const kindOf = syncPassKind({ converged: converged ? { target: converged.target, parserFp: converged.parser_fp, pack: converged.pack, selectionFp: converged.selection_fp,
      passesSinceFull: converged.passes_since_full, lastFullAt: Date.parse(converged.last_full_at) } : null,
    head, parserFp, pack, selectionFp, now: started, openEpisode: !!episode, owedTail: tail !== null, retryRow: retry.length > 0,
    notConvergedStreak: obligations.not_converged_streak, mismatchStreak: Object.keys(obligations.mismatch).length,
    requestNewer: probe?.newer === true, openAtStampFinished: !!converged && (converged.open_at_stamp === null || (probe?.stillOpen ?? 0) < converged.open_at_stamp.length),
    workingChange: working.changed, rescreenDueHold: holds.some(hold => holdRescreenDue(hold, retry.includes(hold.path))), full: opts.full === true });
  const kind: PassKind = admission === 'classify_only' && kindOf.kind === 'idle' ? 'idle' : kindOf.kind;
  const value: ManagedSyncPassValue = { source_id: sourceId, incarnation, lease_token: lease.token, obligations,
    telemetry: { pass_id: passId, target: head, started_at: startedAt, ended_at: null, kind, round: 0, outcome: 'open', stop_reason: null, candidates: 0, settled: 0, remaining: 0,
      counts: {}, duration_ms: null, timings_ms: {} } };
  const bootstrap = !prior;

  if (kind === 'idle' && working.cache) rememberWorkingStatCache(cacheKey, working.cache);
  if (kind === 'idle') {
    // Master's up_to_date (a complete check that found nothing): only last_sync_at, plus the pass row's count.
    const at = new Date().toISOString();
    value.obligations.converged = { ...converged!, passes_since_full: converged!.passes_since_full + 1 };
    value.obligations.stuck_since = null;
    value.telemetry = { ...value.telemetry, outcome: 'up_to_date', ended_at: at, duration_ms: Date.now() - started };
    await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
      assertActive();
      await assertDrainLease(tx, sourceId);
      await tx.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1 AND incarnation=$2::uuid', [sourceId, incarnation]);
      await writePassRow(tx, value, { pin: true });
    }, principalAttribution(authority.writer.principal)));
    await clearPassFailures(engine, sourceId, incarnation);
    return { ...empty('up_to_date'), toCommit: remote ? '' : head, ...(inherited.length ? { inherited_options: inherited } : {}) };
  }
  // Design §7: the cost decision at pin; an unknown or spent envelope defers embeddings for this pass (never inherited).
  const costScope = episode?.full_id ?? passId;
  const costDecision = await passCostDecision(engine, { sourceId, incarnation, scope: costScope, priorRow: !!prior, prior: obligations.cost, approved: opts.costApproved === true });
  obligations.cost = costDecision.cost;
  let costDeferred: string | null = null;
  if (costDecision.defer && !processingOptions.noEmbed) { processingOptions.noEmbed = true; costDeferred = costDecision.defer; }
  await engine.transaction(async tx => { await assertDrainLease(tx, sourceId); await writePassRow(tx, value, { pin: true }); });
  assertActive();
  registerPassCost(passId, { sourceId, incarnation, scope: costScope, pricePerMTok: currentEmbeddingPricePerMTok() });

  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, chunks: 0, waivedImports: 0, waivedDeletes: 0, held: 0, pausedDeletes: 0, collisions: 0, episodeReleased: 0, costDeferred: costDeferred ? 1 : 0 };
  const collisions: SyncSlugCollision[] = [];
  const S = new Map<string, string>();
  const settledKey = (path: string, level: string | null) => `${path}\0${level ?? ''}`;
  const retryConsumed = new Set<string>(retry);
  const sliceBase = { started: performance.now(), pages: 0 };
  let batchNo = 0, waits = 0, candidatesFirst = 0;
  let lastMismatch: ShadowPath[] = [];
  let lastLevel: ShadowLevel | null = null;
  const rememberLevel = () => { if (lastLevel?.workingCache) rememberWorkingStatCache(cacheKey, lastLevel.workingCache); };
  const applied = newPassApplyState();
  const readmitted = new Set<string>();

  const save = async (outcome: PassOutcome, stopReason: string | null) => {
    const ended = outcome !== 'open';
    value.telemetry = { ...value.telemetry, outcome, stop_reason: stopReason, settled: S.size, counts: { ...counts, ...passApplyCounts(applied) },
      ...(ended ? { ended_at: new Date().toISOString(), duration_ms: Date.now() - started } : {}) };
    if (outcome === 'blocked' || stopReason === 'not_converged') value.obligations.stuck_since ??= new Date().toISOString();
    await engine.transaction(async tx => { await assertDrainLease(tx, sourceId); await writePassRow(tx, value); });
  };
  const result = (status: SyncResult['status'], reason?: SyncResult['reason']): SyncResult => ({ status, fromCommit: remote ? null : context.source.last_commit, toCommit: remote ? '' : head,
    added: counts.added, modified: counts.modified, deleted: counts.deleted, renamed: counts.renamed, chunksCreated: counts.chunks, embedded: 0, pagesAffected: [],
    filesImported: sliceBase.pages, bankedFiles: sliceBase.pages, waived: { imports: counts.waivedImports, deletes: counts.waivedDeletes }, prescreened: 0,
    ...(collisions.length ? { slugCollisions: collisions } : {}), ...(inherited.length ? { inherited_options: inherited } : {}), ...(reason ? { reason } : {}),
    pass: { pass_id: passId, kind, round: value.telemetry.round, outcome: value.telemetry.outcome, stop_reason: value.telemetry.stop_reason, candidates: candidatesFirst,
      settled: S.size, remaining: value.telemetry.remaining, not_converged_streak: value.obligations.not_converged_streak } });
  /** The batch cursor sync-run.ts drains: the discovery shape with no cursor row behind it. */
  const batchCursor = (entries: PassEntry[], stamp?: PassStamp): Cursor => ({ binding: { ...context.binding, owner_epoch: String(context.binding.owner_epoch), topology_generation: String(context.binding.topology_generation) },
    root: context.root, gitRoot: context.gitRoot, sourceId, incarnation, from: context.source.last_commit, target: head, entries, slugMode: levelSlugMode, discoveredAt: startedAt,
    runId: passId, passId, index: 0, authority, processingOptions, syncOptions: input.syncOptions, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 },
    failureKey: passFingerprint(sourceId, incarnation), resumeArgs: passResumeArgs(sourceId, { value, updated_at: startedAt }), ...(episode?.full_id ? { fullEpisode: episode.full_id } : {}), ...(stamp ? { stamp } : {}) });
  let levelSlugMode: Cursor['slugMode'] = 'git-root';
  /** Drains one batch; a stop is the pass's ending (the batch's counts are folded in either way). */
  const drain = async (entries: PassEntry[], stamp?: PassStamp): Promise<SyncResult | null> => {
    const key = `${PASS_BATCH_KEY_PREFIX}${passId}:${batchNo++}`;
    const batch = batchCursor(entries, stamp);
    const drained = await input.drainBatch(key, batch, sliceBase);
    if ('entries' in drained) {
      const c = drained.counts;
      Object.assign(counts, { added: counts.added + c.added, modified: counts.modified + c.modified, deleted: counts.deleted + c.deleted, renamed: counts.renamed + (c.renamed ?? 0),
        chunks: counts.chunks + c.chunks, waivedImports: counts.waivedImports + (c.waived?.imports ?? 0), waivedDeletes: counts.waivedDeletes + (c.waived?.deletes ?? 0), held: counts.held + (c.held ?? 0) });
      sliceBase.pages += drained.index;
      return null;
    }
    return drained;
  };
  const stop = async (drained: SyncResult): Promise<SyncResult> => {
    const outcome: PassOutcome = drained.status === 'blocked_by_failures' ? 'blocked' : 'resumable';
    await save(outcome, drained.reason ?? (outcome === 'blocked' ? 'blocked_by_failures' : null));
    const { runId: _run, managedCursor: _cursor, ...rest } = drained;
    return { ...rest, ...result(drained.status, drained.reason) };
  };

  try {
    for (let round = 1; round <= PASS_MAX_ROUNDS; round++) {
      assertActive();
      value.telemetry.round = round;
      const level = await readShadowLevel(engine, { sourceId, context, workingTree: mode === 'working',
        pass: { episodeFullId: episode?.full_id ?? null, retryConsumed: round > 1 ? retryConsumed : undefined, exclude: opts.exclude, includeHidden: opts.includeHidden, strategy: opts.strategy, bootstrap } });
      assertActive();
      if (!level) throw new Error(`Source ${sourceId} became a company-brain source during its sync pass.`);
      levelSlugMode = level.slugMode;
      lastLevel = level;
      value.telemetry.timings_ms = level.timings_ms;
      if (bootstrap && round === 1) await writeLegacyMarkers(engine, level);
      await applyPassRound(engine, level, { passId, observedAt: startedAt, remote, admission, fullRound: kind === 'full', obligations: value.obligations, context, processingOptions }, applied);
      assertActive();
      if (applied.sweptAll && !value.obligations.legacy_sweep) value.obligations.legacy_sweep = { first_full_at: new Date().toISOString() };
      const deletes: ShadowPath[] = [], imports: ShadowPath[] = [], inFlight: ShadowPath[] = [], mismatch: ShadowPath[] = [], owed: ShadowPath[] = [];
      lastMismatch = mismatch;
      for (const entry of level.paths) {
        const r = entry.result;
        if (r.settled) continue;
        if (r.inFlight) { inFlight.push(entry); continue; }
        if (S.has(settledKey(entry.path, entry.state.level))) {
          // A hold this pass wrote or re-screened at L is that path's fate here, even when its code re-screens every pass.
          if (entry.state.hold?.atLevel) continue;
          // Design §3.1: admitted at most once more per (path, level) in this pass, then counted as a settle mismatch.
          const again = settledKey(entry.path, entry.state.level);
          if (readmitted.has(again)) { mismatch.push(entry); continue; }
          readmitted.add(again);
        }
        if (r.action === 'delete') {
          if (admission !== 'normal') { S.set(settledKey(entry.path, entry.state.level), 'paused_deletes'); counts.pausedDeletes++; continue; }
          deletes.push(entry);
        } else if (r.action === 'import' || r.action === 'reparse' || r.cls === 'drift' || r.cls === 'dirty') imports.push(entry);
        else owed.push(entry);
      }
      const candidates = deletes.length + imports.length;
      if (round === 1) candidatesFirst = candidates + inFlight.length + owed.length;
      value.telemetry.candidates = candidatesFirst;
      value.telemetry.remaining = candidates + inFlight.length + owed.length + mismatch.length;
      if (admission === 'classify_only') { await save('resumable', 'admission_paused'); return result('partial', 'admission_paused'); }
      if (!candidates && inFlight.length && waits < IN_FLIGHT_WAITS) {
        waits++; round--;
        await awaitInFlight(engine, level, inFlight, opts.drainStartedAt ? 30_000 : 5_000, assertActive);
        continue;
      }
      if (!candidates && inFlight.length) { await save('resumable', 'writer_pending'); return result('partial', 'writer_pending'); }
      if (!candidates) {
        if (mismatch.length || owed.length) break;
        if (remote) { await save('blocked', 'reconcile_host_required'); return result('blocked_by_failures', 'reconcile_host_required'); }
        if (round === 1 && configured && context.source.last_commit === head && !episode && !retry.length && !tail) {
          // v3 §3.3: a pass that finds nothing at last_commit = T admits no checkpoint; it keeps master's up_to_date (only
          // last_sync_at), and its full round refreshes the converged watermark so the next tick can be idle.
          const at = new Date().toISOString();
          await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
            assertActive();
            await assertDrainLease(tx, sourceId);
            await tx.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1 AND incarnation=$2::uuid', [sourceId, incarnation]);
            const watermark = await readConvergedWatermark(tx, { worktreeId: context.binding.worktree_id, sourceId, incarnation }, null, OPEN_AT_STAMP_CAP);
            value.obligations.converged = { target: head, at, ...watermark, parser_fp: parserFp, pack, selection_fp: selectionFp,
              last_full_at: kind === 'full' || !converged ? at : converged.last_full_at, passes_since_full: kind === 'full' || !converged ? 0 : converged.passes_since_full + 1 };
            Object.assign(value.obligations, { not_converged_streak: 0, mismatch: {}, stuck_since: null });
            value.telemetry = { ...value.telemetry, outcome: 'up_to_date', ended_at: at, remaining: 0, duration_ms: Date.now() - started, counts: { ...counts, ...passApplyCounts(applied) } };
            await writePassRow(tx, value);
          }, principalAttribution(authority.writer.principal)));
          rememberLevel();
          await clearPassFailures(engine, sourceId, incarnation);
          await finishPassApply(engine, sourceId, applied);
          return { ...result('up_to_date'), fromCommit: remote ? null : head };
        }
        // Design §6: an open episode closes by inclusion (a) or at the configured selection (b); chunker_version only by (b) over U_config.
        const closure = episode ? await passEpisodeClosure({ gitRoot: context.gitRoot, root: context.root, head, slugMode: levelSlugMode, episode, pass: selection, configured,
          configuredSelection: await passSelection(engine, { sourceId } as SyncOpts, context, mode) }) : null;
        const closesEpisode = closure?.closes === true;
        if (closure?.released) counts.episodeReleased = closure.released;
        const stamp: PassStamp = { leaseToken: lease.token, incarnation, configured, stampChunker: configured && (context.source.last_commit === null || (closesEpisode && !!episode?.full_id && closure!.stampChunker)),
          closesEpisode, retryTaken: [...retry], releasedHolds: [], selectionFp, parserFp, pack, full: kind === 'full',
          changed: counts.added + counts.modified + counts.deleted + counts.renamed, extract: !processingOptions.noExtract };
        await save('open', null);
        const stopped = await drain([], stamp);
        if (stopped) return stop(stopped);
        value.telemetry = { ...value.telemetry, outcome: 'synced', stop_reason: configured ? null : 'selection_scoped', remaining: 0 };
        rememberLevel();
        await clearPassFailures(engine, sourceId, incarnation);
        await finishPassApply(engine, sourceId, applied);
        return result(configured && context.source.last_commit === null ? 'first_sync' : 'synced', configured ? undefined : 'selection_scoped');
      }
      const built = await batchEntries(engine, level, deletes, imports);
      collisions.push(...built.collisions);
      for (const entry of [...built.skipped, ...built.collisions.flatMap(c => c.skipped.map(sourcePath => imports.find(i => entryPaths(level, i.path).sourcePath === sourcePath)!))].filter(Boolean)) {
        S.set(settledKey(entry.path, entry.state.level), 'collision'); counts.collisions++;
      }
      if (optOutEpisode && !value.obligations.episode && built.entries.length) value.obligations.episode = episode = optOutEpisode;
      for (let i = 0; i < built.entries.length; i += PASS_BATCH_MAX) {
        const chunk = built.entries.slice(i, i + PASS_BATCH_MAX);
        const stopped = await drain(chunk);
        if (stopped) return stop(stopped);
        value.telemetry.remaining = Math.max(0, built.entries.length - i - chunk.length) + inFlight.length + owed.length + mismatch.length;
        // Design §7 (v3 §7): crossing the approved envelope defers embeddings for the rest of the pass.
        const envelope = value.obligations.cost;
        if (envelope) {
          envelope.reserved_usd = (await readReservedUsd(engine, sourceId, incarnation, costScope)).usd;
          if (!processingOptions.noEmbed && envelope.approved_usd !== null && envelope.reserved_usd > 0 && envelope.reserved_usd >= envelope.approved_usd) { processingOptions.noEmbed = true; counts.costDeferred = 1; }
        }
        await save('open', null);
      }
      // Every candidate of the round settled: committed, waived, held, deferred to a hold, a collision, or (a rename's
      // deletion) carried by its import.
      for (const entry of [...deletes, ...imports]) S.set(settledKey(entry.path, entry.state.level), 'settled');
      lastMismatch = [];
    }
    // Not converged (design §3.1): four rounds, or a settle mismatch or a path this release cannot settle.
    // A path settled in this pass that does not classify settled is a settle mismatch: counted per (path, level) across
    // passes; lane B turns a streak of SETTLE_MISMATCH_STREAK into a settle_mismatch hold.
    const before = value.obligations.mismatch;
    value.obligations.mismatch = Object.fromEntries(lastMismatch.map(entry => {
      const seen = before[entry.path];
      return [entry.path, { level: entry.state.level, streak: seen && seen.level === entry.state.level ? seen.streak + 1 : 1 }];
    }));
    value.obligations.not_converged_streak = (value.obligations.not_converged_streak ?? 0) + 1;
    await finishPassApply(engine, sourceId, applied);
    await save('resumable', 'not_converged');
    return result('partial', 'not_converged');
  } catch (error) {
    if (error instanceof SyncAdmissionPaused) { await save('resumable', 'admission_paused').catch(() => undefined); return result('partial', 'admission_paused'); }
    if (input.signal?.aborted && error instanceof Error && error.name === 'AbortError') { await save('resumable', 'timeout').catch(() => undefined); return result('partial', 'timeout'); }
    throw error;
  } finally {
    unregisterPassCost(passId);
  }
}

/** A converged or idle pass clears what earlier stops recorded: the pass row's failure key and the incarnation's cursor key. */
async function clearPassFailures(engine: BrainEngine, sourceId: string, incarnation: string): Promise<void> {
  await clearManagedSyncFailureAfterSuccess(engine, passFingerprint(sourceId, incarnation));
  await clearManagedSyncFailureAfterSuccess(engine, managedCursorKey(incarnation, undefined));
}

export type { SyncAdmission };
