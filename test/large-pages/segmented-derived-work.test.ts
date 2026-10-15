/**
 * Wave B derived work on segmented pages (pages.segmented_storage on): the
 * Life Chronicle decision and execution, the remote `links` effect and the
 * facts backstop meet pages whose body fields throw `page_body_segmented`.
 *
 * 1. Protects: a coordinated publication of a chronicle-shaped segmented page
 *    commits with a pending chronicle decision; the unmanaged discovery never
 *    reads a segmented page as `too_short` (which would retire its events);
 *    execution judges a segmented page within the single-string ceiling and
 *    skips one above it as `page_body_segmented`; backfill counts segmented
 *    pages as eligible; a remote write's `links` effect on a segmented page
 *    finishes skipped instead of retrying forever; the facts backstop neither
 *    queues for a segmented page nor lets a facts-absorb job throw on one.
 * 2. Fails when: any of these paths reads `compiled_truth` of a segmented page
 *    object, or sees its NULL column as an empty body.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { preparePageMutation } from '../../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { decideChronicle } from '../../src/core/chronicle/ledger.ts';
import { upsertChronicleRow } from '../../src/core/chronicle/ledger.ts';
import { runChronicleBackfill } from '../../src/core/chronicle/backfill.ts';
import { runPhaseChronicle } from '../../src/core/cycle/chronicle.ts';
import { makeFactsAbsorbHandler } from '../../src/core/minions/handlers/facts-absorb.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationBody } from '../helpers/conversation-page.ts';

const config = { engine: 'pglite' as const, embedding_disabled: true };
const CLIENT = 'client-segmented-derived';
const today = new Date().toISOString().slice(0, 10);
const body = conversationBody(1_200_000, { seed: 61 });
const meeting = (title: string) => `---\ntype: meeting\ntitle: ${title}\ndate: ${today}\n---\n\n${body}\n`;
const note = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\nSee [[people/alice-example]].\n\n${body}\n`;
const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-derived-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM chronicle_page_state');
    await engine.executeRaw('DELETE FROM persistence_effects');
    await engine.executeRaw('DELETE FROM pages');
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('chronicle.auto_settle_seconds', '0');
    await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 60_000).toISOString());
  }
});

async function sourceIncarnation(engine: BrainEngine, sourceId = 'default'): Promise<string> {
  return (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]))[0]!.incarnation;
}

/** One coordinated put_page through admission, preparation and publication; `remote` writes as an OAuth client. */
async function coordinatedPut(engine: BrainEngine, slug: string, content: string, remote = false) {
  return withEnv({ GBRAIN_HOME: home }, async () => {
    await registerLocalWriter(engine, 'cli');
    if (remote) {
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
        VALUES($1,'fixture-hash','segmented-client','read write','default') ON CONFLICT (client_id) DO NOTHING`, [CLIENT]);
    }
    const ctx: OperationContext = { engine, config, dryRun: false, remote, sourceId: 'default', logger: { info() {}, warn() {}, error() {} },
      ...(remote ? { auth: { token: 'fixture', clientId: CLIENT, principal: { kind: 'oauth_client', id: CLIENT }, scopes: ['read', 'write'], sourceId: 'default' } as OperationContext['auth'] } : {}) };
    const incarnation = await sourceIncarnation(engine);
    const authority = await submissionAuthority(ctx, 'put_page', 'default', incarnation, slug);
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: incarnation,
      slug, pageId: null, requestId: randomUUID(), callerIntent: { content }, intent: { content } });
    const row = (await claimNextWrite(engine, localHostId()))!;
    return publishMutation(engine, row, await preparePageMutation(engine, row, config));
  });
}

async function storage(engine: BrainEngine, slug: string): Promise<{ id: number; body_storage: string; content_hash: string }> {
  const [row] = await engine.executeRaw<{ id: number; body_storage: string; content_hash: string }>(
    "SELECT id, body_storage, content_hash FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  return { ...row!, id: Number(row!.id) };
}

const ledger = (engine: BrainEngine) => engine.executeRaw<{ slug: string; state: string; reason: string | null; scheduled: boolean }>(
  'SELECT slug, state, reason, next_attempt_at IS NOT NULL AS scheduled FROM chronicle_page_state ORDER BY slug, decided_at');

describe('Life Chronicle on segmented pages', () => {
  test('a coordinated put_page of a chronicle-shaped segmented page commits with a pending decision', async () => {
    for (const engine of engines) {
      // A trusted write with auto_link off and a remote write both reach the in-transaction chronicle decision.
      await engine.setConfig('auto_link', 'false');
      try {
        for (const [slug, remote] of [['meetings/segmented-daily', false], ['meetings/segmented-weekly', true]] as const) {
          const committed = await coordinatedPut(engine, slug, meeting(slug), remote);
          expect({ state: committed.state, error: committed.error_code }).toEqual({ state: 'committed', error: null });
          expect((await storage(engine, slug)).body_storage).toBe('segmented');
          expect(committed.outcome?.chronicle_backstop).toMatchObject({ pending: 'next_cycle' });
        }
      } finally { await engine.unsetConfig('auto_link'); }
      expect(await ledger(engine)).toEqual([
        { slug: 'meetings/segmented-daily', state: 'pending', reason: null, scheduled: true },
        { slug: 'meetings/segmented-weekly', state: 'pending', reason: null, scheduled: true }]);
    }
  }, 300_000);

  test('the write decision skips a segmented page over the single-string ceiling as page_body_segmented, never too_short', () => {
    const settings = { recentDays: 30, settleSeconds: 0 };
    const page = { type: 'meeting', slug: 'meetings/huge', frontmatter: { date: today }, body_storage: 'segmented' as const };
    const over = decideChronicle({ page: { ...page, body_bytes: PAGE_MAX_BYTES + 1, compiled_truth: 'x'.repeat(200) }, authority: null,
      noExtract: false, enabled: true, settings, now: new Date() });
    expect(over).toEqual({ state: 'skipped', reason: 'page_body_segmented', nextAttemptAt: null });
  });

  test('unmanaged discovery decides a segmented page from its truth lead and the phase judges its materialized body', async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'meetings/segmented-standup', meeting('Standup'), { sourceId: 'default', noEmbed: true });
      const page = await storage(engine, 'meetings/segmented-standup');
      expect(page.body_storage).toBe('segmented');
      // An earlier revision produced events: a too_short decision would schedule their retirement.
      await upsertChronicleRow(engine, { sourceId: 'default', pageId: page.id, contentHash: 'earlier-revision', slug: 'meetings/segmented-standup',
        state: 'pending', reason: null, trigger: 'auto', nextAttemptAt: null });
      await engine.executeRaw(`UPDATE chronicle_page_state SET state='extracted', event_hashes=ARRAY['h1'], event_slugs=ARRAY['life/events/e1']
        WHERE content_hash='earlier-revision'`);
      const judged: string[] = [];
      const run = await runPhaseChronicle(engine, { judge: async (input) => { judged.push(input.body); return { events: [] }; } });
      expect(run.details.reasons).not.toHaveProperty('too_short');
      expect(judged).toHaveLength(1);
      expect(judged[0]!.slice(0, 200)).toBe(body.slice(0, 200));
      const rows = await engine.executeRaw<{ state: string; reason: string | null }>(
        'SELECT state, reason FROM chronicle_page_state WHERE content_hash=$1', [page.content_hash]);
      expect(rows).toEqual([{ state: 'extracted', reason: 'no_events' }]);
    }
  }, 300_000);

  test('execution skips a segmented page over the single-string ceiling as page_body_segmented without throwing', async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'meetings/segmented-offsite', meeting('Offsite'), { sourceId: 'default', noEmbed: true });
      const page = await storage(engine, 'meetings/segmented-offsite');
      await upsertChronicleRow(engine, { sourceId: 'default', pageId: page.id, contentHash: page.content_hash, slug: 'meetings/segmented-offsite',
        state: 'pending', reason: null, trigger: 'auto', nextAttemptAt: null });
      await engine.executeRaw('UPDATE pages SET body_bytes=$2 WHERE id=$1', [page.id, PAGE_MAX_BYTES + 1]);
      let calls = 0;
      await runPhaseChronicle(engine, { judge: async () => { calls++; return { events: [] }; } });
      expect(calls).toBe(0);
      expect(await ledger(engine)).toEqual([{ slug: 'meetings/segmented-offsite', state: 'skipped', reason: 'page_body_segmented', scheduled: false }]);
    }
  }, 300_000);

  test('backfill counts a segmented chronicle page as eligible', async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'meetings/segmented-review', meeting('Review'), { sourceId: 'default', noEmbed: true });
      const result = await runChronicleBackfill(engine, { dryRun: true, sourceId: 'default' });
      expect(result.skipped).not.toHaveProperty('too_short');
      expect(result.eligible).toBe(1);
    }
  }, 300_000);
});

describe('page-write effects on segmented pages', () => {
  test('a remote write of a segmented page finishes its links effect as skipped instead of retrying', async () => {
    for (const engine of engines) {
      const committed = await coordinatedPut(engine, 'notes/segmented-remote', note('Remote'), true);
      expect(committed.state).toBe('committed');
      expect((await storage(engine, 'notes/segmented-remote')).body_storage).toBe('segmented');
      await withEnv({ GBRAIN_HOME: home }, () => runPersistenceEffects(engine, config, { hostId: localHostId() }));
      const effects = await engine.executeRaw<{ state: string; error_code: string | null; outcome: Record<string, unknown> | null }>(
        "SELECT state, error_code, outcome FROM persistence_effects WHERE request_id=$1::uuid AND kind='links'", [committed.id]);
      expect(effects).toEqual([{ state: 'committed', error_code: null, outcome: { links: 'skipped', reason: 'page_body_segmented' } }]);
    }
  }, 300_000);

  test('a write of a segmented page reports the facts backstop skipped and queues no facts-backstop effect', async () => {
    for (const engine of engines) {
      await engine.setConfig('facts.extraction_enabled', 'true');
      const committed = await coordinatedPut(engine, 'notes/segmented-facts', note('Facts'), true);
      expect(committed.state).toBe('committed');
      expect(committed.outcome?.facts_backstop).toEqual({ skipped: 'page_body_segmented' });
      expect(await engine.executeRaw("SELECT kind FROM persistence_effects WHERE request_id=$1::uuid AND kind='facts-backstop'", [committed.id])).toEqual([]);
    }
  }, 300_000);

  test('a facts-absorb job for a segmented page returns skipped instead of throwing', async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'notes/segmented-absorb', note('Absorb'), { sourceId: 'default', noEmbed: true });
      expect((await storage(engine, 'notes/segmented-absorb')).body_storage).toBe('segmented');
      const handler = makeFactsAbsorbHandler(engine);
      const result = await withEnv({ GBRAIN_HOME: home }, () => handler({ id: 1, name: 'facts-absorb', signal: new AbortController().signal,
        data: { slug: 'notes/segmented-absorb', sourceId: 'default', source: 'sync:import' } } as never));
      expect(result).toEqual({ skipped: 'page_body_segmented', slug: 'notes/segmented-absorb', sourceId: 'default' });
    }
  }, 300_000);
});
