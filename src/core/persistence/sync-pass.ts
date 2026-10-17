/**
 * #6712 PR 4a (design v3.2 §2.1-§2.2, §11 step 2): the read-only shadow of the level-triggered managed-sync pass.
 * It reads the level of one managed source and classifies every path of its domain with sync-classify.ts, and writes
 * and admits nothing: no hold, marker, record, pass row, cursor or request. `gbrain sync --dry-run --json` and
 * `gbrain sync status --detail --json` report the result as `convergence` (sync-convergence.ts); PR 4b turns the same
 * reads into the pass.
 *
 * Reads (each timed in `timings_ms`): `T` (`ls-tree -r -z` at HEAD, complete or refused), `X` (the index), `U`
 * (working mode: untracked files), `Dp` (committed mode: candidates only; working mode: every path, the full-round
 * rehash), and the database: `I⋈P` (pages of the source, keyset on `pages.id`, with the import record by a LATERAL
 * primary-key probe and the attestation `A` of the current revision in the same statement), `H` (holds and retry
 * rows), `U_db` (open requests and pending Git effects) and deletion markers. On Postgres the database reads share one
 * `REPEATABLE READ, READ ONLY` snapshot; PGLite admits one transaction at a time, so there they run as bounded
 * statements of at most 2,000 rows with writers between them.
 */
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { hardenedGitStream, hardenedGitSync, hardenedStreamComplete, NulRecordSplitter } from '../hardened-git.ts';
import { matchesAnyGlob, isSyncable } from '../sync.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';
import { resolveSlugRootMode } from '../sync-anchor.ts';
import { resolveSlugForPath } from '../sync.ts';
import { join } from 'node:path';
import { isKeepDbSlug, loadStorageConfig } from '../storage-config.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { currentCompanyBrainSync, getCompanyBrainProfile } from '../company-brain/profile.ts';
import { sha256 } from './digest.ts';
import { sourceMirrorReadOnly } from './mirror-read-only.ts';
import { readSyncFile, resolveManagedSyncContext, syncExcludePatterns, syncGit, type ManagedSyncContext } from './sync-discovery.ts';
import { holdBasisMoved, holdRescreenDue, readGitHoldRetryPaths, readGitSourceHolds, SYNC_IMPORT_PROVENANCE_OP, syncImportParserFor,
  type GitHoldRecord, type SyncImportProvenance } from './sync-holds.ts';
import { movedDriftHolds, sameParser } from './sync-prescreen.ts';
import { syncOriginPath } from './sync-origin.ts';
import { probeDirtiness, readBlobs, readIndexLevel, readTreeLevel, type GitTreeEntry } from './sync-git-stream.ts';
import { classifySyncPath, syncPassKind, type SyncClassified, type SyncIdleBlocker, type SyncPathState } from './sync-classify.ts';
import { buildConvergenceReceipt, readOnlySameContentScreen, type ConvergenceReceipt, type ConvergenceScreen } from './sync-convergence.ts';
import { readManagedMode } from './ownership.ts';

/** The deletion marker op PR 4b writes in every page-row deletion (design v3.2 §2.5); PR 4a only reads it. */
export const SYNC_ORIGIN_DELETED_OP = 'sync-origin-deleted';
/** The pass row PR 4b writes (design v3.2 §3.4); PR 4a only reads it, so a shadow pass is always a full round. */
export const MANAGED_SYNC_PASS_OP = 'managed-sync-pass';
/** Keyset page size: 10,000 rows per statement on Postgres, 2,000 on PGLite (design v3.2 §2.1). */
const KEYSET_ROWS = { postgres: 10_000, pglite: 2_000 };
/** Blob bytes read for adoption by hash and the screen, per blob. */
const LEVEL_BLOB_MAX_BYTES = 8 * 1024 * 1024;
const SYNC_WRITE_KINDS = ['managed_sync_import', 'managed_sync_delete'];

