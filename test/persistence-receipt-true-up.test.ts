/**
 * #6696 (A1): a finished receipt gives back the part of its 16 KiB admission
 * reservation it does not keep, in the completion statement, single and group
 * paths, unless an effect is still unfinished; a counter already below the
 * delta clamps at zero and the clamp is counted. Both backends.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { claimNextWrite, completeWrite } from '../src/core/persistence/journal.ts';
import { completeGroup } from '../src/core/persistence/group-publish.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { RECEIPT_RESERVATION_FLOOR, retainedReceiptBytes, TRUE_UP_CLAMPED_KEY } from '../src/core/persistence/receipt-bytes.ts';
import { recordTopologyChange } from '../src/core/persistence/topology-receipts.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const row = async (engine: BrainEngine, id: string) => (await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [id]))[0]!;
const counters = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ key: string; terminal_bytes: string }>(
  "SELECT key,terminal_bytes::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%'")).map(c => [c.key, Number(c.terminal_bytes)]));
const reservations = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: string }>(
  'SELECT COALESCE(SUM(terminal_reservation),0)::text AS n FROM persistence_requests'))[0]!.n);
const formula = (r: WriteRequest) => retainedReceiptBytes(r, { stage: 'terminal' });

for (const kind of testBackends()) {
  describe(`receipt true-up at completion ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-true-up-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: (engine: BrainEngine) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(engine));
    }, 120_000);

    check('a single completion with no effects shrinks its reservation to the formula and releases the rest', async engine => {
      const requests = await requestFixture(engine);
      const admitted = await requests.admit('refused');
      expect(Number(admitted.terminal_reservation)).toBe(RECEIPT_RESERVATION_FLOOR);
      const claimed = (await claimNextWrite(engine, localHostId()))!;
      await engine.transaction(tx => completeWrite(tx, claimed, 'conflict', {}, { code: 'source_changed', message: 'the file moved' }));
      const done = await row(engine, admitted.id);
      expect(Number(done.terminal_reservation)).toBe(formula(done));
      expect(Number(done.terminal_reservation)).toBeLessThan(RECEIPT_RESERVATION_FLOOR);
      for (const value of Object.values(await counters(engine))) expect(value).toBe(Number(done.terminal_reservation));
      expect(await reservations(engine)).toBe(Number(done.terminal_reservation));
    });

    check('an unfinished effect keeps the admission reservation', async engine => {
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('published'));
      const pending = await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE request_id=$1::uuid AND state<>'committed'", [published.id]);
      expect(pending.length).toBeGreaterThan(0);
      expect(Number((await row(engine, published.id)).terminal_reservation)).toBe(RECEIPT_RESERVATION_FLOOR);
      for (const value of Object.values(await counters(engine))) expect(value).toBe(RECEIPT_RESERVATION_FLOOR);
    });

    check('a three-member group completion trues up every member in one statement', async engine => {
      const requests = await requestFixture(engine);
      const admitted = [await requests.admit('g1'), await requests.admit('g2'), await requests.admit('g3')];
      // Claimed together, as claimGroupFollowers claims a lane group's members behind its head.
      const claimed = await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        return tx.executeRaw<WriteRequest>(`UPDATE persistence_requests r SET state='running',execution_token=t.token,claim_expires_at=now()+interval '1 minute'
          FROM unnest($1::uuid[],$2::uuid[]) AS t(id,token) WHERE r.id=t.id RETURNING r.*`, [admitted.map(a => a.id), admitted.map(() => randomUUID())]);
      });
      claimed.sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence)));
      const outcomes = claimed.map(r => ({ slug: r.slug, status: 'created_or_updated' }));
      await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await completeGroup(tx, claimed, outcomes); });
      const done = await Promise.all(admitted.map(a => row(engine, a.id)));
      const sum = done.reduce((total, r) => total + Number(r.terminal_reservation), 0);
      for (const r of done) {
        expect(r.state).toBe('committed');
        expect(Number(r.terminal_reservation)).toBe(formula(r));
        expect(Number(r.terminal_reservation)).toBeLessThan(RECEIPT_RESERVATION_FLOOR);
      }
      for (const value of Object.values(await counters(engine))) expect(value).toBe(sum);
    });

    check('a counter already below the delta still commits, clamps at zero and counts the clamp', async engine => {
      const requests = await requestFixture(engine);
      const admitted = await requests.admit('drifted');
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("UPDATE persistence_counters SET terminal_bytes=100 WHERE key='brain' OR key LIKE 'principal:%'");
      });
      const claimed = (await claimNextWrite(engine, localHostId()))!;
      await engine.transaction(tx => completeWrite(tx, claimed, 'failed', {}, { code: 'storage_error', message: 'generic failure' }));
      expect((await row(engine, admitted.id)).state).toBe('failed');
      for (const value of Object.values(await counters(engine))) expect(value).toBe(0);
      expect(await engine.getConfig(TRUE_UP_CLAMPED_KEY)).toBe('2');
    });

    check('a receipt redacted for purged content at completion shrinks to what it keeps', async engine => {
      const requests = await requestFixture(engine);
      const admitted = await requests.admit(`purged-${'x'.repeat(120)}`);
      const claimed = (await claimNextWrite(engine, localHostId()))!;
      await engine.transaction(tx => completeWrite(tx, claimed, 'failed', {}, { code: 'purged_content', message: 'the page carries content the owner purged' }));
      const done = await row(engine, admitted.id);
      expect(done).toMatchObject({ compacted: true, intent: null });
      expect(Number(done.terminal_reservation)).toBe(retainedReceiptBytes(done, { stage: 'terminal' }));
      for (const value of Object.values(await counters(engine))) expect(value).toBe(Number(done.terminal_reservation));
    });

    check('a lifecycle change recorded committed is charged its retained bytes, not 16 KiB', async engine => {
      const requests = await requestFixture(engine);
      const [writer] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_local_writers LIMIT 1');
      const change = await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        return recordTopologyChange(tx, { principal: writer!.id, requestId: randomUUID(), intent: { op: 'example' }, operation: 'example',
          sourceId: requests.sourceId, incarnation: requests.incarnation, worktrees: [] }, { done: true });
      });
      expect(change.state).toBe('committed');
      expect(Number(change.terminal_bytes)).toBe(retainedReceiptBytes({ outcome: { done: true } }, { stage: 'terminal' }));
      for (const value of Object.values(await counters(engine))) expect(value).toBe(Number(change.terminal_bytes));
    });
  });
}
