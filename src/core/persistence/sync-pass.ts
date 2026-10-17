/**
 * #6712 PR 4a (design v3.2 §2.1-§2.2, §11 step 2): the read-only shadow of the level-triggered managed-sync pass.
 * It reads the level of one managed source and classifies every path of its domain with sync-classify.ts, and writes
 * and admits nothing: no hold, marker, record, pass row, cursor or request. `gbrain sync --dry-run --json` and
 * `gbrain sync status --detail --json` report the result as `convergence` (sync-convergence.ts); PR 4b turns the same
 * reads into the pass.
 *
 * Reads (each timed in `timings_ms`, with `context`, `setup` and the rest of the round): `T` (`ls-tree -r -z` at HEAD,
 * complete or refused), `X` (the index), `U` (working mode: untracked files), `Dp` (committed mode: candidates only;
 * working mode: every path, the full-round rehash), and the database: `I⋈P` (pages of the source with their import
 * records), `H` (holds and retry rows), `U_db` (open requests and pending Git effects), deletion markers, and `A` (the
 * attestation of the current revision) for the pages whose class needs a proof. The Git reads, the database snapshot and
 * the holds run concurrently (`reads` is their wall time). On Postgres the snapshot reads share one `REPEATABLE READ,
 * READ ONLY` transaction and `I⋈P` is one set-based statement read through a cursor; PGLite admits one transaction at a
 * time, so there they run as bounded statements of at most 2,000 rows with writers between them.
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
import { hashWorkingLevel, probeDirtiness, readBlobs, readIndexDelta, readIndexLevel, readTreeLevel, workingChanged, type GitIndexEntry, type GitTreeEntry, type WorkingStatCache } from './sync-git-stream.ts';
import { classifySyncPath, syncPassKind, type SyncClassified, type SyncIdleBlocker, type SyncPathState } from './sync-classify.ts';
import { buildConvergenceReceipt, readOnlySameContentScreen, type ConvergenceReceipt, type ConvergenceScreen } from './sync-convergence.ts';
import { readManagedMode } from './ownership.ts';
import { MANAGED_SYNC_PASS_OP, SYNC_ORIGIN_DELETED_OP, type SyncSelection } from './sync-pass-row.ts';
import { loopYield, sortYielding } from './sync-yield.ts';

export { MANAGED_SYNC_PASS_OP, SYNC_ORIGIN_DELETED_OP };

/** What a live pass feeds the level read (sync-pass-run.ts): its episode, the retry paths it already re-screened, and its selection. */
export interface PassLevelInput {
  /** The open episode's `full_id`: a live page whose record carries another is `episodeUnsatisfied`. Null: no full obligation. */
  episodeFullId: string | null;
  /** Hold paths (source-relative) whose retry row this pass already re-screened: no longer `retried` in its later rounds. */
  retryConsumed?: ReadonlySet<string>;
  exclude?: readonly string[];
  includeHidden?: readonly string[];
  strategy?: string;
  /**
   * The incarnation's first pass (no pass row yet): a page-less path whose level equals its baseline blob and whose slug a
   * committed deletion names reads a virtual `legacy` marker, which the pass then writes (design §2.7, b1). After it, only
   * stored markers count.
   */
  bootstrap?: boolean;
  /** The pass imports without the schema pack (`no-schema-pack` or an episode carrying it): its parser expects no pack. */
  noSchemaPack?: boolean;
  /** #6694: the slug-root mode an unstamped pass of this source admitted under (`obligations.slug_mode`); a subdirectory source reads under it, not its pin. */
  slugMode?: 'git-root' | 'source-root';
  /** The pass's own cache (it dies with the pass): the eligible tree of the commit and selection its last round read. */
  cache?: PassLevelCache;
}
/** PGLite's keyset page size (design v3.2 §2.1). */
const PGLITE_KEYSET_ROWS = 2_000;
/** Rows per `FETCH` of Postgres's `I⋈P` cursor: decoding one fetch stays well under the event-loop budget at 600k pages. */
const POSTGRES_FETCH_ROWS = 25_000;
/** Blob bytes read for adoption by hash and the screen, per blob. */
const LEVEL_BLOB_MAX_BYTES = 8 * 1024 * 1024;
const SYNC_WRITE_KINDS = ['managed_sync_import', 'managed_sync_delete'];

/** What one pass reuses between its rounds: a commit's tree never changes, so the next round at the same commit and selection reads it from here. */
export interface PassLevelCache { tree?: { key: string; tree: Map<string, GitTreeEntry> } }

/**
 * Classifier results never change once made (a settle replaces the object), so equal ones are one object: a 600k-path
 * level holds a handful instead of one per path. Bounded; a result past the bound stays its own.
 */
const SHARED_RESULTS = new Map<string, SyncClassified>();
function sharedResult(result: SyncClassified): SyncClassified {
  const key = JSON.stringify(result);
  const shared = SHARED_RESULTS.get(key);
  if (shared) return shared;
  if (SHARED_RESULTS.size < 256) SHARED_RESULTS.set(key, Object.freeze(result) as SyncClassified);
  return result;
}

/** One classified path of the shadow level. */
export interface ShadowPath { path: string; slug: string | null; pageId: number | null; revision: string | null; state: SyncPathState; result: SyncClassified;
  /** A page-less path unchanged since the baseline whose page a committed request deleted: the bootstrap writes it a `legacy` marker (`legacy_pageless`). */
  legacyPageless?: true }

/**
 * A `matched` path whose state is the converged one (a live page whose record proves the level's blob and revision, nothing
 * held, marked, owed or open): it keeps the few fields that vary and rebuilds the same `SyncPathState` on read. Most paths
 * of a large converged source are these; a level of 600k holds them in about a fifth of a full entry's memory.
 */
class MatchedPath implements ShadowPath {
  constructor(public path: string, public slug: string | null, public pageId: number | null, public revision: string, public result: SyncClassified,
    private readonly treeOid: string | null, private readonly levelOid: string, private readonly dirty: SyncPathState['dirty'], private readonly diskRecorded: boolean,
    private readonly shared: { mode: SyncPathState['mode']; fullObligation: boolean }) {}