/** One classified path of the shadow level. */
export interface ShadowPath { path: string; slug: string | null; pageId: number | null; revision: string | null; state: SyncPathState; result: SyncClassified;
  /** A page-less path whose file is unchanged since the baseline: PR 4b's bootstrap writes it a `legacy` marker (`legacy_pageless`). */
  legacyPageless?: true }

export interface ShadowLevel {
  sourceId: string; incarnation: string; root: string; gitRoot: string; scope: string; slugMode: 'git-root' | 'source-root';
  mode: 'committed' | 'working'; head: string; baselineCommit: string | null; full: boolean;
  kind: 'idle' | 'hold_only' | 'full'; kindBlockers: SyncIdleBlocker[];
  paths: ShadowPath[];
  /** Live file-backed pages whose origin is eligible: the mass-delete valve's denominator (#2828). */
  reconcilable: number;
  timings_ms: Record<string, number>;
  statements: number;
}

interface PageRow { id: number | string; slug: string; source_path: string; revision: string; deleted: boolean; record: SyncImportProvenance | null;
  arm1: boolean | null; attested_hash: string | null }

type Exec = Pick<BrainEngine, 'executeRaw'>;

/**
 * Runs `fn` over the round's database reads: one `REPEATABLE READ, READ ONLY` snapshot on Postgres; on PGLite (one
 * connection, one transaction at a time) each statement runs on its own so writers and lease renewals interleave.
 */
async function withRoundSnapshot<T>(engine: BrainEngine, fn: (exec: Exec) => Promise<T>): Promise<T> {
  if (engine.kind === 'pglite') return fn(engine);
  return engine.transaction(async tx => {
    await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return fn(tx);
  });
}

/** `I⋈P` and `A`: every page of the source with a recorded origin, its import record and the attestation of its current revision. */
async function readPages(exec: Exec, kind: 'postgres' | 'pglite', sourceId: string, incarnation: string): Promise<{ rows: PageRow[]; statements: number }> {
  const rows: PageRow[] = [];
  let after = 0, statements = 0;
  for (;;) {
    statements++;
    const page = await exec.executeRaw<PageRow>(`SELECT p.id, p.slug, p.source_path, p.knowledge_revision::text AS revision, p.deleted_at IS NOT NULL AS deleted,
        c.completed_keys->0 AS record, a.arm1, a.attested_hash
      FROM pages p
      LEFT JOIN LATERAL (SELECT o.completed_keys FROM op_checkpoints o WHERE o.op=$3 AND o.fingerprint=$4||p.id::text) c ON true
      LEFT JOIN LATERAL (SELECT (r.intent->>'kind' = ANY($6::text[]) AND r.source_incarnation::text=$5 AND (r.page_id IS NULL OR r.page_id=p.id)) AS arm1,
          (SELECT e.data->>'expected_hash' FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.revision=p.knowledge_revision
            AND e.data->>'expected_hash' IS NOT NULL AND (e.data->>'relative_path'=p.source_path OR right(e.data->>'relative_path', length(p.source_path)+1)='/'||p.source_path) LIMIT 1) AS attested_hash
        FROM persistence_requests r WHERE r.id=p.revision_write_request_id AND r.state='committed' AND r.source_id=p.source_id) a ON true
      WHERE p.source_id=$1 AND p.source_path IS NOT NULL AND p.id>$2 ORDER BY p.id LIMIT ${KEYSET_ROWS[kind]}`,
      [sourceId, after, SYNC_IMPORT_PROVENANCE_OP, `${sourceId}:${incarnation}:`, incarnation, SYNC_WRITE_KINDS]);
    rows.push(...page);
    if (page.length < KEYSET_ROWS[kind]) return { rows, statements };
    after = Number(page[page.length - 1]!.id);
  }
}

