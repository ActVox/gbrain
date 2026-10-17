/**
 * #6729: inexact Git renames a sync could not confirm (see sync-rename-identity.ts) were split into a delete plus an
 * add, so the old page's facts, links and aliases stay on its soft-deleted slug. Each one is recorded here until the
 * pair gets a disposition: `gbrain sync status --json` lists it, doctor `rename_identity_downgrades` names it, the purge
 * leaves its old page alone and the checkpoint sweep keeps the record while it is open, and the report names the
 * restore of the old page. There is no time window: a pair recorded before its remedy exists can still be repaired.
 *
 * One `op_checkpoints` row per old page (op `sync-identity-downgrade`, fingerprint = the old page id);
 * `completed_keys[0]` holds the record. A record is open while it has no `disposition` (set when the pair is remedied
 * or closed without merging) and its old page is still soft-deleted from that sync (`deleted_at` = `old_deleted_at`);
 * a restore, a purge or a later delete of the restored page closes it.
 */
import type { BrainEngine } from './engine.ts';
import { isConnectorSourceKind } from './persistence/connector-identity.ts';
import { getWorktreeBinding } from './persistence/ownership.ts';
import { readDatabaseOnlyActivatedSources } from './persistence/unbound-source.ts';
import { resolveSlugForPath, type DowngradedRename, type RenameDowngradeReason } from './sync.ts';

export const IDENTITY_DOWNGRADE_OP = 'sync-identity-downgrade';

export interface IdentityDowngrade extends DowngradedRename {
  source_id: string;
  /** The soft-deleted page the old file backed, and the page the new file imported to (null when it did not import). */
  old_slug: string; old_page_id: number; new_slug: string | null;
  /** What stays on the old slug: facts keyed to it, links from or to it, and its free-text aliases. */
  facts: number; links: number; aliases: number;
  /** When the old page was soft-deleted (ISO), and that `deleted_at` exactly as Postgres printed it (the open test). */
  recorded_at: string; old_deleted_at: string;
  /** Set when the pair is remedied or closed without merging; the record is then closed. */
  disposition?: { kind: 'remedied' | 'closed'; at: string };
  /** Read live: whether `gbrain restore` can write the old page back on this source (see `identityRestoreAvailable`). */
  restore_available?: boolean;
}

type RestoreProbeEngine = Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'kind'>;

/**
 * Whether a restore of a page that came from a canonical file can be admitted on this source, by the rule page writes
 * follow (decideUnboundWrite): a bound source, a connector source, a source with no checkout, or a PGLite source not
 * activated database-only can; an unbound Postgres source with a checkout refuses `owner_unavailable`, so no surface
 * offers the restore there.
 */
export async function identityRestoreAvailable(engine: RestoreProbeEngine, sourceId: string): Promise<boolean> {
  const [source] = await engine.executeRaw<{ local_path: string | null; kind: string | null }>("SELECT local_path, config->>'kind' AS kind FROM sources WHERE id = $1", [sourceId]);
  if (!source?.local_path || isConnectorSourceKind(source.kind)) return true;
  if (await getWorktreeBinding(engine as never, sourceId, null)) return true;
  return engine.kind === 'pglite' && !(await readDatabaseOnlyActivatedSources(engine)).includes(sourceId);
}

/** SQL: the downgrade record `dg` is open for the page aliased `alias` (no disposition, old page still soft-deleted by that sync). */
export const identityDowngradeOpen = (alias: string): string =>
  `dg.completed_keys->0->>'disposition' IS NULL AND ${alias}.deleted_at = (dg.completed_keys->0->>'old_deleted_at')::timestamptz`;