  /** Whether `state` is the one `state` would rebuild for a page at `revision`. */
  static fits(state: SyncPathState, revision: string | null, shared: MatchedPath['shared']): revision is string {
    return revision !== null && state.mode === shared.mode && state.fullObligation === shared.fullObligation && state.level !== null && state.present
      && state.diskOid === null && state.levelSha256 === null && !state.published && state.attested === null && state.hold === null && state.marker === null
      && state.baseline === null && !state.spelling && !state.episodeUnsatisfied && !state.keepDb && !state.openWork
      && state.page?.live === true && state.page.revision === revision && state.page.originMatches
      && state.record?.revision === revision && state.record.parserSame && state.record.blobOids.length <= 2 && state.record.blobOids.length > 0
      && state.record.blobOids.every(oid => oid === state.level);
  }

  get state(): SyncPathState {
    return { mode: this.shared.mode, tree: this.treeOid, level: this.levelOid, present: true, dirty: this.dirty, diskOid: null,
      page: { live: true, revision: this.revision, originMatches: true }, record: { blobOids: this.diskRecorded ? [this.levelOid, this.levelOid] : [this.levelOid], revision: this.revision, parserSame: true },
      attested: null, levelSha256: null, published: false, hold: null, marker: null, baseline: null, spelling: false, episodeUnsatisfied: false,
      fullObligation: this.shared.fullObligation, keepDb: false, openWork: false };
  }

  set state(value: SyncPathState) {
    Object.defineProperty(this, 'state', { value, writable: true, enumerable: true, configurable: true });
  }
}

export interface ShadowLevel {
  sourceId: string; incarnation: string; root: string; gitRoot: string; scope: string; slugMode: 'git-root' | 'source-root';
  mode: 'committed' | 'working'; head: string; baselineCommit: string | null; full: boolean;
  kind: 'idle' | 'hold_only' | 'full'; kindBlockers: SyncIdleBlocker[];
  paths: ShadowPath[];
  /** The schema pack in effect (the pass's `pack` fingerprint) and the selection the level read (design §6). */
  pack: string | null;
  selection: SyncSelection;
  /** Re-screen-due hold paths (Git-root paths): a hold-only round's candidates. */
  rescreenDue: string[];
  /** Held renames (#5988), by the held destination's Git path: the destination still owes its page the move, and the origin's deletion waits for the hold. */
  heldRenames: Array<{ path: string; rename: { sourcePath: string; slug: string; pageId: number; revision: string } }>;
  /** Holds on paths outside the level's domain (no file at L, no page, or no longer eligible): the stamp releases them, as discovery did (#6278 B7). */
  releasableHolds: string[];
  /** Working mode: the stat cache this round's rehash left (`hashWorkingLevel`); the stamp's round is the one a pass remembers. */
  workingCache: WorkingStatCache | null;
  /** Live file-backed pages whose origin is eligible: the mass-delete valve's denominator (#2828). */
  reconcilable: number;
  timings_ms: Record<string, number>;
  statements: number;
}

/** A page of the source with the import-record fields the classifier reads; `arm1` / `attested_hash` (`A`) are filled for the pages that need a proof. */
interface PageRow { id: number | string; slug: string; source_path: string; revision: string; deleted: boolean; request_id: string | null;
  record: (Pick<SyncImportProvenance, 'origin' | 'blob_oid' | 'disk_blob_oid' | 'revision' | 'parser'> & { full_episode?: string | null }) | null; arm1: boolean | null; attested_hash: string | null }

/** The record's blob ids; one equal to `level` is `level`'s own string, so a converged page keeps one copy of its blob id. */
const recordOids = (record: PageRow['record'], level?: string | null): string[] => {
  const oids: string[] = [];
  for (const oid of record ? [record.blob_oid, record.disk_blob_oid] : []) if (typeof oid === 'string' && oid.length > 0) oids.push(oid === level ? level : oid);
  return oids;
};

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

/**
 * `I⋈P`: every page of the source with a recorded origin and the fields of its import record the classifier reads. Postgres
 * plans it as one set-based statement inside the round's snapshot (the planner hash-joins pages with their records; a
 * keyset with a per-row primary-key probe made the 61k read plan-bound, about 1.7 s of server time) and reads it through a
 * cursor, `POSTGRES_FETCH_ROWS` at a time with the next fetch in flight: one result of 600k rows decoded in a single
 * stretch of about a second and held every raw row at once. `cursor_tuple_fraction = 1` keeps the whole-result plan.
 * PGLite reads bounded keyset statements so writers interleave.
 */