/** `U_db`: open requests of the worktree (the `persistence_requests_pending` index) and pending Git effects of the source. */
async function readOpenWork(exec: Exec, sourceId: string, worktreeId: string): Promise<{ pageIds: Set<number>; origins: Set<string>; statements: number }> {
  const requests = await exec.executeRaw<{ page_id: number | null; source_path: string | null; path: string | null }>(`SELECT page_id, intent->>'sourcePath' AS source_path, intent->>'path' AS path
    FROM persistence_requests WHERE worktree_id=$1 AND state IN ('queued','running','recovering') AND source_id=$2`, [worktreeId, sourceId]);
  const effects = await exec.executeRaw<{ page_id: number | null; path: string | null }>(`SELECT r.page_id, e.data->>'relative_path' AS path
    FROM persistence_requests r JOIN persistence_effects e ON e.request_id=r.id
    WHERE r.worktree_id=$1 AND r.source_id=$2 AND e.kind='git' AND e.state IN ('queued','running')`, [worktreeId, sourceId]);
  const pageIds = new Set<number>(), origins = new Set<string>();
  for (const row of [...requests, ...effects]) if (row.page_id != null) pageIds.add(Number(row.page_id));
  for (const row of requests) for (const origin of [row.source_path, row.path]) if (origin) origins.add(syncOriginPath(origin));
  for (const row of effects) if (row.path) origins.add(syncOriginPath(row.path));
  return { pageIds, origins, statements: 2 };
}

/** Deletion markers of the incarnation (a primary-key range read); none exist before PR 4b. */
async function readMarkers(exec: Exec, sourceId: string, incarnation: string): Promise<Map<string, { kind: 'deleted' | 'legacy'; blobOids: string[] }>> {
  const prefix = `${sourceId}:${incarnation}:`;
  const rows = await exec.executeRaw<{ fingerprint: string; value: { kind?: string; blob_oids?: unknown } | null }>(
    'SELECT fingerprint, completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint >= $2 AND fingerprint < $3',
    [SYNC_ORIGIN_DELETED_OP, prefix, `${prefix}\uffff`]);
  return new Map(rows.map(row => [syncOriginPath(row.fingerprint.slice(prefix.length)), {
    kind: row.value?.kind === 'legacy' ? 'legacy' as const : 'deleted' as const,
    blobOids: Array.isArray(row.value?.blob_oids) ? (row.value!.blob_oids as unknown[]).filter((oid): oid is string => typeof oid === 'string') : [] }]));
}

/** The pass row of the incarnation (PR 4b writes it); null in PR 4a. */
async function readPassRow(exec: Exec, sourceId: string, incarnation: string): Promise<Record<string, unknown> | null> {
  const [row] = await exec.executeRaw<{ value: Record<string, unknown> | null }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [MANAGED_SYNC_PASS_OP, `${sourceId}:${incarnation}`]);
  return row?.value ?? null;
}

function revParse(gitRoot: string, rev: string): string | null {
  const out = hardenedGitSync(gitRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { timeoutMs: 10_000, maxBytes: 4096 });
  return out.ok ? out.stdout.toString('utf8').trim() || null : null;
}

/** Working mode's `U`: untracked, not ignored files (index and exclude files only; no worktree conversion). */
async function readUntracked(gitRoot: string, scope: string): Promise<string[]> {
  const paths: string[] = [];
  const splitter = new NulRecordSplitter();
  const result = await hardenedGitStream(gitRoot, ['ls-files', '-z', '--others', '--exclude-standard', '--', scope === '' ? '.' : scope],
    { timeoutMs: 120_000, onChunk: chunk => { for (const record of splitter.push(chunk)) paths.push(record.toString('utf8')); } });
  if (!hardenedStreamComplete(result) || !splitter.atRecordBoundary) throw new Error('git ls-files --others did not finish a complete read');
  return paths;
}

const timer = () => { const started = performance.now(); return () => Math.round((performance.now() - started) * 10) / 10; };

/**
 * The shadow level of a managed source: every path classified, nothing written. Null for a company-brain source, which
 * keeps its frozen manifest (design v3.2 §3.6).
 */