/** SQL predicate for a purge scan over `pages` aliased `alias`: the page has no open downgrade record. */
export function identityDowngradePurgeHold(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM op_checkpoints dg WHERE dg.op = '${IDENTITY_DOWNGRADE_OP}' AND dg.fingerprint = ${alias}.id::text
    AND ${identityDowngradeOpen(alias)})`;
}

const REASON_TEXT: Record<RenameDowngradeReason, string> = {
  id_conflict: 'the two files carry different frontmatter ids',
  id_shared: 'their frontmatter id is also carried by another file or page',
  id_one_side: 'only one side carries a frontmatter id',
  title_not_unique: 'their shared title is not unique',
  slug_not_unique: 'their shared slug: line is not unique',
  no_identity_signal: 'no frontmatter id, slug: or title matches',
};
export const identityDowngradeReasonText = (reason: RenameDowngradeReason): string => REASON_TEXT[reason];

/**
 * Records the downgraded pairs of a finished sync (paths in the source's origin form). A pair whose old page is not
 * soft-deleted (the delete did not land, or the old file never imported) has nothing to carry and is not recorded.
 */
export async function recordIdentityDowngrades(engine: BrainEngine, sourceId: string, pairs: DowngradedRename[]): Promise<IdentityDowngrade[]> {
  const records: IdentityDowngrade[] = [];
  for (const pair of pairs) {
    const [old] = await engine.executeRaw<{ id: number | string; slug: string; deleted_at: string }>(
      `SELECT id, slug, deleted_at::text AS deleted_at FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL
        AND (source_path = $2 OR (source_path IS NULL AND slug = $3)) ORDER BY deleted_at DESC LIMIT 1`,
      [sourceId, pair.from, resolveSlugForPath(pair.from)]);
    if (!old) continue;
    const [fresh] = await engine.executeRaw<{ slug: string }>(
      'SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND source_path = $2 LIMIT 1', [sourceId, pair.to]);
    const [counts] = await engine.executeRaw<{ facts: number | string; links: number | string; aliases: number | string }>(`SELECT
        (SELECT count(*) FROM facts WHERE source_id = $1 AND entity_slug = $2) AS facts,
        (SELECT count(*) FROM links WHERE from_page_id = $3 OR to_page_id = $3) AS links,
        (SELECT count(*) FROM page_aliases WHERE source_id = $1 AND slug = $2) AS aliases`, [sourceId, old.slug, Number(old.id)]);
    const recorded = new Date(old.deleted_at);
    const record: IdentityDowngrade = { source_id: sourceId, from: pair.from, to: pair.to, similarity: pair.similarity, reason: pair.reason, ...(pair.read ? { read: pair.read } : {}),
      old_slug: old.slug, old_page_id: Number(old.id), new_slug: fresh?.slug ?? null,
      facts: Number(counts?.facts ?? 0), links: Number(counts?.links ?? 0), aliases: Number(counts?.aliases ?? 0),
      recorded_at: recorded.toISOString(), old_deleted_at: old.deleted_at };
    await engine.executeRaw(`INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ($1, $2, $3::text::jsonb, now())
      ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()`,
      [IDENTITY_DOWNGRADE_OP, String(record.old_page_id), JSON.stringify([record])]);
    records.push(record);
  }
  return records;
}

/**
 * Open records (no disposition, old page still soft-deleted by that sync), oldest first; every source when `sourceIds` is omitted.
 * `new_slug` is read live: the live page at the new path now (a held new file that was fixed later counts once it imports).
 */
export async function listIdentityDowngrades(engine: RestoreProbeEngine, sourceIds?: readonly string[]): Promise<IdentityDowngrade[]> {
  const rows = await engine.executeRaw<{ record: IdentityDowngrade | string; new_slug: string | null }>(
    `SELECT dg.completed_keys->0 AS record, np.slug AS new_slug FROM op_checkpoints dg JOIN pages p ON p.id::text = dg.fingerprint
      LEFT JOIN LATERAL (SELECT slug FROM pages WHERE source_id = p.source_id AND deleted_at IS NULL AND source_path = dg.completed_keys->0->>'to' LIMIT 1) np ON true
      WHERE dg.op = $1 AND p.deleted_at IS NOT NULL AND ${identityDowngradeOpen('p')}
        AND p.source_id = dg.completed_keys->0->>'source_id' AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
      ORDER BY dg.completed_keys->0->>'recorded_at', dg.fingerprint`, [IDENTITY_DOWNGRADE_OP, sourceIds ? [...sourceIds] : null]);
  const records = rows.map(row => ({ ...(typeof row.record === 'string' ? JSON.parse(row.record) as IdentityDowngrade : row.record), new_slug: row.new_slug }));
  const restorable = new Map<string, boolean>();
  for (const sourceId of new Set(records.map(record => record.source_id))) restorable.set(sourceId, await identityRestoreAvailable(engine, sourceId));
  return records.map(record => ({ ...record, restore_available: restorable.get(record.source_id)! }));
}

/** A recorded downgrade (as opposed to a raw pair a sync has not recorded yet). */
export const isRecordedDowngrade = (entry: DowngradedRename): entry is IdentityDowngrade => 'old_page_id' in entry;

/**
 * After a sync that committed (synced or first sync, not a dry run): records its downgraded pairs, prints the report
 * lines, and returns the result with the recorded entries in place of the raw pairs. A recording failure is one line
 * and never fails the sync.
 */
export async function noteIdentityDowngrades<T extends { status: string; identityDowngrades?: DowngradedRename[] }>(engine: BrainEngine, sourceId: string,
  result: T, write: (line: string) => void): Promise<T> {
  const pairs = (result.identityDowngrades ?? []).filter(pair => !isRecordedDowngrade(pair));
  if (!pairs.length || !['synced', 'first_sync'].includes(result.status)) return result;
  try {
    const records = await recordIdentityDowngrades(engine, sourceId, pairs);
    const restore_available = await identityRestoreAvailable(engine, sourceId);
    for (const line of identityDowngradeLines(records.map(record => ({ ...record, restore_available })))) write(line);
    return { ...result, identityDowngrades: records };
  } catch (error) {
    write(`  Could not record ${pairs.length} rename(s) whose identity was not kept: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
}

/**
 * Restores one old page with its facts, links and aliases, beside the new page. Where the restore cannot re-create the
 * old file, it refuses `canonical_file_absent` and names `--detach` (database-only) as the user's choice.
 */
export const identityRestoreArgv = (record: Pick<IdentityDowngrade, 'source_id' | 'old_slug'>): string[] =>
  ['gbrain', 'restore', record.old_slug, '--source-id', record.source_id, '--force'];
/** The read-only listing of a source's open records. */
export const identityStatusArgv = (sourceId: string): string[] => ['gbrain', 'sync', 'status', '--source', sourceId, '--json'];

/** The sync report's lines for the downgraded pairs of one run. */
export function identityDowngradeLines(records: readonly IdentityDowngrade[]): string[] {
  if (!records.length) return [];
  return [
    ...records.map(record => `  Identity not kept: ${record.from} -> ${record.to} (git similarity ${record.similarity}%; ${REASON_TEXT[record.reason]}). `
      + `${record.facts} fact(s), ${record.links} link(s) and ${record.aliases} alias(es) stay on the soft-deleted ${record.old_slug}, which the purge keeps until the pair is settled; `
      + `${record.new_slug ? `${record.new_slug} starts fresh.` : 'the new file did not import.'}`
      + (record.restore_available === false ? '' : ` To keep the old page, restore it: ${identityRestoreArgv(record).join(' ')}`)),
    '  A move keeps its page when the files share a frontmatter id: (or a unique slug: line or title); to move and rewrite a page, move, commit and sync, then edit.',
  ];
}
