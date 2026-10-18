/**
 * GBRA-130 A-5 (#6712 PR 4b): a publication whose transaction always hits its statement timeout (57014) was released as
 * `database_contention` without charging an attempt and claimed again without limit; as the oldest unresolved row of
 * its worktree it held every later write on that root (FIFO). A lock timeout (55P03) waits on another holder and stays
 * transient, uncounted (#5762): that arm pins it.
 *
 * Protects (red before: the timed-out write stays queued/running with `database_contention` and the write behind it
 * does not commit):
 * - each timeout charges one attempt (`preparation_attempts`), and at `persistence.max_preparation_attempts` the write
 *   ends `failed`/`publication_timeout` with nothing committed;
 * - a later write to the same source then commits;
 * - both arms: a database-only page and a worktree-backed page (whose recovery record restores the canonical state).
 * Semantic injection: `installFaultHook` on the `publication:before_commit` seam, inside the publication transaction.
 * Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const timeout = (code: '57014' | '55P03') => Object.assign(new Error(code === '57014' ? 'canceling statement due to statement timeout' : 'canceling statement due to lock timeout'), { code });
type Row = { state: string; error_code: string | null; error_message: string | null; blocked_reason: string | null; preparation_attempts: number; has_recovery: boolean };

for (const backend of testBackends()) describe(`[${backend}] GBRA-130 A-5: a publication that keeps timing out`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-a5-${backend}-`));
  let brainDir = '';
  const managed = `wt-${randomUUID().slice(0, 8)}`;
  const context = (sourceId: string): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId });
  const put = (sourceId: string, slug: string, requestId = randomUUID()) => withEnv({ GBRAIN_HOME: home }, () => op('put_page').handler(context(sourceId),
    { slug, source_id: sourceId, content: `---\ntitle: ${slug}\ntype: note\n---\nBody of ${slug}.\n`, request_id: requestId })) as Promise<Record<string, any>>;
  const row = async (requestId: string): Promise<Row> => (await engine.executeRaw<Row>(`SELECT state,error_code,error_message,blocked_reason,preparation_attempts,
    recovery IS NOT NULL AS has_recovery FROM persistence_requests WHERE request_id=$1::uuid`, [requestId]))[0]!;
  async function settled(requestId: string, ms = 20_000): Promise<Row> {
    const until = performance.now() + ms;
    for (;;) {
      const current = await row(requestId);
      if (['committed', 'failed', 'conflict', 'cancelled'].includes(current.state) || performance.now() > until) return current;
      await Bun.sleep(100);
    }
  }

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    brainDir = mkdtempSync(join(home, 'brain-'));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [managed, brainDir]);
    await withEnv({ GBRAIN_HOME: home }, () => claimWorktree(engine, managed, brainDir));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    _resetWriteThroughCacheForTest();
  }, 120_000);
  afterAll(async () => {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine); await engine.disconnect(); await closePostgres?.();
    _resetWriteThroughCacheForTest();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
  afterEach(async () => { installFaultHook(undefined); await disposePersistenceConsumer(engine); });

  for (const [arm, sourceId] of [['database-only page', 'default'], ['worktree-backed page', managed]] as const) {
    test(`${arm}: a 55P03 lock timeout at publication stays transient contention, uncounted, and commits once the lock frees`, async () => {
      const slug = `a5/lock-${randomUUID().slice(0, 8)}`;
      const requestId = randomUUID();
      let timedOut = 0;
      installFaultHook(async (point, detail) => {
        if (detail.requestId === requestId && point === 'publication:before_commit' && timedOut < 3) { timedOut++; throw timeout('55P03'); }
      });
      await put(sourceId, slug, requestId).catch(() => null);
      const done = await settled(requestId);
      expect(timedOut).toBe(3);
      expect(done).toMatchObject({ state: 'committed', preparation_attempts: 0 });
    }, 60_000);
    for (const code of ['57014'] as const) test(`${arm}: a ${code} at every publication ends failed/publication_timeout at the attempt limit, and the next write commits`, async () => {
      const slug = `a5/t${code.toLowerCase()}-${randomUUID().slice(0, 8)}`;
      const requestId = randomUUID();
      let timedOut = 0;
      installFaultHook(async (point, detail) => {
        if (detail.requestId === requestId && point === 'publication:before_commit') { timedOut++; throw timeout(code); }
      });
      await put(sourceId, slug, requestId).catch(() => null);
      const done = await settled(requestId);
      expect(done).toMatchObject({ state: 'failed', error_code: 'publication_timeout', preparation_attempts: 2, has_recovery: false });
      expect(done.error_message).toContain('persistence.max_preparation_attempts (2)');
      expect(timedOut).toBeGreaterThanOrEqual(2);
      expect(await engine.readPageSnapshot(slug, { sourceId })).toBeNull();
      if (sourceId === managed) expect(existsSync(join(brainDir, `${slug}.md`))).toBe(false);
      const next = await put(sourceId, `${slug}-next`);
      expect(next.state).toBe('committed');
    }, 60_000);
  }
});