export async function readShadowLevel(engine: BrainEngine, input: { sourceId: string; full?: boolean; workingTree?: boolean; context?: ManagedSyncContext }): Promise<ShadowLevel | null> {
  const total = timer();
  const timings: Record<string, number> = {};
  let t = timer();
  const context = input.context ?? await resolveManagedSyncContext(engine, { sourceId: input.sourceId, noPull: true, dryRun: true });
  timings.context = t();
  t = timer();
  if (currentCompanyBrainSync(context.sourceId) || await getCompanyBrainProfile(engine, context.sourceId)) return null;
  timings.company = t();
  const { sourceId, incarnation, root, gitRoot } = context;
  t = timer();
  const nativeRoot = realpathSync.native(root), nativeGitRoot = realpathSync.native(gitRoot);
  const scope = relative(nativeGitRoot, nativeRoot).split(sep).join('/');
  const slugMode = scope ? await resolveSlugRootMode(engine, { sourceId, explicitGitRoot: false, slugPrefix: resolveSlugForPath(join(scope, 'x.md')).slice(0, -2), dryRun: true }) : 'git-root';
  const strategy = (context.source.config?.strategy as string | undefined) ?? 'markdown';
  const exclude = await syncExcludePatterns(engine);
  const includeHidden = [...new Set((await engine.getConfig('sync.include_hidden') ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean).map(v => v.endsWith('/') ? `${v}**` : v))];
  const sourceRelative = (gitPath: string) => (scope ? gitPath.slice(scope.length + 1) : gitPath);
  const eligible = (gitPath: string) => (!scope || gitPath.startsWith(`${scope}/`)) && !matchesAnyGlob(sourceRelative(gitPath), exclude)
    && !isReservedSkillBundlePath(slugMode === 'source-root' ? sourceRelative(gitPath) : gitPath) && isSyncable(gitPath, { strategy: strategy as 'markdown', includeHidden });
  const originOf = (gitPath: string) => syncOriginPath(slugMode === 'source-root' && scope ? sourceRelative(gitPath) : gitPath);
  const gitPathOf = (origin: string) => { const o = syncOriginPath(origin); return slugMode === 'source-root' && scope ? `${scope}/${o}` : o; };

  timings.setup = t();
  t = timer();
  const head = revParse(gitRoot, 'HEAD');
  if (!head) throw new Error(`source ${sourceId}: HEAD does not name a commit, so there is no level to read`);
  // Master's rule (sync-discovery.ts): a detached HEAD forces working mode.
  const detached = syncGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD';
  const working = detached || (input.workingTree ?? (await engine.getConfig('sync.include_working_tree') === 'true'));
  const mode: 'committed' | 'working' = working ? 'working' : 'committed';
  timings.rev_parse = t();

  t = timer();
  const treeAll = await readTreeLevel(gitRoot, head, scope);
  const tree = new Map<string, GitTreeEntry>([...treeAll].filter(([path]) => eligible(path)));
  timings.T = t();
  t = timer();
  const index = await readIndexLevel(gitRoot);
  timings.X = t();
  t = timer();
  const untracked = new Set(mode === 'working' ? (await readUntracked(gitRoot, scope)).filter(eligible) : []);
  timings.U = t();

  t = timer();
  const pack = await loadActivePackForEngine(engine, { remote: false, sourceId }).catch(() => null);
  timings.pack = t();
  t = timer();
  const keepDbPrefixes = (() => { try { return loadStorageConfig(root)?.keep_db ?? []; } catch { return []; } })();
  const mirror = await sourceMirrorReadOnly(engine, sourceId);
  timings.mirror = t();
  t = timer();
  const { pages, open, markers, passRow, statements } = await withRoundSnapshot(engine, async exec => {
    let st = timer();
    const read = await readPages(exec, engine.kind === 'pglite' ? 'pglite' : 'postgres', sourceId, incarnation);
    timings.pages = st();
    st = timer();
    const work = await readOpenWork(exec, sourceId, context.binding.worktree_id);
    timings.open_work = st();
    st = timer();
    const markers = await readMarkers(exec, sourceId, incarnation);
    timings.markers = st();
    st = timer();
    const passRow = await readPassRow(exec, sourceId, incarnation);
    timings.pass_row = st();
    return { pages: read.rows, open: work, markers, passRow, statements: read.statements + work.statements + 2 };
  });
  timings['I⋈P'] = t();

  t = timer();
  const holds = ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => hold.incarnation === incarnation);
  const retry = new Set(await readGitHoldRetryPaths(engine, sourceId, incarnation));
  const toGit = (holdPath: string) => (scope ? `${scope}/${holdPath}` : holdPath);
  const holdByGitPath = new Map<string, GitHoldRecord>(holds.map(hold => [toGit(hold.path), hold]));
  const holdByPath = new Map(holds.map(hold => [hold.path, hold]));
  const moved = new Set([...await holdBasisMoved(engine, sourceId, holdByPath, [...holdByPath.keys()]), ...await movedDriftHolds(engine, sourceId, holds)].map(toGit));
  timings.H = t();

  // The page claiming each origin: the live one first, else the newest tombstone.
  t = timer();
  const byOrigin = new Map<string, PageRow>();
  for (const row of pages) {
    const key = gitPathOf(row.source_path);
    const prior = byOrigin.get(key);
    if (!prior || (prior.deleted && !row.deleted) || (prior.deleted === row.deleted && Number(row.id) > Number(prior.id))) byOrigin.set(key, row);
  }
  const domain = new Set<string>([...tree.keys(), ...untracked, ...(mode === 'working' ? [...index.keys()].filter(eligible) : []), ...[...byOrigin.keys()].filter(eligible), ...[...markers.keys()].map(gitPathOf).filter(eligible)]);
  const spellings = new Map<string, Set<string>>();
  for (const path of domain) {
    const live = byOrigin.get(path);
    if (!tree.has(path) && !(live && !live.deleted)) continue;
    const folded = path.replaceAll('\\', '/').toLowerCase();
    (spellings.get(folded) ?? spellings.set(folded, new Set()).get(folded)!).add(path);
  }
  const reconcilable = [...byOrigin.entries()].filter(([path, row]) => !row.deleted && eligible(path)).length;
  timings.domain = t();

  // Working mode rehashes every path (the full round's unconditional rehash); committed mode probes candidates only.
  t = timer();
  const probes = mode === 'working' ? await probeDirtiness(root, gitRoot, [...domain], tree, index) : new Map();
  timings.Dp = t();

  const baselineCommit = (context.source.last_commit && revParse(gitRoot, context.source.last_commit)) || null;
  let baselineTree: Map<string, GitTreeEntry> | null | undefined;
  const baselineOf = async (path: string): Promise<string | null> => {
    if (!baselineCommit) return null;
    if (baselineTree === undefined) { const bt = timer(); baselineTree = await readTreeLevel(gitRoot, baselineCommit, scope).catch(() => null); timings.baseline = bt(); }
    return baselineTree?.get(path)?.oid ?? null;
  };

  const fp = (path: string) => syncImportParserFor(sourceRelative(path), pack?.identity ?? null);
  const stateOf = async (path: string, dirty: SyncPathState['dirty'], probe: { dp: string; rawOid: string | null; rawSha256: string | null } | undefined): Promise<{ state: SyncPathState; row?: PageRow; legacyPageless?: true }> => {
    const committed = tree.get(path) ?? null;
    const row = byOrigin.get(path);
    const level = mode === 'committed' ? committed?.oid ?? null
      : !probe || probe.dp === 'deleted' ? null
      : ['clean', 'clean_eol', 'clean_lfs'].includes(probe.dp) ? committed?.oid ?? probe.rawOid : probe.rawOid ?? `unreadable:${path}`;
    // Presence decides only rows 4-6 (a level of absent); a committed path in T is not read here (Dp covers it).
    const presentNow = mode === 'working' ? level !== null : level === null ? readPresent(root, path, scope) : true;
    const record = row?.record ?? null;
    const recordBlobOids = record ? [record.blob_oid, record.disk_blob_oid].filter((oid): oid is string => typeof oid === 'string' && oid.length > 0) : [];
    const attested = row && (row.arm1 || row.attested_hash) ? { hash: row.attested_hash ?? null, arm1: row.arm1 === true } : null;
    const hold = holdByGitPath.get(path);
    const marker = markers.get(originOf(path)) ?? null;
    let virtualMarker: SyncPathState['marker'] = null;
    let legacyPageless: true | undefined;
    if (!row && !marker && level !== null && level === await baselineOf(path)) { virtualMarker = { kind: 'legacy', blobOids: [level] }; legacyPageless = true; }
    const needsBaseline = row && !row.deleted && (record?.revision == null) && level !== null && !recordBlobOids.includes(level);
    const state: SyncPathState = {
      mode, tree: committed?.oid ?? null, level, present: presentNow, dirty, diskOid: probe?.rawOid ?? null,
      page: row ? { live: !row.deleted, revision: row.revision, originMatches: !!record && syncOriginPath(record.origin) === syncOriginPath(row.source_path) } : null,
      record: record ? { blobOids: recordBlobOids, revision: record.revision != null ? String(record.revision) : null, parserSame: sameParser(record.parser, fp(path)) } : null,
      attested, levelSha256: probe?.rawSha256 ?? null,
      published: !!attested?.hash && probe?.rawSha256 === attested.hash,
      hold: hold ? { atLevel: holdAtLevel(hold, level, probe?.rawSha256 ?? null) && !moved.has(path), rescreenDue: holdRescreenDue(hold, retry.has(hold.path)), retried: retry.has(hold.path) } : null,
      marker: marker ?? virtualMarker, baseline: needsBaseline ? await baselineOf(path) : null,
      spelling: (spellings.get(path.replaceAll('\\', '/').toLowerCase())?.size ?? 0) > 1,
      episodeUnsatisfied: input.full === true && !!row && !row.deleted,
      keepDb: !mirror && keepDbPrefixes.length > 0 && !!row && isKeepDbSlug(row.slug, keepDbPrefixes),
      openWork: !!row && open.pageIds.has(Number(row.id)) || open.origins.has(originOf(path)),
    };
    return { state, ...(row ? { row } : {}), ...(legacyPageless ? { legacyPageless } : {}) };
  };

  t = timer();
  const paths: ShadowPath[] = [];
  const candidates: string[] = [];
  const settledBeforeDirtiness = new Set(['held', 'spelling', 'untracked', 'kept', 'delete', 'delete_drift', 'gone', 'deleted_same', 'deleted_edited', 'legacy_same', 'matched']);
  for (const path of [...domain].sort()) {
    const probe = probes.get(path);
    const { state, row, legacyPageless } = await stateOf(path, mode === 'committed' && tree.has(path) ? 'clean' : null, probe);
    const result = classifySyncPath(state);
    // Rows 1-10 precede row 11 and `matched` settles either way, so only the rest are Dp candidates (design v3.2 §2.1).
    const staged = mode === 'committed' && tree.has(path) && (index.get(path)?.oid !== tree.get(path)!.oid || (index.get(path)?.stage ?? 0) !== 0);
    if (mode === 'committed' && tree.has(path) && (!settledBeforeDirtiness.has(result.cls) || staged)) candidates.push(path);
    paths.push({ path, slug: row?.slug ?? null, pageId: row ? Number(row.id) : null, revision: row?.revision ?? null, state, result, ...(legacyPageless ? { legacyPageless } : {}) });
  }
  timings.classify = t();
  if (candidates.length) {
    t = timer();
    const probed = await probeDirtiness(root, gitRoot, candidates, tree, index);
    timings.Dp = (timings.Dp ?? 0) + t();
    t = timer();
    const at = new Map(paths.map((entry, i) => [entry.path, i]));
    for (const path of candidates) {
      const probe = probed.get(path);
      const i = at.get(path)!;
      const { state } = await stateOf(path, (probe?.dp ?? 'unknown') as SyncPathState['dirty'], probe);
      paths[i] = { ...paths[i]!, state, result: classifySyncPath(state) };
    }
    timings.classify += t();
  }

  // Adoption by hash needs the level's bytes: committed mode reads the blobs of the candidates that could adopt.
  const needBytes = paths.filter(entry => entry.state.levelSha256 === null && entry.state.level !== null && entry.state.attested?.hash && entry.state.page?.live
    && !['matched', 'held', 'dirty'].includes(entry.result.cls));
  if (needBytes.length) {
    t = timer();
    const blobs = await readBlobs(gitRoot, [...new Set(needBytes.map(entry => entry.state.level!))], LEVEL_BLOB_MAX_BYTES);
    for (const entry of needBytes) {
      const bytes = blobs.get(entry.state.level!);
      if (!bytes) continue;
      const state = { ...entry.state, levelSha256: sha256(bytes) };
      Object.assign(entry, { state, result: classifySyncPath(state) });
    }
    timings.level_bytes = t();
  }

  const kind = syncPassKind({ converged: null, head, parserFp: '', pack: pack?.identity ?? null, selectionFp: '', now: Date.now(), openEpisode: input.full === true, owedTail: false,
    retryRow: retry.size > 0, notConvergedStreak: 0, mismatchStreak: 0, requestNewer: false, openAtStampFinished: false, workingChange: false,
    rescreenDueHold: holds.some(hold => holdRescreenDue(hold, retry.has(hold.path))), full: input.full === true });
  void passRow;
  timings.total = total();
  return { sourceId, incarnation, root, gitRoot, scope, slugMode, mode, head, baselineCommit, full: input.full === true, kind: kind.kind, kindBlockers: kind.blockers,
    paths, reconcilable, timings_ms: timings, statements: statements + 3 };
}