async function readPages(exec: Exec, kind: 'postgres' | 'pglite', sourceId: string, incarnation: string): Promise<{ rows: PageRow[]; statements: number }> {
  // A record's fields usually repeat the page's (origin = source_path, disk = blob, revision = the page's), so those come back
  // as a flag instead of a second copy of the string, and the parser as text parsed once per distinct value: a 600k-page
  // read then holds about one string per field per page.
  // The record's fields come out of its JSON once, in a subquery. On Postgres `OFFSET 0` keeps it unflattened, so the hash
  // join builds over those few text columns instead of the whole record (600k: about 3.1 s of serial server time to 2.0 s);
  // PGLite's keyset statements need it flattened, so each probes the record by primary key.
  const select = `SELECT p.id, p.slug, p.source_path, p.knowledge_revision::text AS revision, p.deleted_at IS NOT NULL AS deleted,
      p.revision_write_request_id::text AS request_id, c.fingerprint IS NOT NULL AS has_record,
      c.origin IS NOT DISTINCT FROM p.source_path AS rec_origin_same,
      CASE WHEN c.origin IS DISTINCT FROM p.source_path THEN c.origin END AS rec_origin,
      c.blob_oid AS rec_blob_oid,
      c.disk_blob_oid IS NOT DISTINCT FROM c.blob_oid AS rec_disk_same,
      CASE WHEN c.disk_blob_oid IS DISTINCT FROM c.blob_oid THEN c.disk_blob_oid END AS rec_disk_blob_oid,
      c.revision IS NULL AS rec_revision_null,
      NULLIF(c.revision, p.knowledge_revision::text) AS rec_revision,
      c.parser AS rec_parser, c.full_episode AS rec_full_episode
    FROM pages p LEFT JOIN (SELECT fingerprint, completed_keys->0->>'origin' AS origin, completed_keys->0->>'blob_oid' AS blob_oid,
        completed_keys->0->>'disk_blob_oid' AS disk_blob_oid, completed_keys->0->>'revision' AS revision,
        (completed_keys->0->'parser')::text AS parser, completed_keys->0->>'full_episode' AS full_episode
      FROM op_checkpoints WHERE op=$2${kind === 'postgres' ? ' OFFSET 0' : ''}) c ON c.fingerprint=$3||p.id::text
    WHERE p.source_id=$1 AND p.source_path IS NOT NULL`;
  const params = [sourceId, SYNC_IMPORT_PROVENANCE_OP, `${sourceId}:${incarnation}:`];
  type Raw = Omit<PageRow, 'record' | 'arm1' | 'attested_hash'> & { has_record: boolean; rec_origin_same: boolean; rec_origin: string | null; rec_blob_oid: string | null;
    rec_disk_same: boolean; rec_disk_blob_oid: string | null; rec_revision_null: boolean; rec_revision: string | null; rec_parser: string | null; rec_full_episode: string | null };
  const rows: PageRow[] = [];
  const parsers = new Map<string, SyncImportProvenance['parser'] | undefined>();
  const parserOf = (text: string | null) => {
    if (text === null) return undefined;
    if (!parsers.has(text)) parsers.set(text, JSON.parse(text) ?? undefined);
    return parsers.get(text);
  };
  const take = (page: Raw[]) => {
    for (const raw of page) rows.push({ id: raw.id, slug: raw.slug, source_path: raw.source_path, revision: raw.revision, deleted: raw.deleted, request_id: raw.request_id,
      arm1: null, attested_hash: null, record: raw.has_record ? { origin: raw.rec_origin_same ? raw.source_path : raw.rec_origin ?? '', blob_oid: raw.rec_blob_oid ?? undefined,
        disk_blob_oid: raw.rec_disk_same ? raw.rec_blob_oid : raw.rec_disk_blob_oid, revision: raw.rec_revision_null ? undefined : raw.rec_revision ?? raw.revision,
        parser: parserOf(raw.rec_parser), full_episode: raw.rec_full_episode } : null });
  };
  let statements = 0;
  if (kind === 'postgres') {
    await exec.executeRaw('SET LOCAL cursor_tuple_fraction = 1');
    await exec.executeRaw(`DECLARE sync_pass_pages NO SCROLL CURSOR FOR ${select}`, params);
    statements += 2;
    const fetch = () => { statements++; return exec.executeRaw<Raw>(`FETCH ${POSTGRES_FETCH_ROWS} FROM sync_pass_pages`); };
    let next = fetch();
    for (;;) {
      const page = await next;
      const more = page.length === POSTGRES_FETCH_ROWS;
      if (more) next = fetch();
      take(page);
      if (!more) return { rows, statements };
    }
  }
  let after = 0;
  for (;;) {
    statements++;
    const page = await exec.executeRaw<Raw>(`${select} AND p.id>$4 ORDER BY p.id LIMIT ${PGLITE_KEYSET_ROWS}`, [...params, after]);
    take(page);
    if (page.length < PGLITE_KEYSET_ROWS) return { rows, statements };
    after = Number(page[page.length - 1]!.id);
  }
}

/**
 * `A` for the given pages: whether the page's current revision came from a committed sync write of this incarnation (arm 1)
 * and the hash its Git effect expects. A committed request and its effect never change, so this reads by the request id
 * the snapshot returned, after the level is known; the answer is the one the snapshot would have given.
 */
async function readAttestations(exec: Exec, kind: 'postgres' | 'pglite', sourceId: string, incarnation: string, rows: PageRow[]): Promise<number> {
  const size = kind === 'postgres' ? 10_000 : PGLITE_KEYSET_ROWS;
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  let statements = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    statements++;
    const found = await exec.executeRaw<{ page_id: number; arm1: boolean; attested_hash: string | null }>(`SELECT x.page_id,
        (r.intent->>'kind' = ANY($3::text[]) AND r.source_incarnation::text=$2 AND (r.page_id IS NULL OR r.page_id=x.page_id)) AS arm1,
        (SELECT e.data->>'expected_hash' FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.revision=x.revision
          AND e.data->>'expected_hash' IS NOT NULL AND (e.data->>'relative_path'=x.source_path OR right(e.data->>'relative_path', length(x.source_path)+1)='/'||x.source_path) LIMIT 1) AS attested_hash
      FROM unnest($4::int[], $5::uuid[], $6::uuid[], $7::text[]) AS x(page_id, request_id, revision, source_path)
      JOIN persistence_requests r ON r.id=x.request_id AND r.state='committed' AND r.source_id=$1`,
      [sourceId, incarnation, SYNC_WRITE_KINDS, chunk.map(row => Number(row.id)), chunk.map(row => row.request_id), chunk.map(row => row.revision), chunk.map(row => row.source_path)]);
    for (const hit of found) Object.assign(byId.get(Number(hit.page_id))!, { arm1: hit.arm1, attested_hash: hit.attested_hash });
  }
  return statements;
}

