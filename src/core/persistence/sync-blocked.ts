/**
 * #6858 ask 3: the managed sync runs that are stopped, not draining. An unfinished cursor whose stop is recorded (a
 * `managed-sync-failure` row under its key) or whose pending page receipt ended without committing resumes nothing by
 * itself; doctor `managed_sync_blocked` and get_brain_health read it. An unfinished cursor waiting on a queued or
 * running request (`sync_incomplete`) is draining and not listed, and a failure whose cursor is gone is an orphan
 * (`gbrain repair managed-sync-orphans`), not a blocked run.
 */
import type { BrainEngine } from '../engine.ts';
import { readManagedSyncFailures } from './sync-failures.ts';

/** A run blocked longer than this fails doctor `managed_sync_blocked` and turns get_brain_health to `attention`. */
export const MANAGED_SYNC_BLOCKED_FAIL_MS = 60 * 60_000;

export interface BlockedManagedSync { source_id: string; code: string; run_id: string; blocked_since: string }

export async function readBlockedManagedSyncs(engine: BrainEngine, sourceIds?: string[]): Promise<BlockedManagedSync[]> {
  const cursors = new Set((await engine.executeRaw<{ fingerprint: string }>(
    "SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync' AND COALESCE(completed_keys->0->>'done','false')<>'true'")).map(row => row.fingerprint));
  return (await readManagedSyncFailures(engine, sourceIds))
    .filter(failure => failure.code !== 'sync_incomplete' && cursors.has(failure.cursor_key))
    .map(failure => ({ source_id: failure.source_id, code: failure.code, run_id: failure.run_id, blocked_since: failure.first_seen }));
}