/** `workingTreeFilePresent` (sync-discovery.ts) for a Git-root path: a file that exists, or one that cannot be read (fail closed). */
function readPresent(root: string, gitPath: string, scope: string): boolean {
  const path = scope ? gitPath.slice(scope.length + 1) : gitPath;
  try { return readSyncFile(root, path) !== null; } catch { return true; }
}

/** Whether a hold still describes the path at level `L`, in the hold's own domain (a pinned blob, working bytes, or a deletion). */
function holdAtLevel(hold: GitHoldRecord, level: string | null, diskSha256: string | null): boolean {
  if (hold.meta.deleted) return level === null;
  if (level === null) return false;
  if (hold.meta.working) return diskSha256 === null || diskSha256 === (hold.meta.working_hash ?? hold.upstream_version);
  return hold.meta.blob_oid ? hold.meta.blob_oid === level : true;
}

/**
 * The read-only convergence receipt of a source (design v3.1 §11 step 2): the shadow level, its predicted decisions after
 * a read-only screen (dry runs only), and the delete valve's verdict. Null for a company-brain source.
 */
export async function shadowConvergence(engine: BrainEngine, input: { sourceId: string; full?: boolean; workingTree?: boolean; redactPaths?: boolean; sampleCap?: number;
  screen?: ConvergenceScreen | false; context?: ManagedSyncContext }): Promise<ConvergenceReceipt | null> {
  const level = await readShadowLevel(engine, input);
  if (!level) return null;
  return buildConvergenceReceipt(engine, level, { redactPaths: input.redactPaths === true, sampleCap: input.sampleCap ?? 20, screen: input.screen ?? false });
}

