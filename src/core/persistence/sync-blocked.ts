/**
 * #6858 ask 3: the managed sync runs that are stopped, not draining. An unfinished cursor whose stop is recorded (a
 * `managed-sync-failure` row under its key) or whose pending page receipt ended without committing resumes nothing by
 * itself; doctor `managed_sync_blocked` and get_brain_health read it. An unfinished cursor waiting on a queued or
 * running request (`sync_incomplete`) is draining and not listed, and neither is a cursor saved after its recorded stop:
 * the failure row stays until the whole run finishes, so a resumed run that is moving again would otherwise still read
 * as blocked. A failure whose cursor is gone is an orphan (`gbrain repair managed-sync-orphans`), not a blocked run.
 * #6712 PR 4b (design v3.2 §3.7): a non-company source has a pass row instead; it is blocked while its passes keep
 * stopping (`passHealth`: the newest ended `blocked`, a `not_converged` streak, a `settle_mismatch` streak), with the
 * newest pass's stop reason as `code`, its pass id as `run_id` and `stuck_since` as `blocked_since`. A source listed by
 * its pass is not listed again by a legacy cursor.
 */
import type { BrainEngine } from '../engine.ts';
import { readManagedSyncFailures } from './sync-failures.ts';

/** A run blocked longer than this fails doctor `managed_sync_blocked` and turns get_brain_health to `attention`. */
export const MANAGED_SYNC_BLOCKED_FAIL_MS = 60 * 60_000;

export interface BlockedManagedSync { source_id: string; code: string; run_id: string; blocked_since: string }

export async function readBlockedManagedSyncs(engine: BrainEngine, sourceIds?: string[]): Promise<BlockedManagedSync[]> {
  const cursors = new Set((await engine.executeRaw<{ fingerprint: string }>(`
    SELECT c.fingerprint FROM op_checkpoints c LEFT JOIN op_checkpoints f ON f.op='managed-sync-failure' AND f.fingerprint=c.fingerprint
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true' AND (f.updated_at IS NULL OR f.updated_at>=c.updated_at)`)).map(row => row.fingerprint));
  const { readPassReadings, passStopCode, passStuck, passStuckSince } = await import('./sync-pass-readers.ts');
  const passes: BlockedManagedSync[] = (await readPassReadings(engine, { sourceIds, head: false })).filter(reading => passStuck(reading.health))
    .map(reading => ({ source_id: reading.source_id, code: passStopCode(reading), run_id: reading.row.value.telemetry.pass_id, blocked_since: passStuckSince(reading.row) }));
  const passSources = new Set(passes.map(blocked => blocked.source_id));
  return [...(await readManagedSyncFailures(engine, sourceIds))
    .filter(failure => failure.code !== 'sync_incomplete' && cursors.has(failure.cursor_key) && !passSources.has(failure.source_id))
    .map(failure => ({ source_id: failure.source_id, code: failure.code, run_id: failure.run_id, blocked_since: failure.first_seen })), ...passes];
}
