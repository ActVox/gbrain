/**
 * Flip lane C (4): a write whose statements the database keeps ending is failed after a bound, not prepared forever.
 *
 * 1. Protects: a statement the database ended while it stayed up (57014, a statement timeout or cancel of this write's
 *    own work) is charged to the request's preparation_attempts like a preparation cut off at its deadline; at
 *    persistence.max_preparation_attempts the request ends `failed`/`write_interrupted` (the receipt names the
 *    attempts, the limit and the SQLSTATE) instead of being released as `database_contention` and prepared again. A
 *    single interruption still re-prepares and commits. Contention with other transactions (55P03 lock timeout, 40P01
 *    deadlock) and a dropped connection or restarting database (CONNECTION_CLOSED, 57P01) are never counted, so a
 *    Postgres restart never fails a write.
 *    Both publication arms: a database-only page (released or failed in place) and a worktree-backed page (the
 *    recovery route restores the canonical file before the failure is recorded).
 * 2. Fails when: the transient branch of finishUnpublishedFailure / publishMutation's recovery route releases every
 *    interruption uncounted (master: a large segmented write cancelled by the publication's 5 s statement_timeout on a
 *    loaded host is prepared again, its whole body streamed again, without limit), or when contention or a connection loss is counted.
 * 3. Existing coverage: page-purge-journal-timeout-6511.test.ts bounds the purge's own lookups only;
 *    persistence-preparation-deadline tests bound preparation deadlines, never a publication's interruptions.
 * 4. Semantic injection: installFaultHook on the publication's before_commit seam (inside the publication transaction),
 *    throwing an error carrying the SQLSTATE, for every publication of the claims the test names. Counts claims, never
 *    time. Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const interruption = (code: string) => Object.assign(new Error(code === '57014' ? 'canceling statement due to statement timeout' : `database interruption ${code}`), { code });
const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n`;
type Row = { state: string; error_code: string | null; error_message: string | null; error_detail: Record<string, unknown> | null; preparation_attempts: number; has_recovery: boolean };

for (const backend of testBackends()) describe(`[${backend}] transient publication failures are bounded`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-write-interrupted-${backend}-`));
  let n = 0;
  const context = (sourceId = 'default'): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId });
  const call = (params: Record<string, unknown>, sourceId = 'default') => withEnv({ GBRAIN_HOME: home },
    () => op('put_page').handler(context(sourceId), { wait_ms: 20_000, ...params })) as Promise<Record<string, any>>;
  const row = async (requestId: string): Promise<Row> => (await engine.executeRaw<Row>(`SELECT state,error_code,error_message,error_detail,preparation_attempts,
    recovery IS NOT NULL AS has_recovery FROM persistence_requests WHERE request_id=$1::uuid`, [requestId]))[0]!;

  /**
   * Every publication of the request's claims numbered in `failing` (1-based, counted at `consumer:preparing`) throws
   * `error()` at its before_commit seam, inside the publication transaction. Returns the claim count and the request's
   * preparation_attempts as each claim began (a commit resets the counter, so it is read while the request runs).
   */
  function interrupt(requestId: string, failing: (claim: number) => boolean, error: () => Error) {
    const claims = { n: 0, attempts: [] as number[] };
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'consumer:preparing') {
        claims.n++;
        claims.attempts.push((await row(requestId)).preparation_attempts);
        return;
      }
      if (point === 'publication:before_commit' && failing(claims.n)) throw error();
    });
    return claims;
  }

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine); await engine.disconnect(); await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
  afterEach(async () => {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("DELETE FROM config WHERE key='persistence.max_preparation_attempts'");
    resetWriteSwitches();
  });

  test('a write cancelled at every publication ends write_interrupted after exactly max_preparation_attempts preparations', async () => {
    const slug = `db/interrupted-${++n}`, requestId = randomUUID();
    const claims = interrupt(requestId, () => true, () => interruption('57014'));
    const outcome = await call({ slug, content: page(`Interrupted ${n}`), request_id: requestId }).catch(error => error as { code?: string });
    installFaultHook(undefined);
    expect(claims.n).toBe(2);
    expect((outcome as { code?: string }).code).toBe('write_interrupted');
    const failed = await row(requestId);
    expect(failed).toMatchObject({ state: 'failed', error_code: 'write_interrupted', preparation_attempts: 2, has_recovery: false });
    expect(failed.error_message).toContain('2 time(s)');
    expect(failed.error_message).toContain('57014');
    expect(failed.error_detail).toMatchObject({ origin: 'database_interruption', attempts: 2, limit: 2, sqlstate: '57014' });
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toBeNull();
    // The source keeps moving: the next write commits.
    expect(await call({ slug: `db/after-${n}`, content: page(`After ${n}`), request_id: randomUUID() })).toMatchObject({ state: 'committed' });
  }, 120_000);

  test('a single interruption re-prepares once, is counted and commits', async () => {
    const slug = `db/once-${++n}`, requestId = randomUUID();
    const claims = interrupt(requestId, claim => claim === 1, () => interruption('57014'));
    expect(await call({ slug, content: page(`Once ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(claims.n).toBe(2);
    expect(claims.attempts).toEqual([0, 1]);
    expect(await row(requestId)).toMatchObject({ state: 'committed' });
  }, 120_000);

  for (const code of ['CONNECTION_CLOSED', '57P01', '55P03', '40P01']) test(`a dropped connection or contention (${code}) is never counted: past the limit the write still commits`, async () => {
    const slug = `db/connection-${++n}`, requestId = randomUUID();
    const claims = interrupt(requestId, claim => claim <= 3, () => interruption(code));
    expect(await call({ slug, content: page(`Connection ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(claims.n).toBe(4);
    expect(claims.attempts).toEqual([0, 0, 0, 0]);
    expect(await row(requestId)).toMatchObject({ state: 'committed' });
  }, 120_000);

  describe('worktree-backed page', () => {
    let brainDir: string;
    const sourceId = `wt-${randomUUID().slice(0, 8)}`;
    beforeAll(async () => {
      brainDir = mkdtempSync(join(home, 'brain-'));
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, brainDir]);
      await withEnv({ GBRAIN_HOME: home }, () => claimWorktree(engine, sourceId, brainDir));
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      _resetWriteThroughCacheForTest();
    });
    afterAll(async () => { await disposePersistenceConsumer(engine); _resetWriteThroughCacheForTest(); });

    test('the limit follows max_preparation_attempts, and the recovery route restores the canonical file before the failure', async () => {
      const slug = `wt/interrupted-${++n}`;
      expect(await call({ slug, content: page(`Prior ${n}`), request_id: randomUUID() }, sourceId)).toMatchObject({ state: 'committed', write_through: { written: true } });
      const path = join(brainDir, `${slug}.md`);
      const bytes = readFileSync(path);
      const before = await engine.readPageSnapshot(slug, { sourceId });
      await engine.setConfig('persistence.max_preparation_attempts', '3');
      resetWriteSwitches();
      const requestId = randomUUID();
      const claims = interrupt(requestId, () => true, () => interruption('57014'));
      const outcome = await call({ slug, content: page(`Next ${n}`), request_id: requestId, expected_revision: before!.revision }, sourceId).catch(error => error as { code?: string });
      installFaultHook(undefined);
      expect(claims.n).toBe(3);
      expect((outcome as { code?: string }).code).toBe('write_interrupted');
      expect(await row(requestId)).toMatchObject({ state: 'failed', error_code: 'write_interrupted', preparation_attempts: 3, has_recovery: false,
        error_detail: expect.objectContaining({ attempts: 3, limit: 3, sqlstate: '57014' }) });
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).equals(bytes)).toBe(true);
      expect(await engine.readPageSnapshot(slug, { sourceId })).toEqual(before);
      expect(Number((await engine.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM persistence_requests WHERE recovery IS NOT NULL'))[0]!.n)).toBe(0);
    }, 120_000);
  });
});