/**
 * The idle tick's reads (design v3.2 §2.2): `rev-parse`, the per-source request probe above the converged watermark
 * (a range on the unique `sequence` index), the open-set probe (`persistence_requests_pending`) and the pass row. PR 4a
 * writes no pass row, so a real tick is never idle yet; `assumeConverged` lets the bench time the reads PR 4b's idle
 * tick will make, with `request_hwm` at the current maximum.
 */
export async function idleTickProbe(engine: BrainEngine, input: { sourceId: string; assumeConverged?: { target: string; requestHwm: number }; context?: ManagedSyncContext }):
  Promise<{ idle: boolean; reasons: SyncIdleBlocker[]; timings_ms: Record<string, number>; rows: number }> {
  const timings: Record<string, number> = {};
  const total = timer();
  let t = timer();
  const context = input.context ?? await resolveManagedSyncContext(engine, { sourceId: input.sourceId, noPull: true, dryRun: true });
  timings.context = t();
  t = timer();
  const head = revParse(context.gitRoot, 'HEAD');
  timings.rev_parse = t();
  t = timer();
  const row = await readPassRow(engine, context.sourceId, context.incarnation);
  timings.pass_row = t();
  const converged = input.assumeConverged ?? (row?.converged as { target: string; request_hwm: number } | undefined
    ? { target: String((row!.converged as Record<string, unknown>).target), requestHwm: Number((row!.converged as Record<string, unknown>).request_hwm) } : null);
  t = timer();
  const newer = await engine.executeRaw<{ one: number }>('SELECT 1 AS one FROM persistence_requests WHERE sequence > $1 AND worktree_id = $2 LIMIT 1',
    [converged?.requestHwm ?? 0, context.binding.worktree_id]);
  timings.request_probe = t();
  t = timer();
  const pending = await engine.executeRaw<{ one: number }>("SELECT 1 AS one FROM persistence_requests WHERE worktree_id = $1 AND state IN ('queued','running','recovering') LIMIT 1",
    [context.binding.worktree_id]);
  timings.open_probe = t();
  const kind = syncPassKind({ converged: converged ? { target: converged.target, parserFp: '', pack: null, selectionFp: '', passesSinceFull: 0, lastFullAt: Date.now() } : null,
    head: head ?? '', parserFp: '', pack: null, selectionFp: '', now: Date.now(), openEpisode: false, owedTail: false, retryRow: false, notConvergedStreak: 0, mismatchStreak: 0,
    requestNewer: newer.length > 0, openAtStampFinished: pending.length > 0 && !input.assumeConverged, workingChange: false, rescreenDueHold: false, full: false });
  timings.total = total();
  return { idle: kind.kind === 'idle', reasons: kind.blockers, timings_ms: timings, rows: newer.length + pending.length + (row ? 1 : 0) };
}

