/**
 * #5409: a per-source read-only mirror (`sources.config.mirror_read_only`,
 * default false, set by `gbrain sources mirror-readonly|mirror-writable`).
 * The source's Git remote is authoritative: managed publication never writes
 * a file into its checkout. Sync imports canonical metadata database-only, and
 * a page write into the source is stored database-only (`storage:
 * "database_only"` on the receipt), so `git pull --ff-only` keeps working.
 */
import type { SqlEngine } from './model.ts';

export async function sourceMirrorReadOnly(engine: SqlEngine, sourceId: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ read_only: boolean }>(
    "SELECT COALESCE(config->>'mirror_read_only','false')='true' AS read_only FROM sources WHERE id=$1", [sourceId]);
  return row?.read_only === true;
}
