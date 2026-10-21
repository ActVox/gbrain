/**
 * #7187: a drain lease's holder row (persistence/sync-lease.ts) is an `active` minion_jobs row in the
 * `gbrain-drain-lease` queue that no worker claims (attempts_started 0), renewed with the lease. It is not a job:
 * dead-lettering it (`attempts_made + 1`) breaks chk_attempts_order and aborts the whole sweep transaction, so the
 * stall sweep deletes one whose holder stopped renewing it and both sweeps leave the queue out of their candidates.
 */
import type { BrainEngine } from '../engine.ts';
import { LEASE_BEACON_QUEUE } from '../persistence/sync-lease.ts';
import { rowToMinionJob, type MinionJob } from './types.ts';

export { LEASE_BEACON_QUEUE as HOLDER_ROW_QUEUE };

/** Delete the holder rows whose lock expired more than `graceMs` ago; returns them. */
export async function releaseExpiredHolderRows(tx: Pick<BrainEngine, 'executeRaw'>, graceMs: number): Promise<MinionJob[]> {
  const rows = await tx.executeRaw<Record<string, unknown>>(
    `DELETE FROM minion_jobs WHERE id IN (
       SELECT id FROM minion_jobs WHERE queue = $1 AND status = 'active'
          AND lock_until < now() - ($2::double precision * interval '1 millisecond') FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [LEASE_BEACON_QUEUE, graceMs]);
  if (rows.length > 0) console.log(`Stall detector: dropped ${rows.length} drain-lease holder rows whose holder stopped renewing them`);
  return rows.map(rowToMinionJob);
}
