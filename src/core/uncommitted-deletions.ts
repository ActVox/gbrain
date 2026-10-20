/**
 * #7130: soft-deleted pages whose recorded file Git never held. Before #7130 a managed sync deleted a live page whose
 * recorded file was absent from the tree and the disk even when that file had never been committed (an agent's
 * write-through into a `.gitignore`d directory, an untracked file removed before any commit), so the tombstone may hold
 * the only copy of the page and the purge removes it for good after its retention window.
 *
 * One source is scanned on its canonical owner host only (the checkout and its `.gitignore` are read there): its
 * tombstones that still record a file (newest deletion first, at most `TOMBSTONE_SCAN_LIMIT`), the request that deleted
 * each (a committed `managed_sync_delete` request, or an `op_checkpoints` `sync-delete-tombstone` marker naming the page,
 * is a sync deletion), and, for at most `pathLimit` of them, sync deletions first, the Git evidence of the recorded file
 * (`readOriginEvidence` over HEAD's history, `sync-origin-evidence.ts`). A page is listed when `.gitignore` excludes its
 * file, or when no commit holds it and it is not on the disk. A path whose evidence could not be read is counted
 * `unknown`, never listed. Purged pages have no row left and are out of reach: only a backup brings them back.
 *
 * Readers: doctor `uncommitted_sync_deletions` and `gbrain repair uncommitted-deletions`.
 */
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { isOpPageSlug } from './ops/context.ts';
import { canonicalPath, sourceContext, type GhostOwner } from './ghost-pages.ts';
import { managedPersistenceEnabled } from './persistence/ownership.ts';
import { readOriginEvidence } from './persistence/sync-origin-evidence.ts';

/** `deleted_by: 'sync'` when a committed managed sync request (or a sync tombstone marker) deleted the page; `other` otherwise (a hand delete, a repair, an unknown writer). */
export interface UncommittedDeletion {
  source_id: string; slug: string; page_id: number; revision: string; source_path: string;
  /** The recorded file's path relative to the Git work tree. */
  git_path: string;
  deleted_at: string;
  evidence: 'ignored' | 'never_committed';
  deleted_by: 'sync' | 'other';
}

export interface UncommittedDeletionScan {
  source_id: string;
  status: 'known' | 'unknown' | 'not_applicable';
  /** 'not_managed' | 'not_applicable' | 'not_owner_host' | 'mirror_read_only' | 'storage_unavailable' | 'not_a_git_checkout' */
  reason?: string;
  pages: UncommittedDeletion[];
  /** Tombstones recording a file that were read. */
  tombstones: number;
  /** Tombstones whose file evidence was read (at most the path limit). */
  checked: number;
  /** Checked tombstones whose file Git once committed: not listed. */
  committed: number;
  /** Checked tombstones whose never-committed file is on the disk again: not listed. */
  file_present: number;
  /** Checked tombstones whose evidence could not be read: not listed. */
  unknown: number;
  truncated: boolean;
  owner?: GhostOwner;
  root?: string;
}

/** Tombstones read per source. */
export const TOMBSTONE_SCAN_LIMIT = 20_000;
/** File evidence the doctor reads per run, across sources (each 500 paths cost one `git log` and one `git check-ignore`). */
export const DOCTOR_PATH_LIMIT = 2_000;
export const SYNC_DELETE_TOMBSTONE_OP = 'sync-delete-tombstone';
export const PURGED_NOTE = 'Pages already purged cannot be restored by this command; only a backup (pg_dump, or gbrain backup create taken before the purge) can bring them back.';

interface TombstoneRow { id: number; slug: string; source_path: string; source_uri: string | null; deleted_at: Date | string; revision: string }

