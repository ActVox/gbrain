/**
 * C-9 (#6948 sweep, #6761): a put_page's facts-absorb job that dies after its 5 attempts (provider outage, bad
 * config) was never re-dispatched. The page-write effect had already completed as 'queued' in the same transaction
 * that submitted the job, so nothing submitted it again and that revision's facts never landed.
 *
 * Real path on PGLite: committed page write, facts-backstop effect dispatch, the facts-absorb job run by the PGLite
 * drain (the same claim/fail semantics as the worker) against a stub provider that fails 5 times, then recovers.
 * The next maintenance pass (the facts_drain cycle phase) must re-submit the dead job once and the facts must land.
 * A job that died on a deterministic write refusal stays dead and is reported as not retryable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { preparePageMutation } from '../../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { claimPersistenceEffect } from '../../src/core/persistence/effect-journal.ts';
import { dispatchFactsBackstopEffect } from '../../src/core/persistence/effect-facts.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import { __resetFactsDrainNoticesForTests, runFactsDrain } from '../../src/core/facts/drain.ts';
import { _resetLlmHaltCooldownsForTests } from '../../src/core/minions/llm-halt-cooldown.ts';
import { runPhaseFactsDrain } from '../../src/core/cycle/facts-drain.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

const KEYS = { ANTHROPIC_API_KEY: 'sk-test-c9', OPENAI_API_KEY: 'sk-test-c9' };
const MODEL = 'anthropic:claude-sonnet-4-6';
const PAGE = 'notes/c9-example';
const config = { engine: 'pglite' as const, embedding_disabled: true };
const content = `---\ntype: note\ntitle: Field notes\n---\n\n${'Acme Example shipped the beta in 2026, per this project record. '.repeat(4)}`;
let engine: PGLiteEngine;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { __setChatTransportForTests(null); resetGateway(); await disposePersistenceConsumer(engine); await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
  await engine.setConfig('facts.extraction_model', MODEL);
  await engine.setConfig('embedding_disabled', 'true');
  __resetFactsDrainNoticesForTests();
  _resetLlmHaltCooldownsForTests();
  __setChatTransportForTests(null);
  configureGateway({ embedding_disabled: true, env: KEYS } as never);
});

function factsReply(): ChatResult {
  const text = JSON.stringify({ facts: [{ fact: 'Acme Example shipped the beta in 2026', kind: 'fact', entity: 'companies/acme-example', confidence: 0.9, notability: 'high' }] });
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: MODEL, providerId: 'anthropic',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
}

/** Committed put_page, its facts-backstop effect dispatched: the job the effect completed as 'queued'. */
async function putPageJob(): Promise<number> {
  await registerLocalWriter(engine, 'cli');
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const ctx: OperationContext = { engine, config, dryRun: false, remote: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, PAGE);
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source.incarnation, slug: PAGE, pageId: null, requestId: randomUUID(), callerIntent: { content }, intent: { content } });
  const row = (await claimNextWrite(engine, localHostId()))!;
  const published = await publishMutation(engine, row, await preparePageMutation(engine, row, config));
  expect(published.outcome?.facts_backstop).toEqual({ queued: true });
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'facts-backstop'");
  const effect = (await claimPersistenceEffect(engine, localHostId()))!;
  await dispatchFactsBackstopEffect(engine, effect, localHostId());
  const [effectRow] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id=$1', [effect.id]);
  expect(effectRow.state).toBe('committed');
  const [job] = await engine.executeRaw<{ id: number; idempotency_key: string }>("SELECT id, idempotency_key FROM minion_jobs WHERE name='facts-absorb'");
  expect(job.idempotency_key).toMatch(/^facts-absorb:write:/);
  return Number(job.id);
}

const job = async (id: number) => (await engine.executeRaw<{ status: string; attempts_made: number; error_text: string | null }>(
  'SELECT status, attempts_made, error_text FROM minion_jobs WHERE id=$1', [id]))[0]!;
const factCount = async () => Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE fact LIKE '%shipped the beta%' AND expired_at IS NULL"))[0]?.n ?? 0);

/** Drain until the job is dead, making every delayed retry due at once (the worker's backoff, compressed). */
async function drainUntilDead(id: number): Promise<void> {
  for (let i = 0; i < 10 && (await job(id)).status !== 'dead'; i++) {
    await engine.executeRaw("UPDATE minion_jobs SET delay_until=now()-interval '1 second' WHERE id=$1 AND status='delayed'", [id]);
    await runFactsDrain(engine, { owner: 'cycle', log: () => {}, yieldMs: 0 });
  }
  expect((await job(id)).status).toBe('dead');
}

const isolated = (fn: () => Promise<void>) => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-c9-'));
  return withEnv({ GBRAIN_HOME: home, ...KEYS }, fn).finally(() => rmSync(home, { recursive: true, force: true }));
};

describe('C-9: a dead put_page facts-absorb job is re-submitted once its cause clears', () => {
  test('provider fails 5 times, the job dies; after recovery the next maintenance pass re-submits it and the facts land', () => isolated(async () => {
    const id = await putPageJob();
    let calls = 0;
    __setChatTransportForTests(async () => { calls++; throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:443'); });
    await drainUntilDead(id);
    expect(calls).toBe(5);
    expect(await factCount()).toBe(0);

    __setChatTransportForTests(async () => factsReply());
    const pass = await runPhaseFactsDrain(engine, { dryRun: false });
    expect(pass.details).toMatchObject({ dead_retry: { resubmitted: 1 } });
    expect(await factCount()).toBe(1);
    expect((await job(id)).status).toBe('completed');
  }), 120_000);
});
