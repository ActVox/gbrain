/**
 * #7187: a drain lease's holder record (persistence/sync-lease.ts writeHolderRecord) is an `active` minion_jobs row in
 * the `gbrain-drain-lease` queue that no worker ever claims (attempts_started 0). The worker's sweeps dead-lettered it
 * with `attempts_made + 1`, which violates chk_attempts_order and aborted the whole sweep transaction on every tick: a
 * holder that died without deleting its row (its process died on refused writes, #7183) stopped the stall detector for
 * every job, and a live drain older than the wall-clock threshold stopped the wall-clock sweep.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LEASE_BEACON_QUEUE } from '../src/core/persistence/sync-lease.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

/** The row writeHolderRecord writes, with its lock renewed until `lockUntil`. */
async function holderRow(token: string, lockUntil: string): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs(name, queue, status, submission_authority, data, max_attempts, max_stalled, lock_token, lock_until, started_at, remove_on_complete, remove_on_fail)
     VALUES ('sync', $1, 'active', '{"version":1,"kind":"application"}'::jsonb, '{"sourceId":"source-a"}'::jsonb, 1, 0, $2, ${lockUntil}, now() - interval '1 hour', true, true)
     RETURNING id`, [LEASE_BEACON_QUEUE, token]);
  return Number(row.id);
}

/** A claimed job whose worker died: its lock expired without renewal. */
async function strandedJob(): Promise<number> {
  const job = await queue.add('stranded', {}, { max_attempts: 3 });
  expect((await queue.claim('dead-worker:1', 60_000, 'default', ['stranded']))?.id).toBe(job.id);
  await engine.executeRaw(`UPDATE minion_jobs SET lock_until = now() - interval '5 minutes', error_text = 'cannot execute INSERT in a read-only transaction' WHERE id = $1`, [job.id]);
  return job.id;
}

describe('#7187 drain-lease holder rows and the worker sweeps', () => {
  test('a dead holder row no longer stops the stall detector: the stranded job is reclaimed and the holder row dropped', async () => {
    const holder = await holderRow('dead-holder', "now() - interval '5 minutes'");
    const stranded = await strandedJob();
    const swept = await queue.handleStalled(0);
    expect(swept.requeued.map(j => j.id)).toEqual([stranded]);
    expect(swept.dead).toEqual([]);
    expect(swept.released.map(j => j.id)).toEqual([holder]);
    expect(await queue.getJob(stranded)).toMatchObject({ status: 'waiting', stalled_counter: 1, lock_token: null });
    expect(await queue.getJob(holder)).toBeNull();
  });

  test('a live holder row is left alone by the stall detector', async () => {
    const holder = await holderRow('live-holder', "now() + interval '5 minutes'");
    const swept = await queue.handleStalled(0);
    expect(swept).toEqual({ requeued: [], dead: [], released: [] });
    expect(await queue.getJob(holder)).toMatchObject({ status: 'active', lock_token: 'live-holder' });
  });

  test('a long-running live drain no longer stops the wall-clock sweep, and its holder row is not timed out', async () => {
    const holder = await holderRow('live-holder', "now() + interval '5 minutes'");
    const job = await queue.add('runaway', {}, { max_attempts: 3 });
    await queue.claim('worker-a:1', 60_000, 'default', ['runaway']);
    await engine.executeRaw(`UPDATE minion_jobs SET started_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    const timedOut = await queue.handleWallClockTimeouts(30_000);
    expect(timedOut.map(j => j.id)).toEqual([job.id]);
    expect(await queue.getJob(holder)).toMatchObject({ status: 'active', lock_token: 'live-holder' });
  });
});
