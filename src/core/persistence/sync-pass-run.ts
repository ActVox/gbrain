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
import { opError } from '../ops/contract.ts';
import { confirmedSyncDelta } from '../sync-rename-identity.ts';
import type { DowngradedRename } from '../sync.ts';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import type { Cursor, RetryWait } from './sync-run.ts';
import { getWriteRequestById } from './journal.ts';
import type { WriteRequest } from './model.ts';
import { managedSyncWriteDiagnostic } from './sync-write-diagnostic.ts';
import { recordedStop, replaysUnchangedRefusal } from './sync-stop-class.ts';
import { adoptLegacyPage, syncExcludePatterns, syncGit, type LegacyIdentity, type ManagedSyncContext, type SyncDiscovery, type SyncEntry, type SyncSlugCollision } from './sync-discovery.ts';
import { assertSyncDispatchActive, type SyncAuthority, type SyncProcessingOptions } from './sync-authority.ts';
import type { PassStamp, SyncCursorOptions, SyncIntent } from './sync-prepare.ts';
import { OPEN_AT_STAMP_CAP, passFingerprint, readPassRow, SYNC_ORIGIN_DELETED_OP, writePassRow, type ManagedSyncPassValue, type PassEpisode,
  type PassKind, type PassOutcome, type SyncSelection } from './sync-pass-row.ts';
import { readSyncAdmission, type SyncAdmission } from './sync-admission.ts';
import { passIdleProbe, readShadowLevel, workingIdleChange, type ShadowLevel, type ShadowPath } from './sync-pass.ts';
import { recallWorkingStatCache, rememberWorkingStatCache, SyncTreeReadIncomplete } from './sync-git-stream.ts';
import { syncPassKind } from './sync-classify.ts';
import { PASS_BATCH_KEY_PREFIX, readConvergedWatermark, SyncAdmissionPaused, type PassEntry } from './sync-pass-batch.ts';
import { assertDrainLease, currentDrainLease } from './sync-lease.ts';
import { digest } from './digest.ts';
import { readSyncTail } from './sync-tail-record.ts';
import { clearGitHold, holdRescreenDue, readGitHoldRetryPaths, readSyncHoldPolicy, readGitSourceHolds, readSyncImportProvenances, syncImportParserFor } from './sync-holds.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { loadConfig } from '../config.ts';
import { startPersistenceConsumer } from './service.ts';
import { clearManagedSyncFailureAfterSuccess } from './sync-failures.ts';
import { managedCursorKey, resolveManagedCursor, retireManagedCursor, retireOrphanSliceRecords } from './sync-cursor-key.ts';
import { withCoordinatedWrite } from './context.ts';
import { pipelined } from '../page-state/transactions.ts';
import { principalAttribution } from './attribution.ts';
import { isCodeFilePath, resolveSlugForPath } from '../sync.ts';
import { syncOriginPath } from './sync-origin.ts';
import { originMarkerFingerprint } from './sync-markers.ts';
import { SYNC_SLICE_OP } from './sync-slices.ts';
import { passResumeArgs } from './sync-pass-readers.ts';
import { applyPassRound, finishPassApply, newPassApplyState, passApplyCounts, remoteReconcile } from './sync-pass-apply.ts';
import { passCostDecision, passEpisodeClosure, readReservedUsd, registerPassCost, unregisterPassCost } from './sync-pass-episode.ts';
import { currentEmbeddingPricePerMTok } from '../embedding.ts';
import { massReconcileAllowed } from '../sync-reconcile.ts';

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
  /** A round's level read starts at `target` (the HEAD it was pinned or last read at): a failure until its first batch is that read's. */
  onLevelRead: (target: string) => void;
}