/** `U_db`: open requests of the worktree (the `persistence_requests_pending` index) and pending Git effects of the source. */
async function readOpenWork(exec: Exec, sourceId: string, incarnation: string, worktreeId: string): Promise<{ pageIds: Set<number>; origins: Set<string>; statements: number }> {
  // A write admitted with sync.write_through=false carries no worktree (page-mutations.ts), so the incarnation's
  // worktree-less requests are open work too.
  const [requests, effects] = await Promise.all([exec.executeRaw<{ page_id: number | null; source_path: string | null; path: string | null }>(`SELECT page_id, intent->>'sourcePath' AS source_path, intent->>'path' AS path
    FROM persistence_requests WHERE state IN ('queued','running','recovering') AND source_id=$2 AND (worktree_id=$1 OR worktree_id IS NULL AND source_incarnation=$3::uuid)`,
    [worktreeId, sourceId, incarnation]),
  exec.executeRaw<{ page_id: number | null; path: string | null }>(`SELECT r.page_id, e.data->>'relative_path' AS path
    FROM persistence_requests r JOIN persistence_effects e ON e.request_id=r.id
    WHERE r.worktree_id=$1 AND r.source_id=$2 AND e.kind='git' AND e.state IN ('queued','running')`, [worktreeId, sourceId])]);
  const pageIds = new Set<number>(), origins = new Set<string>();
  for (const row of [...requests, ...effects]) if (row.page_id != null) pageIds.add(Number(row.page_id));
  for (const row of requests) for (const origin of [row.source_path, row.path]) if (origin) origins.add(syncOriginPath(origin));
  for (const row of effects) if (row.path) origins.add(syncOriginPath(row.path));
  return { pageIds, origins, statements: 2 };
}

/** Deletion markers of the incarnation (a primary-key range read); none exist before PR 4b. */
async function readMarkers(exec: Exec, sourceId: string, incarnation: string): Promise<Map<string, { kind: 'deleted' | 'legacy'; blobOids: string[]; deletion: string | null }>> {
  const prefix = `${sourceId}:${incarnation}:`;
  // `starts_with`, not a range: under a linguistic collation (en_US) a `< prefix || U+FFFF` bound matches nothing.
  const rows = await exec.executeRaw<{ fingerprint: string; value: { kind?: string; blob_oids?: unknown; deletion?: unknown } | null }>(
    'SELECT fingerprint, completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND starts_with(fingerprint, $2)',
    [SYNC_ORIGIN_DELETED_OP, prefix]);
  return new Map(rows.map(row => [syncOriginPath(row.fingerprint.slice(prefix.length)), {
    kind: row.value?.kind === 'legacy' ? 'legacy' as const : 'deleted' as const,
    blobOids: Array.isArray(row.value?.blob_oids) ? (row.value!.blob_oids as unknown[]).filter((oid): oid is string => typeof oid === 'string') : [],
    deletion: typeof row.value?.deletion === 'string' ? row.value.deletion : null }]));
}

/**
 * Design §2.7 with the parent's b1 ruling: a page-less path unchanged since the baseline is a page deleted before PR 4 only
 * when a committed deleting request of this incarnation names the slug its path imports to (the newest one is the proof). A
 * file sync refused before it ever had a page has none, so it imports.
 */