/** The tombstones a sync deleted: the newest deleting request of the slug is a managed sync delete, or a sync tombstone marker names the page. */
async function readSyncDeleted(engine: BrainEngine, sourceId: string, rows: TombstoneRow[]): Promise<Set<number>> {
  if (!rows.length) return new Set();
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const requests = source ? await engine.executeRaw<{ slug: string; kind: string | null }>(`SELECT DISTINCT ON (slug) slug, intent->>'kind' AS kind FROM persistence_requests
    WHERE source_id=$1 AND source_incarnation=$2::uuid AND state='committed' AND slug=ANY($3::text[])
      AND (operation='delete_page' OR intent->>'kind'='managed_sync_delete') ORDER BY slug, sequence DESC`, [sourceId, source.incarnation, rows.map(row => row.slug)]) : [];
  const bySync = new Set(requests.filter(row => row.kind === 'managed_sync_delete').map(row => row.slug));
  const markers = new Set((await engine.executeRaw<{ fingerprint: string }>('SELECT fingerprint FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])',
    [SYNC_DELETE_TOMBSTONE_OP, rows.map(row => String(row.id))])).map(row => row.fingerprint));
  return new Set(rows.filter(row => bySync.has(row.slug) || markers.has(String(row.id))).map(row => Number(row.id)));
}

/** One source's soft-deleted pages whose recorded file Git never held, sync deletions first. */
export async function scanUncommittedDeletions(engine: BrainEngine, sourceId: string, opts: { pathLimit: number }): Promise<UncommittedDeletionScan> {
  const scan: UncommittedDeletionScan = { source_id: sourceId, status: 'known', pages: [], tombstones: 0, checked: 0, committed: 0, file_present: 0, unknown: 0, truncated: false };
  if (!await managedPersistenceEnabled(engine)) return { ...scan, status: 'not_applicable', reason: 'not_managed' };
  const context = await sourceContext(engine, sourceId);
  if (!context.ok && context.status === 'not_applicable') return { ...scan, status: 'not_applicable', reason: context.reason };
  const rows = await engine.executeRaw<TombstoneRow>(`SELECT id, slug, source_path, source_uri, deleted_at, knowledge_revision::text AS revision FROM pages
    WHERE source_id=$1 AND deleted_at IS NOT NULL AND NULLIF(btrim(source_path), '') IS NOT NULL ORDER BY deleted_at DESC, id LIMIT ${TOMBSTONE_SCAN_LIMIT + 1}`, [sourceId]);
  scan.truncated = rows.length > TOMBSTONE_SCAN_LIMIT;
  const tombstones = rows.slice(0, TOMBSTONE_SCAN_LIMIT).filter(row => isOpPageSlug(row.slug));
  scan.tombstones = tombstones.length;
  if (!context.ok) return tombstones.length ? { ...scan, status: 'unknown', reason: context.reason } : scan;
  Object.assign(scan, { owner: context.owner, root: context.root });
  if (!tombstones.length) return scan;
  if (!context.gitScope) return { ...scan, status: 'not_applicable', reason: 'not_a_git_checkout' };
  const bySync = await readSyncDeleted(engine, sourceId, tombstones);
  const ordered = [...tombstones.filter(row => bySync.has(Number(row.id))), ...tombstones.filter(row => !bySync.has(Number(row.id)))];
  if (ordered.length > opts.pathLimit) scan.truncated = true;
  const gitRoot = resolve(context.root, ...context.gitScope.map(() => '..'));
  const candidates = ordered.slice(0, Math.max(0, opts.pathLimit)).flatMap(row => {
    const file = canonicalPath(context, row);
    const gitPath = relative(gitRoot, file).split(sep).join('/');
    return gitPath.startsWith('../') ? [] : [{ row, file, gitPath }];
  });
  scan.checked = candidates.length;
  const evidence = candidates.length ? await readOriginEvidence(gitRoot, ['HEAD'], candidates.map(candidate => candidate.gitPath)) : new Map();
  for (const { row, file, gitPath } of candidates) {
    const found = evidence.get(gitPath) ?? 'unknown';
    if (found === 'unknown') { scan.unknown++; continue; }
    if (found === 'committed') { scan.committed++; continue; }
    if (found === 'never_committed' && existsSync(file)) { scan.file_present++; continue; }
    scan.pages.push({ source_id: sourceId, slug: row.slug, page_id: Number(row.id), revision: row.revision, source_path: row.source_path, git_path: gitPath,
      deleted_at: new Date(row.deleted_at).toISOString(), evidence: found, deleted_by: bySync.has(Number(row.id)) ? 'sync' : 'other' });
  }
  return scan;
}
