/**
 * The idempotency-key halves of `MinionQueue.add` (#5157 / #5114): the fast
 * path before any other admission work and the insert-race resolution after
 * `ON CONFLICT DO NOTHING`. Both apply `coalesceDecision` to the raw row, so
 * SQL NULL authority stays distinguishable from JSONB null.
 */
import type { BrainEngine } from '../engine.ts';
import { LEGACY_AUTHORITY_COLUMN, coalesceDecision, type SubmissionAuthority } from './submission-authority.ts';
import { rowToMinionJob, type MinionJob } from './types.ts';

const KEYED_ROW_SQL = `SELECT *, ${LEGACY_AUTHORITY_COLUMN} FROM minion_jobs WHERE idempotency_key = $1`;

function coalescedJob(row: Record<string, unknown>): MinionJob {
  const job = rowToMinionJob(row);
  job.coalesced = true;
  return job;
}

/**
 * Frees a dead or cancelled row's idempotency key so a fresh attempt can be
 * inserted, keeping the released key in its data for the dream breaker. The
 * update rechecks the key, the terminal status and the SQL NULL-ness of the
 * authority it was decided on, so a row reviewed or resubmitted in between
 * keeps its key and the caller's insert conflicts into the race path instead.
 */
async function releaseIdempotencyKey(tx: BrainEngine, row: Record<string, unknown>, key: string): Promise<void> {
  await tx.executeRaw(
    `UPDATE minion_jobs SET idempotency_key = NULL, data = data || $2::text::jsonb
      WHERE id = $1 AND idempotency_key = $3 AND status IN ('dead','cancelled')
        AND (submission_authority IS NULL) = $4::boolean`,
    [row.id, JSON.stringify({ __released_idempotency_key: key }), key, row.legacy_authority_is_null === true],
  );
}

/** Fast path: the row already holding `key`, coalesced, or null once a releasable key was freed (or none exists). */
export async function coalesceOnIdempotencyKey(tx: BrainEngine, key: string, authority: SubmissionAuthority): Promise<MinionJob | null> {
  const [existing] = await tx.executeRaw<Record<string, unknown>>(KEYED_ROW_SQL, [key]);
  if (!existing) return null;
  if (coalesceDecision(existing, authority) === 'coalesce') return coalescedJob(existing);
  await releaseIdempotencyKey(tx, existing, key);
  return null;
}

/**
 * Runs the INSERT; when `ON CONFLICT DO NOTHING` returns no row, re-reads the
 * winner and applies the same rule. A dead or cancelled winner has its key
 * released and the insert is retried once in the same transaction.
 */
export async function insertOrCoalesce(
  tx: BrainEngine, insertSql: string, params: unknown[], key: string | undefined, authority: SubmissionAuthority,
): Promise<{ inserted: Record<string, unknown> } | { coalesced: MinionJob }> {
  let [inserted] = await tx.executeRaw<Record<string, unknown>>(insertSql, params);
  for (let retried = false; !inserted && key; retried = true) {
    const [winner] = await tx.executeRaw<Record<string, unknown>>(KEYED_ROW_SQL, [key]);
    if (!winner) throw new Error(`idempotency_key ${key} insert returned no row and no existing row found`);
    if (coalesceDecision(winner, authority) === 'coalesce') return { coalesced: coalescedJob(winner) };
    if (retried) throw new Error(`idempotency_key ${key} was released but the retried insert still conflicted`);
    await releaseIdempotencyKey(tx, winner, key);
    [inserted] = await tx.executeRaw<Record<string, unknown>>(insertSql, params);
  }
  return { inserted: inserted! };
}