/** The configured patterns a selection unions with its flags: read once, beside the pin's other reads. */
function selectionPatterns(engine: BrainEngine, opts: SyncOpts): Promise<[Iterable<string>, string | null]> {
  return Promise.all([syncExcludePatterns(engine, opts.exclude), engine.getConfig('sync.include_hidden')]);
}
/** The selection a pass syncs (design §6), with the configured one's test: no selection flag differs from the source's configuration. */
function passSelection([excluded, hidden]: [Iterable<string>, string | null], opts: SyncOpts, context: ManagedSyncContext, mode: SyncSelection['mode']): SyncSelection {
  const exclude = [...excluded].sort();
  const includeHidden = [...new Set([...opts.includeHidden ?? [], ...(hidden ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)]
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
  const readHeader = (key: string) => engine.executeRaw<{ slices: boolean; header: { runId?: string; done?: boolean; processingOptions?: SyncProcessingOptions; syncOptions?: SyncCursorOptions & { exclude?: string[]; includeHidden?: string[]; strategy?: string; srcSubpath?: string; workingTree?: boolean } } | null }>(
    `SELECT (SELECT completed_keys->0 FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1) AS header,
      EXISTS (SELECT 1 FROM op_checkpoints WHERE op=$2 AND left(fingerprint, length($3))=$3) AS slices`, [key, SYNC_SLICE_OP, `${input.sourceId}:${input.incarnation}:`]);
  // #6712 PR 4b: the canonical key's header is read beside the resolution (the key it picks unless it adopts an older one;
  // the resolution never writes the key it picks), and read again only for an adopted key.
  const canonical = managedCursorKey(input.incarnation, undefined), speculative = readHeader(canonical);
  speculative.catch(() => undefined);
  const resolution = await resolveManagedCursor(engine, { sourceId: input.sourceId, incarnation: input.incarnation, company: undefined, assertActive: input.assertActive, foldIn: !input.remote });
  if (resolution.waitFor) return { wait: { ...resolution.waitFor, retry_after_ms: 5000 } };
  const [row] = await (resolution.key === canonical ? speculative : readHeader(resolution.key));
  const header = row?.header;
  if (!header) {
    if (row?.slices && !input.remote) await retireOrphanSliceRecords(engine, input.sourceId, input.incarnation);
    return {};
  }
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
  Promise<{ entries: PassEntry[]; collisions: SyncSlugCollision[]; skipped: ShadowPath[]; downgrades: DowngradedRename[] }> {
  const working = (entry: ShadowPath) => level.mode === 'working' && entry.state.level !== entry.state.tree;
  const deleteEntries = new Map<string, PassEntry>(deletes.map(entry => [entry.path, { ...entryPaths(level, entry.path), action: 'delete' as const, working: level.mode === 'working',
    slug: entry.slug!, pageId: entry.pageId, revision: entry.revision, level: null }]));
  const leaving = new Map(deletes.map(entry => [entry.path, entry]));
  const fresh = imports.filter(entry => !entry.state.page);
  const slugOf = new Map(fresh.map(entry => [entry.path, resolveSlugForPath(entryPaths(level, entry.path).sourcePath)]));
  // #6727, as discovery does: a new origin with no live page at its slug takes the one legacy page (no recorded origin)
  // that folds to it; several, or one the importer cannot write, keep the slug and the freeze holds legacy_slug_conflict.
  const legacySlugs = new Map<string, Pick<SyncEntry, 'legacySlugs' | 'legacyIdVeto'>>();
  const adopting = fresh.filter(entry => slugOf.get(entry.path) && !isCodeFilePath(entryPaths(level, entry.path).sourcePath));
  if (adopting.length) {
    const identities = await engine.executeRaw<LegacyIdentity>("SELECT id, slug, source_path, deleted_at, frontmatter->>'id' AS fm_id FROM pages WHERE source_id=$1 AND (source_path IS NULL OR slug=ANY($2::text[]))",
      [level.sourceId, [...new Set(adopting.map(entry => slugOf.get(entry.path)!))]]);
    const bySlug = new Map(identities.map(page => [page.slug, page]));
    const discovery = { root: level.root, gitRoot: level.gitRoot, target: level.head, sourceId: level.sourceId } as SyncDiscovery;
    for (const entry of adopting) {
      const named: SyncEntry = { ...entryPaths(level, entry.path), action: 'import', working: working(entry) };
      slugOf.set(entry.path, await adoptLegacyPage(engine, discovery, identities, bySlug.get(slugOf.get(entry.path)!), slugOf.get(entry.path)!, named));
      if (named.legacySlugs) legacySlugs.set(entry.path, { legacySlugs: named.legacySlugs, ...(named.legacyIdVeto ? { legacyIdVeto: true as const } : {}) });
    }
  }
  const slugs = [...new Set([...slugOf.values()].filter(Boolean))];
  const holders = new Map((slugs.length ? await engine.executeRaw<{ id: number | string; slug: string; source_path: string | null; revision: string; deleted: boolean }>(
    'SELECT id, slug, source_path, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])', [level.sourceId, slugs]) : [])
    .map(page => [page.slug, page]));
  const gitPathOfOrigin = (origin: string) => level.slugMode === 'source-root' && level.scope ? `${level.scope}/${syncOriginPath(origin)}` : syncOriginPath(origin);
  // #6887: a both-moved import imports when the page still holds what its recorded disk blob imports (sync-screen.ts driftBaselineContent).
  const bothDrift = imports.filter(entry => entry.result.cls === 'drift' && entry.result.side === 'both' && entry.pageId !== null);
  const baselineRecords = await readSyncImportProvenances(engine, level.sourceId, level.incarnation, bothDrift.map(entry => entry.pageId!));
  const driftBaseline = (entry: ShadowPath) => entry.result.side === 'both' && entry.pageId !== null ? baselineRecords.get(entry.pageId)?.disk_blob_oid ?? undefined : undefined;
  const entries: PassEntry[] = [], collisions: SyncSlugCollision[] = [], skipped: ShadowPath[] = [];
  const claims = new Map<string, ShadowPath[]>();
  for (const entry of imports) {
    const paths = entryPaths(level, entry.path);
    const base = { ...paths, action: 'import' as const, working: working(entry), level: entry.state.level, ...(entry.result.cls === 'drift' && entry.result.side && entry.result.side !== 'deleted' ? { drift: entry.result.side, ...(driftBaseline(entry) ? { driftBaseline: driftBaseline(entry) } : {}) } : {}) };
    if (entry.state.page) { entries.push({ ...base, slug: entry.slug!, pageId: entry.pageId, revision: entry.revision }); continue; }
    const slug = slugOf.get(entry.path);
    if (!slug) { skipped.push(entry); continue; }
    claims.set(slug, [...claims.get(slug) ?? [], entry]);
  }
  const renamed = new Set<string>();
  let renames: Promise<Map<string, string> | null> | null = null;
  const downgrades: DowngradedRename[] = [];
  const gitRenames = () => renames ??= (async () => {
    if (level.mode !== 'committed' || !level.baselineCommit || level.baselineCommit === level.head || (!deleteEntries.size && !level.heldRenames.length)) return null;
    const delta = await confirmedSyncDelta(engine, level.gitRoot, level.baselineCommit, level.head, { sourceId: level.sourceId, sourcePathOf: path => entryPaths(level, path).sourcePath });
    if (delta.status !== 'ok') return null;
    // #6729: the inexact renames whose identity was not kept are reported (and recorded) as discovery reported them.
    downgrades.push(...(delta.manifest.downgradedRenames ?? []).map(pair => ({ ...pair, from: entryPaths(level, pair.from).sourcePath, to: entryPaths(level, pair.to).sourcePath })));
    return new Map(delta.manifest.renamed.map(pair => [pair.to, pair.from]));
  })();
  for (const [slug, claimants] of claims) {
    const holder = holders.get(slug);
    const holderPath = holder?.source_path ? gitPathOfOrigin(holder.source_path) : null;
    const kept = holder && !holder.deleted && holderPath !== null && !leaving.has(holderPath) ? holderPath : null;
    const winner = kept === null ? claimants.find(entry => /\.mdx?$/i.test(entry.path) && entryPaths(level, entry.path).sourcePath.replace(/\.mdx?$/i, '') === slug) ?? claimants[0]! : null;
    const losers = claimants.filter(entry => entry !== winner);
    if (losers.length) collisions.push({ slug, kept: kept ?? entryPaths(level, winner!.path).sourcePath, skipped: losers.map(entry => entryPaths(level, entry.path).sourcePath) });
    if (!winner) continue;
    const paths = entryPaths(level, winner.path);
    const base = { ...paths, action: 'import' as const, working: working(winner), level: winner.state.level, slug, ...legacySlugs.get(winner.path) };
    if (holder) {
      // A live page at the slug with no recorded origin (written straight to the database, or by an older gbrain) attests
      // neither side: the import is guarded as drift of unknown side, so the freeze imports it only as a proven no-op and
      // otherwise holds file_drift (as discovery's tree walk guards it, sync-prescreen.ts).
      entries.push({ ...base, pageId: Number(holder.id), revision: holder.revision,
        ...(holder.source_path !== null ? { renameFrom: { sourcePath: holder.source_path, slug, pageId: Number(holder.id), revision: holder.revision } } : {}),
        ...(holder.source_path === null && !holder.deleted ? { drift: 'unknown' as const } : {}) });
      if (holderPath !== null && deleteEntries.delete(holderPath)) renamed.add(holderPath);
      continue;
    }
    // #5988: a held rename destination still owes its page the move: re-bound while the origin page is unchanged, else held rename_held.
    // A held destination renamed again (a Git rename of the held path) carries the held identity on.
    const heldAt = (path: string | undefined) => path === undefined ? undefined : level.heldRenames.find(row => row.path === path)?.rename;
    const held = heldAt(winner.path) ?? (level.heldRenames.length ? heldAt((await gitRenames())?.get(winner.path)) : undefined);
    const origin = held ? (await engine.executeRaw<{ source_path: string | null; revision: string; deleted: boolean }>(
      'SELECT source_path, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND id=$2', [level.sourceId, held.pageId]))[0] : undefined;
    if (held && origin && !origin.deleted && origin.source_path !== null && syncOriginPath(origin.source_path) === syncOriginPath(held.sourcePath)) {
      entries.push({ ...base, pageId: null, revision: null, ...(origin.revision === held.revision ? { renameFrom: held } : { renameHeld: held }) });
      continue;
    }
    const moved = [...leaving.values()].filter(gone => deleteEntries.has(gone.path) && !renamed.has(gone.path) && gone.state.record?.blobOids.includes(winner.state.level ?? ''));
    const twins = fresh.filter(other => other.state.level === winner.state.level);
    // #6729: a Git rename with an edit keeps its page when Git pairs it and the identity is confirmed, as discovery's delta does.
    const inexact = moved.length === 1 && twins.length === 1 ? null : (await gitRenames())?.get(winner.path);
    const gitMoved = inexact && deleteEntries.has(inexact) && !renamed.has(inexact) ? leaving.get(inexact) : undefined;
    if (gitMoved?.pageId != null || (moved.length === 1 && twins.length === 1)) {
      const gone = gitMoved ?? moved[0]!;
      const origin = entryPaths(level, gone.path).sourcePath;
      entries.push({ ...base, pageId: null, revision: null, renameFrom: { sourcePath: origin, slug: gone.slug!, pageId: gone.pageId!, revision: gone.revision! } });
      deleteEntries.delete(gone.path); renamed.add(gone.path);
      continue;
    }
    entries.push({ ...base, pageId: null, revision: null });
  }
  return { entries: [...deleteEntries.values(), ...entries.sort((a, b) => a.path.localeCompare(b.path))], collisions, skipped, downgrades };
}

/**
 * Waits (bounded) until no open request or Git effect of the worktree names one of the in-flight pages or origins, and
 * returns what the requests open at its start committed meanwhile: an earlier drain's work this pass reports as its own.
 */
async function awaitInFlight(engine: BrainEngine, level: ShadowLevel, inFlight: ShadowPath[], budgetMs: number, assertActive: () => void): Promise<{ added: number; modified: number; deleted: number; renamed: number }> {
  const pageIds = inFlight.flatMap(entry => entry.pageId === null ? [] : [entry.pageId]);
  const origins = inFlight.map(entry => entryPaths(level, entry.path).sourcePath);
  const names = `r.page_id=ANY($2::int[]) OR r.intent->>'sourcePath'=ANY($3::text[])`;
  const opened = await engine.executeRaw<{ id: string }>(`SELECT r.id FROM persistence_requests r WHERE r.source_id=$1 AND r.state IN ('queued','running','recovering') AND (${names})`,
    [level.sourceId, pageIds, origins]);
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    const [open] = await engine.executeRaw(`SELECT 1 FROM persistence_requests r WHERE r.source_id=$1 AND (r.state IN ('queued','running','recovering')
        OR EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.state IN ('queued','running')))
      AND (${names}) LIMIT 1`, [level.sourceId, pageIds, origins]);
    assertActive();
    if (!open) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const credited = { added: 0, modified: 0, deleted: 0, renamed: 0 };
  if (!opened.length) return credited;
  const created = new Set(inFlight.filter(entry => entry.pageId === null).map(entry => entryPaths(level, entry.path).sourcePath));
  const committed = await engine.executeRaw<{ kind: string | null; source_path: string | null; renamed: boolean }>(`SELECT intent->>'kind' AS kind, intent->>'sourcePath' AS source_path,
    intent ? 'renameFrom' AS renamed FROM persistence_requests WHERE id=ANY($1::uuid[]) AND state='committed'`, [opened.map(row => row.id)]);
  for (const row of committed) {
    if (row.kind === 'managed_sync_delete') credited.deleted++;
    else if (row.kind !== 'managed_sync_import') continue;
    else if (row.renamed) credited.renamed++;
    else if (row.source_path !== null && created.has(row.source_path)) credited.added++;
    else credited.modified++;
  }
  return credited;
}

/** The oldest open request naming one of the in-flight pages or origins. */
async function openInFlightRequest(engine: BrainEngine, level: ShadowLevel, inFlight: ShadowPath[]): Promise<WriteRequest | null> {
  const [row] = await engine.executeRaw<{ id: string }>(`SELECT r.id FROM persistence_requests r WHERE r.source_id=$1 AND r.state IN ('queued','running','recovering')
    AND (r.page_id=ANY($2::int[]) OR r.intent->>'sourcePath'=ANY($3::text[])) ORDER BY r.sequence LIMIT 1`,
  [level.sourceId, inFlight.flatMap(entry => entry.pageId === null ? [] : [entry.pageId]), inFlight.map(entry => entryPaths(level, entry.path).sourcePath)]);
  return row ? getWriteRequestById(engine, row.id) : null;
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
  lease.tailClear = false;
  const started = Date.now(), startedAt = new Date(started).toISOString();
  // Pin (design §2.2): the row, sync.admission, HEAD and the mode. The reads the kind needs ride the same round trip: the
  // selection's patterns, the schema pack, the tail, the retry row, the source's holds and the idle probe (which reads the
  // row's watermark and open ids itself). #6712 PR 4b: the legacy cursors' retirement runs beside them; it writes none of
  // what they read, and its outcome is still decided first.
  const pin = Promise.all([readPassRow(engine, sourceId, incarnation),
    readSyncAdmission(engine), engine.getConfig('sync.include_working_tree'), selectionPatterns(engine, opts),
    input.processingOptions.noSchemaPack ? null : loadActivePackForEngine(engine, { remote: false, sourceId }).catch(() => null),
    readSyncTail(engine, sourceId), readGitHoldRetryPaths(engine, sourceId, incarnation), readGitSourceHolds(engine, { sourceIds: [sourceId] }),
    passIdleProbe(engine, { sourceId, incarnation, worktreeId: context.binding.worktree_id, requestHwm: null, openAtStamp: null }),
    engine.executeRaw(`SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=ANY($1::text[]) LIMIT 1`, [passFailureKeys(sourceId, incarnation)])] as const);
  pin.catch(() => undefined);
  const handover = await retireLegacyCursors(engine, { sourceId, incarnation, remote, assertActive });
  const empty = (status: SyncResult['status'], reason?: SyncResult['reason']): SyncResult => ({ status, fromCommit: remote ? null : context.source.last_commit, toCommit: remote ? '' : context.source.last_commit ?? '',
    added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], filesImported: 0, bankedFiles: 0, ...(reason ? { reason } : {}) });
  if (handover.wait) return { ...empty('partial', 'writer_pending'), ...(remote ? {} : { retryWait: handover.wait }) };
  if (handover.hostRequired) return empty('blocked_by_failures', 'reconcile_host_required');
  const [prior, admission, configuredWorking, patterns, loadedPack, tail, retry, sourceHolds, rowProbe, failed] = await pin;
  assertActive();
  const [headLine, refLine] = syncGit(context.gitRoot, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']).split('\n');
  let head = headLine!.trim();
  const detached = refLine?.trim() === 'HEAD';
  const mode: SyncSelection['mode'] = detached || (opts.workingTree ?? configuredWorking === 'true') ? 'working' : 'committed';
  const selection = passSelection(patterns, opts, context, mode);
  const configured = !remote && !opts.exclude?.length && !opts.includeHidden?.length && opts.srcSubpath === undefined
    && (opts.strategy === undefined || opts.strategy === ((context.source.config?.strategy as string | undefined) ?? 'markdown'))
    && (detached || opts.workingTree === undefined || opts.workingTree === (configuredWorking === 'true'));
  const selectionFp = digest(selection), parserFp = parserFingerprint();
  const obligations: ManagedSyncPassValue['obligations'] = prior ? structuredClone(prior.value.obligations)
    : { baseline_commit: context.source.last_commit, mismatch: {}, not_converged_streak: 0, faults: {} };
  obligations.mismatch ??= {}; obligations.faults ??= {}; obligations.not_converged_streak ??= 0;
  if (handover.episode && !obligations.episode) obligations.episode = handover.episode;
  const passId = randomUUID();
  // #6696: a cost-gate deferral rides as noEmbed but is this run's constraint (its requests carry embedDeferred), never an opt-out an episode keeps.
  const requested = opts.embedDeferred ? { ...input.processingOptions, noEmbed: false } : input.processingOptions;
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
  const pack = processingOptions.noSchemaPack ? null : loadedPack?.identity ?? null;

  // The kind (design §2.2), from the real converged state.
  const converged = obligations.converged;
  const probe = converged ? rowProbe : null;
  const holds = (sourceHolds[0]?.holds ?? []).filter(hold => hold.incarnation === incarnation);
  // Working mode (design §2.2): the stat cache this process kept from the round its last stamp used; a cold process has none.
  const cacheKey = passFingerprint(sourceId, incarnation);
  const kindStarted = Date.now();
  const working = mode === 'working' && converged ? await workingIdleChange(context, recallWorkingStatCache(cacheKey)) : { changed: mode === 'working', cache: null };
  const kindOf = syncPassKind({ converged: converged ? { target: converged.target, parserFp: converged.parser_fp, pack: converged.pack, selectionFp: converged.selection_fp,
      passesSinceFull: converged.passes_since_full, lastFullAt: Date.parse(converged.last_full_at) } : null,
    head, parserFp, pack, selectionFp, now: started, openEpisode: !!episode, owedTail: tail !== null, retryRow: retry.length > 0,
    notConvergedStreak: obligations.not_converged_streak, mismatchStreak: Object.keys(obligations.mismatch).length,
    requestNewer: probe?.newer === true, openAtStampFinished: !!converged && (converged.open_at_stamp === null || (probe?.stillOpen ?? 0) < converged.open_at_stamp.length),
    workingChange: working.changed, rescreenDueHold: holds.some(hold => holdRescreenDue(hold, retry.includes(hold.path))), full: opts.full === true });
  // Design §2.6: a withheld mass delete is applied by a full round once the owner host's env valve allows it.
  const valveOpen = !remote && !!obligations.deletes_withheld && massReconcileAllowed();
  // Design §4: keep_db writes the previous pass's cap deferred (`keep_db_pending`) are owed to this pass, so it is not idle.
  const keepDbOwed = !remote && admission === 'normal' && (prior?.value.telemetry.classes?.keep_db_pending?.count ?? 0) > 0;
  const kind: PassKind = admission === 'classify_only' && kindOf.kind === 'idle' ? 'idle' : (valveOpen || keepDbOwed) && kindOf.kind === 'idle' ? 'full' : kindOf.kind;
  const value: ManagedSyncPassValue = { source_id: sourceId, incarnation, lease_token: lease.token, obligations,
    telemetry: { pass_id: passId, target: head, started_at: startedAt, ended_at: null, kind, round: 0, outcome: 'open', stop_reason: null, candidates: 0, settled: 0, remaining: 0,
      counts: {}, duration_ms: null, timings_ms: {} } };
  // The incarnation's legacy markers (§2.7 b1) are owed until a local pass wrote them, not only by its first row.
  const markersOwed = () => remote ? !prior : !value.obligations.legacy_markers_at;

  if (kind === 'idle' && working.cache) rememberWorkingStatCache(cacheKey, working.cache);
  if (kind === 'idle') {
    // Master's up_to_date (a complete check that found nothing): only last_sync_at, plus the pass row's count.
    const at = new Date().toISOString();
    value.obligations.converged = { ...converged!, passes_since_full: converged!.passes_since_full + 1 };
    value.obligations.stuck_since = null;
    // Design §7: an owner approval (--yes) on an idle tick still makes an unknown cost known again.
    if (opts.costApproved && value.obligations.cost?.approved_usd === null) value.obligations.cost = (await passCostDecision(engine, { sourceId, incarnation,
      scope: episode?.full_id ?? passId, priorRow: true, prior: value.obligations.cost, approved: true })).cost;
    value.telemetry = { ...value.telemetry, outcome: 'up_to_date', ended_at: at, duration_ms: Date.now() - started, timings_ms: { setup: kindStarted - started, kind: Date.now() - kindStarted } };
    await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
      assertActive();
      // One round trip: the lease check, the stamp and the row (started at the transaction's clock) are pipelined; a lost
      // lease rolls the other two back.
      await pipelined(tx, [() => assertDrainLease(tx, sourceId), () => tx.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1 AND incarnation=$2::uuid', [sourceId, incarnation]),
        () => writePassRow(tx, value, { pin: true, clock: true })]);
    }, principalAttribution(authority.writer.principal)));
    // A failure is recorded only under the lease this pass holds, so none recorded at pin means none to clear.
    if (failed.length) await clearPassFailures(engine, sourceId, incarnation);
    // Nor can a tail be owed since the pin read none: the lease's holder reads none after it (sync-run.ts).
    lease.tailClear = !tail;
    return { ...empty('up_to_date'), toCommit: remote ? '' : head, ...(inherited.length ? { inherited_options: inherited } : {}) };
  }
  // Design §7: the cost decision at pin; an unknown or spent envelope defers embeddings for this pass (never inherited).
  const costScope = episode?.full_id ?? passId;
  const costDecision = await passCostDecision(engine, { sourceId, incarnation, scope: costScope, priorRow: !!prior, prior: obligations.cost, approved: opts.costApproved === true });
  obligations.cost = costDecision.cost;
  let costDeferred: string | null = null;
  if (costDecision.defer && !processingOptions.noEmbed) { processingOptions.noEmbed = true; costDeferred = costDecision.defer; }

  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, chunks: 0, waivedImports: 0, waivedDeletes: 0, held: 0, pausedDeletes: 0, collisions: 0, episodeReleased: 0, costDeferred: costDeferred ? 1 : 0,
    skippedContextualMode: 0, skippedCanonicalBytes: 0 };
  const collisions: SyncSlugCollision[] = [];
  const S = new Map<string, string>();
  const settledKey = (path: string, level: string | null) => `${path}\0${level ?? ''}`;
  // The entries this round's batches settled before the round folds its candidates into S: a slice that stops mid-round
  // reports them (yieldSettled); a blocked stop reports S as it replays.
  let roundSettled = 0, yieldSettled = 0;
  const retryConsumed = new Set<string>(retry);
  const sliceBase = { started: performance.now(), pages: 0 };
  let batchNo = 0, waits = 0, candidatesFirst = 0;
  let lastMismatch: ShadowPath[] = [];
  let lastLevel: ShadowLevel | null = null;
  const rememberLevel = () => { if (lastLevel?.workingCache) rememberWorkingStatCache(cacheKey, lastLevel.workingCache); };
  const applied = newPassApplyState();
  const readmitted = new Set<string>();
  // #5751: a waiver records no provenance for these, so the path still classifies unsettled; its fate at this level is the waiver.
  const legacyWaived = new Set<string>();

  const save = async (outcome: PassOutcome, stopReason: string | null, pin = false) => {
    const ended = outcome !== 'open';
    value.telemetry = { ...value.telemetry, outcome, stop_reason: stopReason, settled: S.size + yieldSettled, counts: { ...counts, ...passApplyCounts(applied) },
      classes: applied.classes, ...(applied.summary ? { summary: applied.summary } : {}),
      ...(ended ? { ended_at: new Date().toISOString(), duration_ms: Date.now() - started } : {}) };
    if (outcome === 'blocked' || stopReason === 'not_converged') value.obligations.stuck_since ??= new Date().toISOString();
    await engine.transaction(async tx => { await assertDrainLease(tx, sourceId); await writePassRow(tx, value, { pin }); });
  };
  const identityDowngrades: DowngradedRename[] = [];
  const result = (status: SyncResult['status'], reason?: SyncResult['reason']): SyncResult => ({ status, fromCommit: remote ? null : context.source.last_commit, toCommit: remote ? '' : head,
    added: counts.added, modified: counts.modified, deleted: counts.deleted, renamed: counts.renamed, chunksCreated: counts.chunks, embedded: 0, pagesAffected: [],
    filesImported: sliceBase.pages, bankedFiles: sliceBase.pages, waived: { imports: counts.waivedImports, deletes: counts.waivedDeletes }, prescreened: 0,
    ...(counts.skippedContextualMode || counts.skippedCanonicalBytes ? { legacySkips: { contextualMode: counts.skippedContextualMode, canonicalBytes: counts.skippedCanonicalBytes } } : {}),
    ...(collisions.length ? { slugCollisions: collisions } : {}), ...(identityDowngrades.length ? { identityDowngrades } : {}), ...(inherited.length ? { inherited_options: inherited } : {}), ...(reason ? { reason } : {}),
    pass: { pass_id: passId, kind, round: value.telemetry.round, outcome: value.telemetry.outcome, stop_reason: value.telemetry.stop_reason, candidates: candidatesFirst,
      settled: S.size + yieldSettled, remaining: value.telemetry.remaining, not_converged_streak: value.obligations.not_converged_streak } });
  try {
    await engine.transaction(async tx => {
      // The lease check and the clock read share a round trip: a lost lease aborts the transaction before the row is written.
      [, value.telemetry.started_at] = await Promise.all([assertDrainLease(tx, sourceId), databaseNow(tx)]);
      await writePassRow(tx, value, { pin: true });
      // An interrupt during the pin rolls the pin back with it: no `open` row is left for a pass that never ran.
      assertActive();
    });
  } catch (error) {
    // A caller abort records the stop on the pass row (the pin it rolled back is replaced); a job abort, a lost lease or a
    // released context leaves no row.
    assertSyncDispatchActive();
    if (input.signal?.aborted && error instanceof Error && error.name === 'AbortError') { await save('resumable', 'timeout', true).catch(() => undefined); return result('partial', 'timeout'); }
    throw error;
  }
  assertActive();
  registerPassCost(passId, { sourceId, incarnation, scope: costScope, pricePerMTok: currentEmbeddingPricePerMTok() });
  /** The batch cursor sync-run.ts drains: the discovery shape with no cursor row behind it. */
  const batchCursor = (entries: PassEntry[], stamp?: PassStamp): Cursor => ({ binding: { ...context.binding, owner_epoch: String(context.binding.owner_epoch), topology_generation: String(context.binding.topology_generation) },
    root: context.root, gitRoot: context.gitRoot, sourceId, incarnation, from: context.source.last_commit, target: head, entries, slugMode: levelSlugMode, discoveredAt: startedAt,
    runId: passId, passId, index: 0, authority, processingOptions, syncOptions: input.syncOptions, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 },
    failureKey: passFingerprint(sourceId, incarnation), resumeArgs: passResumeArgs(sourceId, { value, updated_at: startedAt }), ...(episode?.full_id ? { fullEpisode: episode.full_id } : {}), ...(stamp ? { stamp } : {}) });
  let levelSlugMode: Cursor['slugMode'] = 'git-root';
  /** Drains one batch; a stop is the pass's ending, and `stop` folds that batch's counts in. */
  const drain = async (entries: PassEntry[], stamp?: PassStamp): Promise<SyncResult | null> => {
    const key = `${PASS_BATCH_KEY_PREFIX}${passId}:${batchNo++}`;
    const batch = batchCursor(entries, stamp);
    const drained = await input.drainBatch(key, batch, sliceBase);
    if ('entries' in drained) {
      const c = drained.counts;
      Object.assign(counts, { added: counts.added + c.added, modified: counts.modified + c.modified, deleted: counts.deleted + c.deleted, renamed: counts.renamed + (c.renamed ?? 0),
        chunks: counts.chunks + c.chunks, waivedImports: counts.waivedImports + (c.waived?.imports ?? 0), waivedDeletes: counts.waivedDeletes + (c.waived?.deletes ?? 0), held: counts.held + (c.held ?? 0),
        skippedContextualMode: counts.skippedContextualMode + (c.skippedContextualMode ?? 0), skippedCanonicalBytes: counts.skippedCanonicalBytes + (c.skippedCanonicalBytes ?? 0) });
      for (const index of drained.passLegacyWaived ?? []) legacyWaived.add(settledKey(entries[index]!.path, entries[index]!.level));
      sliceBase.pages += drained.index;
      roundSettled += drained.index;
      return null;
    }
    return drained;
  };
  const stop = async (drained: SyncResult): Promise<SyncResult> => {
    Object.assign(counts, { added: counts.added + drained.added, modified: counts.modified + drained.modified, deleted: counts.deleted + drained.deleted,
      renamed: counts.renamed + drained.renamed, chunks: counts.chunks + drained.chunksCreated, waivedImports: counts.waivedImports + (drained.waived?.imports ?? 0),
      waivedDeletes: counts.waivedDeletes + (drained.waived?.deletes ?? 0), skippedContextualMode: counts.skippedContextualMode + (drained.legacySkips?.contextualMode ?? 0),
      skippedCanonicalBytes: counts.skippedCanonicalBytes + (drained.legacySkips?.canonicalBytes ?? 0) });
    sliceBase.pages += drained.filesImported ?? 0;
    // A slice that stops mid-batch (a writer yield, a deadline, an abort) settled the entries its cursor passed: they count as
    // settled and leave the round's remaining; a blocked stop reports what its replay reports.
    if (drained.status !== 'blocked_by_failures') {
      const passed = drained.managedCursor?.index ?? 0;
      yieldSettled = roundSettled + passed;
      value.telemetry.remaining = Math.max(0, value.telemetry.remaining - passed);
    }
    const outcome: PassOutcome = drained.status === 'blocked_by_failures' ? 'blocked' : 'resumable';
    const blockedOn = drained.managedWrite?.path ? drained.managedWrite.write_request.request_id : null;
    if (outcome === 'blocked' && blockedOn && obligations.blocked?.request_id !== blockedOn) obligations.blocked = { request_id: blockedOn, pass_id: passId };
    await save(outcome, drained.reason ?? (outcome === 'blocked' ? 'blocked_by_failures' : null));
    const { runId: _run, managedCursor: _cursor, ...rest } = drained;
    return { ...rest, ...result(drained.status, drained.reason) };
  };

  try {
    // A page refusal the last pass stopped on replays, with no new request, while what decided it is unchanged (#6712 PR 3, L7).
    // Under the hold policy the next pass re-admits it instead, and its refusal settles as a hold.
    const blocked = obligations.blocked;
    delete obligations.blocked;
    if (blocked && (await readSyncHoldPolicy(engine)).mode === 'fail') {
      const [row] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE source_id=$1 AND request_id=$2', [sourceId, blocked.request_id]);
      const failed = row ? await getWriteRequestById(engine, row.id) : null;
      const intent = failed?.intent as unknown as SyncIntent | null | undefined;
      const recorded = failed && intent && ['failed', 'conflict', 'cancelled'].includes(failed.state) ? await recordedStop(engine, passFingerprint(sourceId, incarnation), blocked.pass_id) : null;
      assertActive();
      if (failed && intent && recorded && replaysUnchangedRefusal(failed, recorded, { root: context.root, intent, target: intent.target ?? '', head: () => head })) {
        obligations.blocked = blocked;
        const replay: Cursor = { ...batchCursor([]), runId: blocked.pass_id, pending: { requestId: failed.request_id, slug: failed.slug, pageId: failed.page_id, intent } };
        const drained = await input.drainBatch(`${PASS_BATCH_KEY_PREFIX}${passId}:${batchNo++}`, replay, sliceBase);
        if (!('entries' in drained)) return await stop(drained);
      }
    }
    for (let round = 1; round <= PASS_MAX_ROUNDS; round++) {
      assertActive();
      value.telemetry.round = round;
      input.onLevelRead(head);
      const level = await readShadowLevel(engine, { sourceId, context, workingTree: mode === 'working',
        pass: { noSchemaPack: processingOptions.noSchemaPack, episodeFullId: episode?.full_id ?? null, retryConsumed: round > 1 ? retryConsumed : undefined, exclude: opts.exclude, includeHidden: opts.includeHidden, strategy: opts.strategy, bootstrap: markersOwed(),
        slugMode: value.obligations.slug_mode } });
      assertActive();
      if (!level) throw new Error(`Source ${sourceId} became a company-brain source during its sync pass.`);
      // Each round reads the level at the current HEAD, and its batches freeze that commit (a commit landing mid-pass is
      // imported by the next round, never frozen from an older pin it is not in).
      head = value.telemetry.target = level.head;
      levelSlugMode = level.slugMode;
      lastLevel = level;
      value.telemetry.timings_ms = level.timings_ms;
      // Design §2.7 (b1): until the incarnation's markers are written (an aborted or failed first pass wrote none), not only on its first row.
      if (markersOwed() && !remote) {
        await writeLegacyMarkers(engine, level);
        value.obligations.legacy_markers_at = new Date().toISOString();
      }
      await applyPassRound(engine, level, { passId, observedAt: startedAt, remote, admission, fullRound: kind === 'full', obligations: value.obligations, context, processingOptions,
        grantPrefixes: remote ? authority.writer.slugPrefixes : null }, applied);
      assertActive();
      if (applied.sweptAll && !value.obligations.legacy_sweep) value.obligations.legacy_sweep = { first_full_at: new Date().toISOString() };
      if (!remote) value.obligations.deletes_withheld = applied.withheld?.set_hash ?? null;
      const deletes: ShadowPath[] = [], imports: ShadowPath[] = [], inFlight: ShadowPath[] = [], mismatch: ShadowPath[] = [], owed: ShadowPath[] = [];
      lastMismatch = mismatch;
      const heldRenameOrigins = new Set(level.heldRenames.map(held => syncOriginPath(held.rename.sourcePath)));
      for (const entry of level.paths) {
        const r = entry.result;
        if (r.settled) continue;
        if (r.inFlight) { inFlight.push(entry); continue; }
        if (S.has(settledKey(entry.path, entry.state.level))) {
          // A hold this pass wrote or re-screened at L, or a slug collision it skipped, is that path's fate here, even when
          // its code re-screens every pass or the skipped twin still classifies as an import.
          if (entry.state.hold?.atLevel || S.get(settledKey(entry.path, entry.state.level)) === 'collision'
            || legacyWaived.has(settledKey(entryPaths(level, entry.path).path, entry.state.level))) continue;
          // Design §3.1: admitted at most once more per (path, level) in this pass, then counted as a settle mismatch.
          const again = settledKey(entry.path, entry.state.level);
          if (readmitted.has(again)) { mismatch.push(entry); continue; }
          readmitted.add(again);
        }
        if (r.action === 'delete') {
          if (heldRenameOrigins.has(syncOriginPath(entryPaths(level, entry.path).sourcePath))) { S.set(settledKey(entry.path, entry.state.level), 'rename_held'); continue; }
          if (admission !== 'normal') { S.set(settledKey(entry.path, entry.state.level), 'paused_deletes'); counts.pausedDeletes++; continue; }
          deletes.push(entry);
        } else if (r.action === 'import' || r.action === 'reparse' || (!remote && (r.cls === 'drift' || r.cls === 'dirty'))) imports.push(entry);
        else owed.push(entry);
      }
      // Origins that differ only by case or separator spelling may be one file on another platform: refuse rather than guess, as discovery does.
      const spelled = owed.filter(entry => entry.result.cls === 'spelling').map(entry => entryPaths(level, entry.path).sourcePath);
      if (spelled.length) {
        await save('blocked', 'page_identity_changed');
        throw opError('page_identity_changed', 'Sync origins for one slug differ only by case or separator spelling.',
          `Files in ${sourceId} differ only by case or separator spelling (${spelled.slice(0, 3).join(', ')}); nothing was written. Keep one spelling, rename or remove the others and commit, then run gbrain sync --no-pull --source ${sourceId}.`);
      }
      const candidates = deletes.length + imports.length;
      if (round === 1) candidatesFirst = candidates + inFlight.length + owed.length;
      value.telemetry.candidates = candidatesFirst;
      value.telemetry.remaining = candidates + inFlight.length + owed.length + mismatch.length;
      if (admission === 'classify_only') { await save('resumable', 'admission_paused'); return result('partial', 'admission_paused'); }
      if (!candidates && inFlight.length && waits < IN_FLIGHT_WAITS) {
        waits++; round--;
        startPersistenceConsumer(engine, loadConfig() ?? { engine: engine.kind }).wake(true);
        const credited = await awaitInFlight(engine, level, inFlight, opts.drainStartedAt ? 30_000 : 5_000, assertActive);
        Object.assign(counts, { added: counts.added + credited.added, modified: counts.modified + credited.modified, deleted: counts.deleted + credited.deleted, renamed: counts.renamed + credited.renamed });
        sliceBase.pages += credited.added + credited.modified + credited.renamed;
        continue;
      }
      if (!candidates && inFlight.length) {
        await save('resumable', 'writer_pending');
        // The request an agent waits on, as the cursor's writer_pending named it.
        const waiting = remote ? null : await openInFlightRequest(engine, level, inFlight);
        return { ...result('partial', 'writer_pending'), ...(waiting?.intent ? { managedWrite: managedSyncWriteDiagnostic({ sourceId, root: context.root, processingOptions,
          syncOptions: input.syncOptions ?? null }, { slug: waiting.slug, intent: waiting.intent as unknown as SyncIntent }, waiting) } : {}) };
      }
      if (!candidates) {
        if (remote) {
          // Design §5: a remote caller stops after its one-sided work; the owner host settles and stamps the rest.
          const reconcile = remoteReconcile(level, { committed: counts.added + counts.modified + counts.deleted + counts.renamed, grantPrefixes: authority.writer.slugPrefixes });
          await save('blocked', 'reconcile_host_required');
          return { ...result('blocked_by_failures', 'reconcile_host_required'), reconcile };
        }
        if (mismatch.length || owed.length) break;
        if (round === 1 && configured && context.source.last_commit === head && !episode && !retry.length && !tail && !value.obligations.slug_mode) {
          // v3 §3.3: a pass that finds nothing at last_commit = T admits no checkpoint; it keeps master's up_to_date (only
          // last_sync_at), and its full round refreshes the converged watermark so the next tick can be idle.
          const at = new Date().toISOString();
          await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
            assertActive();
            await assertDrainLease(tx, sourceId);
            await tx.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1 AND incarnation=$2::uuid', [sourceId, incarnation]);
            // Holds on paths that left the level go with it here too, as a stamp releases them.
            for (const path of level.releasableHolds) await clearGitHold(tx, { sourceId, incarnation, path, observedAt: startedAt });
            const watermark = await readConvergedWatermark(tx, { worktreeId: context.binding.worktree_id, sourceId, incarnation }, null, OPEN_AT_STAMP_CAP);
            value.obligations.converged = { target: head, at, ...watermark, parser_fp: parserFp, pack, selection_fp: selectionFp,
              last_full_at: kind === 'full' || !converged ? at : converged.last_full_at, passes_since_full: kind === 'full' || !converged ? 0 : converged.passes_since_full + 1 };
            Object.assign(value.obligations, { not_converged_streak: 0, mismatch: {}, stuck_since: null });
            value.telemetry = { ...value.telemetry, outcome: 'up_to_date', ended_at: at, remaining: 0, duration_ms: Date.now() - started, counts: { ...counts, ...passApplyCounts(applied) },
              classes: applied.classes, ...(applied.summary ? { summary: applied.summary } : {}) };
            await writePassRow(tx, value);
          }, principalAttribution(authority.writer.principal)));
          rememberLevel();
          await clearPassFailures(engine, sourceId, incarnation);
          await finishPassApply(engine, sourceId, applied);
          return { ...result('up_to_date'), fromCommit: remote ? null : head };
        }
        // Design §6: an open episode closes by inclusion (a) or at the configured selection (b); chunker_version only by (b) over U_config.
        const closure = episode ? await passEpisodeClosure({ gitRoot: context.gitRoot, root: context.root, head, slugMode: levelSlugMode, episode, pass: selection, configured,
          configuredSelection: passSelection(await selectionPatterns(engine, { sourceId } as SyncOpts), { sourceId } as SyncOpts, context, mode) }) : null;
        const closesEpisode = closure?.closes === true;
        if (closure?.released) counts.episodeReleased = closure.released;
        const stamp: PassStamp = { leaseToken: lease.token, incarnation, configured, stampChunker: configured && (context.source.last_commit === null || (closesEpisode && !!episode?.full_id && closure!.stampChunker)),
          closesEpisode, retryTaken: [...retry], releasedHolds: level.releasableHolds, selectionFp, parserFp, pack, full: kind === 'full',
          changed: counts.added + counts.modified + counts.deleted + counts.renamed, extract: !processingOptions.noExtract, since: value.telemetry.started_at };
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
      identityDowngrades.push(...built.downgrades.filter(pair => !identityDowngrades.some(seen => seen.from === pair.from && seen.to === pair.to)));
      for (const entry of [...built.skipped, ...built.collisions.flatMap(c => c.skipped.map(sourcePath => imports.find(i => entryPaths(level, i.path).sourcePath === sourcePath)!))].filter(Boolean)) {
        S.set(settledKey(entry.path, entry.state.level), 'collision'); counts.collisions++;
      }
      if (optOutEpisode && !value.obligations.episode && built.entries.length) value.obligations.episode = episode = optOutEpisode;
      // #6694: the mode this pass publishes pages under is recorded before the first of them, so a pin changed before the stamp refuses there.
      if (level.scope && built.entries.length && !value.obligations.slug_mode) { value.obligations.slug_mode = level.slugMode; await save('open', null); }
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
      for (const entry of [...deletes, ...imports]) if (!S.has(settledKey(entry.path, entry.state.level))) S.set(settledKey(entry.path, entry.state.level), 'settled');
      roundSettled = 0;
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
    assertSyncDispatchActive();
    if (error instanceof SyncAdmissionPaused) { await save('resumable', 'admission_paused').catch(() => undefined); return result('partial', 'admission_paused'); }
    if (input.signal?.aborted && error instanceof Error && error.name === 'AbortError') { await save('resumable', 'timeout').catch(() => undefined); return result('partial', 'timeout'); }
    // A Git listing that did not finish cleanly classifies nothing (design v3.2 §9): the pass stops blocked, having written nothing for that round.
    if (error instanceof SyncTreeReadIncomplete) { await save('blocked', 'reconcile_read_incomplete').catch(() => undefined); return result('blocked_by_failures', 'reconcile_read_incomplete'); }
    throw error;
  } finally {
    unregisterPassCost(passId);
  }
}

/**
 * The pin's start time from the database clock: `sync.admission`'s `effective` compares it with `set_at` (the database's
 * `clock_timestamp()`), so a host clock running ahead cannot make a restriction look effective early.
 */
async function databaseNow(tx: Pick<BrainEngine, 'executeRaw'>): Promise<string> {
  const [row] = await tx.executeRaw<{ at: string | Date }>('SELECT now() AS at');
  return new Date(row!.at).toISOString();
}

/** A converged or idle pass clears what earlier stops recorded: the pass row's failure key and the incarnation's cursor key. */
const passFailureKeys = (sourceId: string, incarnation: string) => [passFingerprint(sourceId, incarnation), managedCursorKey(incarnation, undefined)];
async function clearPassFailures(engine: BrainEngine, sourceId: string, incarnation: string): Promise<void> {
  await Promise.all(passFailureKeys(sourceId, incarnation).map(key => clearManagedSyncFailureAfterSuccess(engine, key)));
}

export type { SyncAdmission };
