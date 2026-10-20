/**
 * A committed managed write is reported committed while its owner's post-commit work still runs (PR 3 lane d).
 *
 * 1. Protects: the consumer settles a request it publishes through publishMutation (a managed file import, a streamed
 *    or otherwise ungroupable page) after the prepared mutation's afterCommit, here the projection of a segmented page
 *    created over SEGMENTED_CREATE_SEAL_MAX_BYTES, held at its first chunk batch. A waiter in the same process whose wait
 *    runs out first reads the receipt in its last HELD_RECHECK_MS (service.ts awaitWrite): the import replies
 *    `imported` with the projection still held, and the page seals once it is released.
 * 2. Fails when: the waiter skips every progress read while this process's consumer holds the request. It then saw the
 *    commit only through the handoff after afterCommit, so on a loaded VM, where a 24 MiB page's projection outran the
 *    30 s import wait, a committed write was reported write_pending (segmented-file-drift*.test.ts on the Postgres arm).
 * 3. Existing coverage: segmented-file-drift*.test.ts hit it only under load; nothing held the post-commit work.
 * 4. Seam: the existing `segmented:projection_batch` fault point (fault-points.ts), held on a promise the test releases.
 *    The import's own 30 s wait runs out once per engine.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { SEGMENTED_CREATE_SEAL_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-commit-handoff-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const page = conversationPage(SEGMENTED_CREATE_SEAL_MAX_BYTES + 512 * 1024, { seed: 31 });

beforeAll(async () => {
  const backends = testBackends();
  if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterEach(() => { installFaultHook(undefined); });

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

async function managedSource(engine: BrainEngine): Promise<{ sourceId: string; root: string }> {
  await disposePersistenceConsumer(engine);
  await engine.setConfig('pages.segmented_storage', 'on');
  const root = join(home, `src-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const sourceId = `handoff-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root };
}

const pageRow = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.executeRaw<{ body_storage: string; sealed: boolean }>(
  'SELECT body_storage, COALESCE(text_projection_revision = knowledge_revision, false) AS sealed FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0] ?? null;

test('a managed import whose projection outlasts its wait replies imported, not write_pending', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const { sourceId, root } = await managedSource(engine);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reached = false;
    installFaultHook(async (point, detail) => {
      if (point !== 'segmented:projection_batch' || detail.sourceId !== undefined && detail.sourceId !== sourceId) return;
      reached = true;
      await held;
    });
    try {
      const slug = 'notes/handoff';
      writeFileSync(join(root, `${slug}.md`), page);
      const result = await importManagedFile(engine, join(root, `${slug}.md`), `${slug}.md`, { sourceId, noEmbed: true }).catch(error => ({ status: 'error', code: (error as { code?: string }).code }));
      expect([engine.kind, result]).toMatchObject([engine.kind, { status: 'imported' }]);
      expect(reached).toBe(true);
      expect(await pageRow(engine, sourceId, slug)).toEqual({ body_storage: 'segmented', sealed: false });
      release();
      await disposePersistenceConsumer(engine);
      expect(await pageRow(engine, sourceId, slug)).toEqual({ body_storage: 'segmented', sealed: true });
    } finally {
      release();
      installFaultHook(undefined);
      await disposePersistenceConsumer(engine);
    }
  }
}), 240_000);