/**
 * `gbrain sync --dry-run --json`'s `convergence` for one source: the receipt with the read-only screen, undefined
 * on a brain that is not managed or for a company-brain source; a read that cannot run reports why instead of failing
 * the dry run.
 */
export async function dryRunConvergence(engine: BrainEngine, input: { sourceId: string; full: boolean; workingTree?: boolean; redactPaths: boolean;
  noEmbed: boolean; noExtract: boolean; noSchemaPack: boolean }): Promise<ConvergenceReceipt | { dry_run: true; status: 'unavailable'; code: string; message: string } | undefined> {
  if (!await readManagedMode(engine)) return undefined;
  try {
    const context = await resolveManagedSyncContext(engine, { sourceId: input.sourceId, noPull: true, dryRun: true });
    return await shadowConvergence(engine, { sourceId: input.sourceId, full: input.full, workingTree: input.workingTree, redactPaths: input.redactPaths, context,
      screen: readOnlySameContentScreen(engine, context, { noEmbed: input.noEmbed, noExtract: input.noExtract, noSchemaPack: input.noSchemaPack }) }) ?? undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { dry_run: true, status: 'unavailable', code: typeof code === 'string' ? code : 'convergence_read_failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** \`sync status --detail\`'s \`convergence\`: the receipt without the screen (status never prepares an import). */
export async function statusConvergence(engine: BrainEngine, sourceId: string): Promise<ConvergenceReceipt | { dry_run: true; status: 'unavailable'; code: string; message: string } | null> {
  if (!await readManagedMode(engine)) return null;
  try {
    return await shadowConvergence(engine, { sourceId, screen: false });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { dry_run: true, status: 'unavailable', code: typeof code === 'string' ? code : 'convergence_read_failed', message: error instanceof Error ? error.message : String(error) };
  }
}