async function readLegacyDeletions(exec: Exec, sourceId: string, incarnation: string, slugs: string[]): Promise<Map<string, string>> {
  if (!slugs.length) return new Map();
  const rows = await exec.executeRaw<{ slug: string; id: string }>(`SELECT DISTINCT ON (slug) slug, id::text AS id FROM persistence_requests
    WHERE source_id=$1 AND source_incarnation=$2::uuid AND state='committed' AND slug=ANY($3::text[])
      AND (operation='delete_page' OR intent->>'kind'='managed_sync_delete') ORDER BY slug, sequence DESC`, [sourceId, incarnation, slugs]);
  return new Map(rows.map(row => [row.slug, row.id]));
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

/**
 * #6712 PR 4b (design v3.2 §2.2): a working-mode idle tick's check. Every path the cache vouches for, plus `U` (untracked)
 * and the index's paths in scope, is re-stat'd (`workingChanged`); no cache (a cold process) reads as changed.
 */
export async function workingIdleChange(context: Pick<ManagedSyncContext, 'root' | 'gitRoot'>, cache: WorkingStatCache | null): Promise<{ changed: boolean; cache: WorkingStatCache | null }> {
  if (!cache) return { changed: true, cache: null };
  const scope = relative(realpathSync.native(context.gitRoot), realpathSync.native(context.root)).split(sep).join('/');
  const [untracked, index] = await Promise.all([readUntracked(context.gitRoot, scope), readIndexLevel(context.gitRoot)]);
  const inScope = (path: string) => !scope || path.startsWith(`${scope}/`);
  const checked = workingChanged(cache, [...untracked, ...[...index.keys()].filter(inScope)]);
  return { changed: checked.cache === null || checked.changed.length > 0, cache: checked.cache };
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
export async function readShadowLevel(engine: BrainEngine, input: { sourceId: string; full?: boolean; workingTree?: boolean; context?: ManagedSyncContext; pass?: PassLevelInput }): Promise<ShadowLevel | null> {
  const total = timer();
  const timings: Record<string, number> = {};
  let t = timer();
  const context = input.context ?? await resolveManagedSyncContext(engine, { sourceId: input.sourceId, noPull: true, dryRun: true });
  timings.context = t();
  const { sourceId, incarnation, root, gitRoot } = context;
  const engineKind = engine.kind === 'pglite' ? 'pglite' : 'postgres';
  const nativeRoot = realpathSync.native(root), nativeGitRoot = realpathSync.native(gitRoot);
  const scope = relative(nativeGitRoot, nativeRoot).split(sep).join('/');
  // The setup reads are independent: one round trip each, all in flight together.
  t = timer();
  const [company, slugModeRead, excludeRead, includeHiddenRead, workingRead, packRead, mirrorRead] = await Promise.allSettled([
    currentCompanyBrainSync(sourceId) ? Promise.resolve(true) : getCompanyBrainProfile(engine, sourceId).then(profile => !!profile),
    scope && input.pass?.slugMode ? Promise.resolve(input.pass.slugMode) : scope ? resolveSlugRootMode(engine, { sourceId, explicitGitRoot: false, slugPrefix: resolveSlugForPath(join(scope, 'x.md')).slice(0, -2), dryRun: true }) : Promise.resolve('git-root' as const),
    syncExcludePatterns(engine, [...input.pass?.exclude ?? []]),
    engine.getConfig('sync.include_hidden'),
    input.workingTree === undefined ? engine.getConfig('sync.include_working_tree') : Promise.resolve(null),
    input.pass?.noSchemaPack ? Promise.resolve(null) : loadActivePackForEngine(engine, { remote: false, sourceId }).catch(() => null),
    sourceMirrorReadOnly(engine, sourceId),
  ]);
  timings.setup = t();
  const settled = <T>(read: PromiseSettledResult<T>): T => { if (read.status === 'rejected') throw read.reason; return read.value; };
  if (settled(company)) return null;
  const slugMode = settled(slugModeRead), exclude = settled(excludeRead), pack = settled(packRead), mirror = settled(mirrorRead);
  const strategy = input.pass?.strategy ?? (context.source.config?.strategy as string | undefined) ?? 'markdown';
  const includeHidden = [...new Set([...input.pass?.includeHidden ?? [], ...(settled(includeHiddenRead) ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)].map(v => v.endsWith('/') ? `${v}**` : v))];
  const keepDbPrefixes = (() => { try { return loadStorageConfig(root)?.keep_db ?? []; } catch { return []; } })();
  const sourceRelative = (gitPath: string) => (scope ? gitPath.slice(scope.length + 1) : gitPath);
  // Eligibility of a path outside the cached tree (every path of the tree is eligible); origins validate per call: a
  // 600k-path level keeps no per-path memo of either.
  const eligible = (gitPath: string) => (!scope || gitPath.startsWith(`${scope}/`)) && !matchesAnyGlob(sourceRelative(gitPath), exclude)
    && !isReservedSkillBundlePath(slugMode === 'source-root' ? sourceRelative(gitPath) : gitPath) && isSyncable(gitPath, { strategy: strategy as 'markdown', includeHidden });
  const originPath = (path: string) => syncOriginPath(path);
  const originOf = (gitPath: string) => originPath(slugMode === 'source-root' && scope ? sourceRelative(gitPath) : gitPath);
  const gitPathOf = (origin: string) => { const o = originPath(origin); return slugMode === 'source-root' && scope ? `${scope}/${o}` : o; };
  const step = loopYield();

  t = timer();
  const head = revParse(gitRoot, 'HEAD');
  if (!head) throw new Error(`source ${sourceId}: HEAD does not name a commit, so there is no level to read`);
  // Master's rule (sync-discovery.ts): a detached HEAD forces working mode.
  const detached = syncGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD';
  const working = detached || (input.workingTree ?? settled(workingRead) === 'true');
  const mode: 'committed' | 'working' = working ? 'working' : 'committed';
  timings.rev_parse = t();

  // A commit's tree never changes: the pass's next round at the same commit and selection reuses the eligible tree.
  const treeKey = JSON.stringify([gitRoot, head, scope, slugMode, strategy, exclude, includeHidden]);
  const cache = input.pass?.cache;
  const eligibleTree = async (): Promise<Map<string, GitTreeEntry>> => {
    if (cache?.tree?.key === treeKey) return cache.tree.tree;
    if (cache) cache.tree = undefined;
    const tree = new Map<string, GitTreeEntry>();
    for (const [path, entry] of await readTreeLevel(gitRoot, head, scope)) {
      if (eligible(path)) tree.set(path, entry);
      if (step.due()) await step.pause();
    }
    if (cache) cache.tree = { key: treeKey, tree };
    return tree;
  };
  // The Git level, the database snapshot and the holds are independent reads: they overlap, so each key times its own
  // read and `reads` is the wall time of the three together.
  const timed = async <T>(key: string, read: () => Promise<T>): Promise<T> => { const st = timer(); try { return await read(); } finally { timings[key] = st(); } };
  t = timer();
  const [gitLevel, snapshot, held] = await Promise.all([
    // Working mode reads the whole index (its paths join the domain); committed mode only where it differs from T, read
    // after T so the two are never held whole together.
    Promise.all([timed('T', eligibleTree).then(async tree => ({ tree, indexDelta: mode === 'committed' ? await timed('X', () => readIndexDelta(gitRoot, tree)) : null })),
      mode === 'working' ? timed('X', () => readIndexLevel(gitRoot)) : Promise.resolve(new Map<string, GitIndexEntry>()),
      timed('U', async () => (mode === 'working' ? (await readUntracked(gitRoot, scope)).filter(eligible) : []))]),
    // Issued together, the snapshot's statements pipeline on its one connection (PGLite runs them in turn).
    timed('I⋈P', () => withRoundSnapshot(engine, async exec => {
      const [read, work, markers, passRow] = await Promise.all([timed('pages', () => readPages(exec, engineKind, sourceId, incarnation)),
        timed('open_work', () => readOpenWork(exec, sourceId, incarnation, context.binding.worktree_id)), timed('markers', () => readMarkers(exec, sourceId, incarnation)),
        timed('pass_row', () => readPassRow(exec, sourceId, incarnation))]);
      return { pages: read.rows, open: work, markers, passRow, statements: read.statements + work.statements + 2 };
    })),
    timed('H', async () => {
      const [sourceHolds, retryPaths] = await Promise.all([readGitSourceHolds(engine, { sourceIds: [sourceId] }), readGitHoldRetryPaths(engine, sourceId, incarnation)]);
      const holds = (sourceHolds[0]?.holds ?? []).filter(hold => hold.incarnation === incarnation);
      const holdByPath = new Map(holds.map(hold => [hold.path, hold]));
      const [basisMoved, driftMoved] = await Promise.all([holdBasisMoved(engine, sourceId, holdByPath, [...holdByPath.keys()]), movedDriftHolds(engine, sourceId, holds)]);
      return { holds, retry: new Set(retryPaths.filter(path => !input.pass?.retryConsumed?.has(path))), moved: [...basisMoved, ...driftMoved] };
    }),
  ]);
  timings.reads = t();
  const [{ tree, indexDelta }, index, untrackedPaths] = gitLevel;
  // Committed mode: the index entry of a tree path, its own where it differs from T, else T's at stage 0 (undefined: absent).
  const indexed = (path: string): GitIndexEntry | undefined => {
    if (!indexDelta) return index.get(path);
    const delta = indexDelta.get(path);
    if (delta !== undefined) return delta ?? undefined;
    const committed = tree.get(path);
    return committed ? { ...committed, stage: 0 } : undefined;
  };
  const inLevel = (path: string) => tree.has(path) || eligible(path);
  const untracked = new Set(untrackedPaths);
  const { open, markers, passRow, statements } = snapshot;
  const { holds, retry } = held;
  const toGit = (holdPath: string) => (scope ? `${scope}/${holdPath}` : holdPath);
  const holdByGitPath = new Map<string, GitHoldRecord>(holds.map(hold => [toGit(hold.path), hold]));
  const moved = new Set(held.moved.map(toGit));

  // The page claiming each origin: the live one first, else the newest tombstone. The rows leave the snapshot's result
  // here (the driver's transaction keeps that object until its connection's next one), so only `byOrigin` holds them.
  t = timer();
  const byOrigin = new Map<string, PageRow>();
  for (const row of snapshot.pages) {
    const key = gitPathOf(row.source_path);
    const prior = byOrigin.get(key);
    if (!prior || (prior.deleted && !row.deleted) || (prior.deleted === row.deleted && Number(row.id) > Number(prior.id))) byOrigin.set(key, row);
    if (step.due()) await step.pause();
  }
  snapshot.pages = [];
  const domain = new Set<string>();
  for (const path of tree.keys()) { domain.add(path); if (step.due()) await step.pause(); }
  for (const path of untracked) domain.add(path);
  if (mode === 'working') for (const path of index.keys()) if (inLevel(path)) domain.add(path);
  let reconcilable = 0;
  for (const [path, row] of byOrigin) {
    if (!inLevel(path)) continue;
    domain.add(path);
    if (!row.deleted) reconcilable++;
    if (step.due()) await step.pause();
  }
  for (const origin of markers.keys()) { const path = gitPathOf(origin); if (inLevel(path)) domain.add(path); }
  // Spellings of one origin that differ only by case or separator (the domain holds each path once).
  const fold = (path: string) => path.replaceAll('\\', '/').toLowerCase();
  const spellings = new Map<string, string | string[]>();
  // Files at L count, and so does a live page's separator-spelled origin; a case-only respelling whose old file this sync
  // removes is no refusal (discovery's one exception).
  for (const path of domain) {
    if (step.due()) await step.pause();
    const live = byOrigin.get(path);
    if (!tree.has(path) && !(mode === 'working' && (untracked.has(path) || index.has(path))) && !(live && !live.deleted && live.source_path.includes('\\'))) continue;
    const folded = fold(path);
    const prior = spellings.get(folded);
    spellings.set(folded, prior === undefined ? path : typeof prior === 'string' ? [prior, path] : [...prior, path]);
  }
  // As discovery does, only spellings that name one page are twins: a live origin's page slug, else the slug its path names.
  const twins = new Set<string>();
  for (const paths of spellings.values()) {
    if (typeof paths === 'string') continue;
    const slugOf = (path: string) => { const live = byOrigin.get(path); return live && !live.deleted ? live.slug : resolveSlugForPath(originOf(path)); };
    const bySlug = new Map<string, string[]>();
    for (const path of paths) bySlug.set(slugOf(path), [...bySlug.get(slugOf(path)) ?? [], path]);
    for (const group of bySlug.values()) if (group.length > 1) for (const path of group) twins.add(path);
  }
  spellings.clear();
  timings.domain = t();

  // Working mode rehashes every path (the full round's unconditional rehash); committed mode probes candidates only.
  t = timer();
  const hashed = mode === 'working' ? await hashWorkingLevel(root, gitRoot, [...domain], tree) : null;
  const probes = hashed?.probes ?? new Map();
  timings.Dp = t();

  const levelOf = (path: string, probe: { dp: string; rawOid: string | null; rawSha256: string | null } | undefined): string | null => {
    const committed = tree.get(path) ?? null;
    return mode === 'committed' ? committed?.oid ?? null
      : !probe || probe.dp === 'deleted' ? null
      : ['clean', 'clean_eol', 'clean_lfs'].includes(probe.dp) ? committed?.oid ?? probe.rawOid
      // A path in neither T nor the index (untracked) or only staged has no `deleted` verdict: no bytes and no file is absent.
      : probe.rawOid ?? (probe.rawSha256 === null && !readPresent(root, path, scope) ? null : `unreadable:${path}`);
  };
  // `A` only matters where the file or the database moved (no row settles on `fileSame ∧ dbSame` with a proof): read it
  // for those pages alone, so a converged source reads none. The same walk finds whether any path needs the baseline tree.
  t = timer();
  const unproven: PageRow[] = [];
  let wantBaseline = false;
  for (const [path, row] of byOrigin) {
    if (step.due()) await step.pause();
    const level = levelOf(path, probes.get(path));
    if (!row.deleted && row.record?.revision == null && level !== null && !recordOids(row.record).includes(level) && inLevel(path)) wantBaseline = true;
    if (row.request_id === null) continue;
    if (row.deleted || level === null || !recordOids(row.record).includes(level) || row.record?.revision == null || String(row.record.revision) !== row.revision) unproven.push(row);
  }
  const attestationStatements = unproven.length ? await readAttestations(engine, engineKind, sourceId, incarnation, unproven) : 0;
  timings.A = t();

  const baselineCommit = (context.source.last_commit && revParse(gitRoot, context.source.last_commit)) || null;
  // The baseline tree, read once when a page needs it (no record revision; design §2.3) or the bootstrap's legacy walk does,
  // so the classification itself never waits.
  let baselineTree: Map<string, GitTreeEntry> | null | undefined;
  const loadBaseline = async () => {
    if (baselineTree !== undefined || !baselineCommit) return;
    const bt = timer();
    baselineTree = await readTreeLevel(gitRoot, baselineCommit, scope).catch(() => null);
    timings.baseline = bt();
  };
  if (wantBaseline) await loadBaseline();
  const baselineOf = (path: string): string | null => baselineTree?.get(path)?.oid ?? null;

  const fp = (path: string) => syncImportParserFor(sourceRelative(path), pack?.identity ?? null);
  const stateOf = (path: string, dirty: SyncPathState['dirty'], probe: { dp: string; rawOid: string | null; rawSha256: string | null } | undefined): { state: SyncPathState; row?: PageRow; legacyPageless?: true } => {
    const committed = tree.get(path) ?? null;
    const row = byOrigin.get(path);
    const level = levelOf(path, probe);
    const origin = originOf(path);
    // Presence decides only rows 4-6 (a level of absent); a committed path in T is not read here (Dp covers it).
    const presentNow = mode === 'working' ? level !== null : level === null ? readPresent(root, path, scope) : true;
    const record = row?.record ?? null;
    const recordBlobOids = recordOids(record, level);
    const attested = row && (row.arm1 || row.attested_hash) ? { hash: row.attested_hash ?? null, arm1: row.arm1 === true } : null;
    const hold = holdByGitPath.get(path);
    const marker = markers.get(origin) ?? null;
    const deletion = !row && !marker && level !== null ? legacyDeletions.get(path) : undefined;
    const virtualMarker: SyncPathState['marker'] = deletion ? { kind: 'legacy', blobOids: [level!], deletion } : null;
    const legacyPageless = deletion ? true as const : undefined;
    const needsBaseline = row && !row.deleted && (record?.revision == null) && level !== null && !recordBlobOids.includes(level);
    const state: SyncPathState = {
      mode, tree: committed?.oid ?? null, level, present: presentNow, dirty, diskOid: probe?.rawOid ?? null,
      page: row ? { live: !row.deleted, revision: row.revision, originMatches: !!record && (record.origin === row.source_path || originPath(record.origin) === originPath(row.source_path)) } : null,
      record: record ? { blobOids: recordBlobOids, revision: record.revision != null ? String(record.revision) : null, parserSame: sameParser(record.parser, fp(path)) } : null,
      attested, levelSha256: probe?.rawSha256 ?? null,
      published: !!attested?.hash && probe?.rawSha256 === attested.hash,
      hold: hold ? { atLevel: holdAtLevel(hold, level, probe?.rawSha256 ?? null) && !moved.has(path), rescreenDue: holdRescreenDue(hold, retry.has(hold.path)), retried: retry.has(hold.path) } : null,
      marker: marker ?? virtualMarker, baseline: needsBaseline ? baselineOf(path) : null,
      spelling: twins.has(path),
      episodeUnsatisfied: input.pass ? !!input.pass.episodeFullId && !!row && !row.deleted && record?.full_episode !== input.pass.episodeFullId
        : input.full === true && !!row && !row.deleted,
      fullObligation: input.pass ? !!input.pass.episodeFullId : input.full === true,
      keepDb: !mirror && keepDbPrefixes.length > 0 && !!row && isKeepDbSlug(row.slug, keepDbPrefixes),
      openWork: !!row && open.pageIds.has(Number(row.id)) || open.origins.has(origin),
    };
    return { state, ...(row ? { row } : {}), ...(legacyPageless ? { legacyPageless } : {}) };
  };

  // Bootstrap (the incarnation's first pass; for a read-only level, no pass row yet): page-less paths at their baseline blob
  // whose slug a committed deletion names get a `legacy` marker (§2.7, b1).
  t = timer();
  const legacyDeletions = new Map<string, string>();
  if (baselineCommit && (input.pass ? input.pass.bootstrap === true : !passRow)) {
    const pageless: Array<{ path: string; slug: string }> = [];
    for (const path of domain) {
      if (step.due()) await step.pause();
      if (byOrigin.has(path) || markers.has(originOf(path))) continue;
      const level = levelOf(path, probes.get(path));
      if (level === null) continue;
      await loadBaseline();
      if (level !== baselineOf(path)) continue;
      const slug = resolveSlugForPath(originOf(path));
      if (slug) pageless.push({ path, slug });
    }
    const bySlug = await readLegacyDeletions(engine, sourceId, incarnation, [...new Set(pageless.map(entry => entry.slug))]);
    for (const { path, slug } of pageless) { const id = bySlug.get(slug); if (id) legacyDeletions.set(path, id); }
    timings.legacy = t();
  }

  t = timer();
  const paths: ShadowPath[] = [];
  const candidates: string[] = [], candidateAt: number[] = [];
  const settledBeforeDirtiness = new Set(['held', 'spelling', 'untracked', 'kept', 'delete', 'delete_drift', 'gone', 'deleted_same', 'deleted_edited', 'legacy_same', 'matched']);
  const shared = { mode, fullObligation: input.pass ? !!input.pass.episodeFullId : input.full === true };
  for (const path of await sortYielding([...domain], step)) {
    if (step.due()) await step.pause();
    const probe = probes.get(path);
    const { state, row, legacyPageless } = stateOf(path, mode === 'committed' && tree.has(path) ? 'clean' : null, probe);
    const result = sharedResult(classifySyncPath(state));
    // Rows 1-10 precede row 11 and `matched` settles either way, so only the rest are Dp candidates (design v3.2 §2.1).
    const staged = mode === 'committed' && tree.has(path) && !!indexDelta?.has(path) && (indexed(path)?.oid !== tree.get(path)!.oid || (indexed(path)?.stage ?? 0) !== 0);
    const revision = row?.revision ?? null;
    if (mode === 'committed' && tree.has(path) && (!settledBeforeDirtiness.has(result.cls) || staged)) { candidates.push(path); candidateAt.push(paths.length); }
    else {
      // The row's fields the level keeps are copied onto the entry; only a candidate's row is read again (its dirtiness re-classifies it).
      byOrigin.delete(path);
      if (result.cls === 'matched' && !legacyPageless && MatchedPath.fits(state, revision, shared)) {
        paths.push(new MatchedPath(path, row!.slug, Number(row!.id), revision, result, state.tree, state.level!, state.dirty, state.record!.blobOids.length === 2, shared));
        continue;
      }
    }
    paths.push({ path, slug: row?.slug ?? null, pageId: row ? Number(row.id) : null, revision, state, result, ...(legacyPageless ? { legacyPageless } : {}) });
  }
  timings.classify = t();
  if (candidates.length) {
    t = timer();
    const candidateIndex = new Map<string, GitIndexEntry>();
    for (const path of candidates) { const entry = indexed(path); if (entry) candidateIndex.set(path, entry); }
    const probed = await probeDirtiness(root, gitRoot, candidates, tree, candidateIndex);
    timings.Dp = (timings.Dp ?? 0) + t();
    t = timer();
    for (const [k, path] of candidates.entries()) {
      if (step.due()) await step.pause();
      const probe = probed.get(path);
      const i = candidateAt[k]!;
      const { state } = stateOf(path, (probe?.dp ?? 'unknown') as SyncPathState['dirty'], probe);
      paths[i] = { ...paths[i]!, state, result: sharedResult(classifySyncPath(state)) };
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
  timings.total = total();
  return { sourceId, incarnation, root, gitRoot, scope, slugMode, mode, head, baselineCommit, full: input.full === true, kind: kind.kind, kindBlockers: kind.blockers,
    heldRenames: holds.flatMap(hold => hold.meta.rename_from ? [{ path: toGit(hold.path), rename: hold.meta.rename_from }] : []),
    releasableHolds: holds.filter(hold => !domain.has(toGit(hold.path))).map(hold => hold.path),
    paths, reconcilable, timings_ms: timings, statements: statements + attestationStatements + 3, pack: pack?.identity ?? null,
    selection: { exclude: [...exclude].sort(), includeHidden: [...includeHidden].sort(), strategy, srcSubpath: scope || null, mode },
    rescreenDue: holds.filter(hold => holdRescreenDue(hold, retry.has(hold.path))).map(hold => toGit(hold.path)), workingCache: hashed?.cache ?? null };
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
 * (a range on the unique `sequence` index), the open-set probe (`persistence_requests_pending`, plus
 * `persistence_requests_database_pending` for the source's write-through-off requests, which carry no worktree) and the
 * pass row; both request probes count those requests too. PR 4a
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
  // The pass row, the request probe above its watermark and the open-set probe are one statement (one round trip).
  t = timer();
  const probe = await passIdleProbe(engine, { sourceId: context.sourceId, incarnation: context.incarnation, worktreeId: context.binding.worktree_id,
    requestHwm: input.assumeConverged?.requestHwm ?? null, openAtStamp: [] });
  timings.probes = t();
  const row = probe.passRow;
  const stored = (row?.obligations as { converged?: { target: string; request_hwm: string } } | undefined)?.converged;
  const converged = input.assumeConverged ?? (stored ? { target: String(stored.target), requestHwm: Number(stored.request_hwm) } : null);
  const newer = probe.newer, pending = probe.pending;
  const kind = syncPassKind({ converged: converged ? { target: converged.target, parserFp: '', pack: null, selectionFp: '', passesSinceFull: 0, lastFullAt: Date.now() } : null,
    head: head ?? '', parserFp: '', pack: null, selectionFp: '', now: Date.now(), openEpisode: false, owedTail: false, retryRow: false, notConvergedStreak: 0, mismatchStreak: 0,
    requestNewer: newer, openAtStampFinished: pending && !input.assumeConverged, workingChange: false, rescreenDueHold: false, full: false });
  timings.total = total();
  return { idle: kind.kind === 'idle', reasons: kind.blockers, timings_ms: timings, rows: (newer ? 1 : 0) + (pending ? 1 : 0) + (row ? 1 : 0) };
}

/**
 * #6712 PR 4b (design v3.2 §2.2): the idle tick's database reads in one statement: the pass row, whether a request of the
 * worktree is newer than the converged watermark (a range on the unique `sequence` index; `requestHwm` overrides the
 * row's), whether any request is open (`persistence_requests_pending`), and how many of the ids recorded in
 * `converged.open_at_stamp` are still open (`r:<request>` requests, `e:<effect>` Git effects; `openAtStamp` null reads the
 * row's, so the probe needs no earlier read of the row).
 */
export async function passIdleProbe(engine: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; incarnation: string; worktreeId: string;
  requestHwm: string | number | null; openAtStamp: readonly string[] | null }): Promise<{ passRow: Record<string, unknown> | null; newer: boolean; pending: boolean; stillOpen: number }> {
  const [probe] = await engine.executeRaw<{ pass_row: Record<string, unknown> | null; newer: boolean; pending: boolean; still_open: number | string }>(`WITH pass AS (
      SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2),
    stamp AS (SELECT unnest(COALESCE($5::text[], ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(value->'obligations'->'converged'->'open_at_stamp')='array'
      THEN value->'obligations'->'converged'->'open_at_stamp' ELSE '[]'::jsonb END) FROM pass))) AS id)
    SELECT (SELECT value FROM pass) AS pass_row,
      EXISTS (SELECT 1 FROM persistence_requests WHERE sequence > COALESCE($3::bigint, ((SELECT value FROM pass)->'obligations'->'converged'->>'request_hwm')::bigint, 0)
        AND (worktree_id = $4 OR worktree_id IS NULL AND source_id = $6 AND source_incarnation = $7::uuid)) AS newer,
      EXISTS (SELECT 1 FROM persistence_requests WHERE state IN ('queued','running','recovering') AND (worktree_id = $4 OR worktree_id IS NULL AND source_id = $6 AND source_incarnation = $7::uuid)) AS pending,
      (SELECT count(*) FROM persistence_requests WHERE state IN ('queued','running','recovering') AND (worktree_id = $4 OR worktree_id IS NULL AND source_id = $6 AND source_incarnation = $7::uuid)
        AND 'r:'||request_id::text IN (SELECT id FROM stamp))
        + (SELECT count(*) FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
            WHERE r.worktree_id = $4 AND e.kind = 'git' AND e.state IN ('queued','running') AND 'e:'||e.id::text IN (SELECT id FROM stamp)) AS still_open`,
    [MANAGED_SYNC_PASS_OP, `${input.sourceId}:${input.incarnation}`, input.requestHwm, input.worktreeId, input.openAtStamp ? [...input.openAtStamp] : null, input.sourceId, input.incarnation]);
  return { passRow: probe?.pass_row ?? null, newer: probe?.newer === true, pending: probe?.pending === true, stillOpen: Number(probe?.still_open ?? 0) };
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
