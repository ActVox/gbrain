/**
 * #6785 — a corpus window that fails after its model call is not paid for
 * forever.
 *
 * A claimed but not activated canonical worktree refused every fence write
 * with writer_coordinator_required AFTER extraction. The window was never
 * committed, the claim was released, and the serve drain paid for the same
 * windows every 10 minutes for hours while discarding the report.
 *
 * Protects: the sweep and the compact harvest run the facts-absorb
 * owner-readiness preflight (#5362) before any model call and name
 * `gbrain sources writer status <id>`; a window that keeps failing after its
 * model call is retried on the next sweep, then after 10, 20 and 40 minutes,
 * then stopped at 5 attempts, whatever the error label and however the file
 * grows; one extraction-config change re-arms it once; the operator retry
 * (`gbrain sweep --retry-failed --apply`, named as doctor's paid fix)
 * extracts it and its facts land; the HTTP drain logs skip reasons and
 * thrown errors instead of discarding them.
 *
 * The preflight, drain and cost assertions import only modules that predate
 * #6785 and fail on the old tree. Hermetic in-memory PGLite + transport stubs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { armCorpusDrain, CORPUS_INGESTED_SUFFIX, runMaintenanceSweep, type SweepReport } from '../src/core/sweep.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { appendSegmentLedger, ensureCorpusSpoolDir, segmentFileName, sessionCorpusFileName, writeSegment } from '../src/core/context/corpus-segments.ts';
import { __drainCheckpointHarvestForTests, __resetCheckpointHarvestForTests, HARVEST_RECEIPT_SUFFIX, scheduleCheckpointHarvest } from '../src/core/context/checkpoint-harvest.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};
const MIN = 60_000;
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };
const tmpDirs: string[] = [];

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
const turnsText = (count: number, from = 0): string =>
  toCorpusText(Array.from({ length: count }, (_, i) => ({
    role: (from + i) % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: `T${String(from + i).padStart(2, '0')} Alice Example prefers written status updates over meetings for the weekly review.`,
  })));
const skipped = (r: SweepReport, reason: string): number => r.skipped.find((s) => s.reason === reason)?.count ?? 0;
const fact = (entity: string | null) => JSON.stringify({ facts: [{ fact: 'Prefers written status updates over meetings.', kind: 'preference', entity, confidence: 1, notability: 'high' }] });

describe('#6785: a claimed, not activated worktree is held before any model call', () => {
  let engine: PGLiteEngine;
  let home: string;
  let chatCalls = 0;
  let onCall: (() => Promise<void>) | null = null;
  const logs: string[] = [];

  /** A source whose checkout holds one entity page the extracted fact is fenced onto. */
  async function addCheckout(sourceId: string): Promise<string> {
    const root = join(tmp(`gbrain-6785-${sourceId}-`), 'brain');
    mkdirSync(join(root, 'people'), { recursive: true });
    writeFileSync(join(root, 'people/alice-example.md'), '---\ntitle: Alice Example\ntype: person\n---\nAlice Example.\n');
    if (sourceId === 'default') await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [root]);
    else await engine.executeRaw('INSERT INTO sources(id, name, local_path) VALUES($1, $1, $2)', [sourceId, root]);
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example.' }, { sourceId });
    return root;
  }

  /** A fresh corpus dir holding one session file stamped for `sourceId`. */
  async function sessionFile(sourceId: string, session: string): Promise<string> {
    const dir = tmp('gbrain-6785-corpus-');
    await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
    const file = join(ensureCorpusSpoolDir(dir), sessionCorpusFileName(session, sourceId));
    writeFileSync(file, turnsText(2));
    return file;
  }

  let defaultRoot: string;

  beforeAll(async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls++;
      if (onCall) await onCall();
      return { text: fact('people/alice-example'), blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
    });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    home = tmp('gbrain-6785-home-');
    await engine.setConfig('sync.write_through', 'true');
    defaultRoot = await addCheckout('default');
    // Claimed and never activated, before any test runs.
    await claimWorktree(engine, 'claimed-example', await addCheckout('claimed-example'));
  }, 120_000);

  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    resetGateway();
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });

  const sweep = (sourceId: string): Promise<SweepReport> => withEnv({ GBRAIN_HOME: home }, () =>
    runMaintenanceSweep(engine, { sourceId, capabilities: KEYED, budgetMs: 120_000, log: (m) => logs.push(m) }));

  test('the claim lands mid-call: that one call is lost, and every later sweep holds the file without paying', async () => {
    const file = await sessionFile('default', 'sess-mid-call');
    // The writer is claimed while the first extraction is in flight, so the
    // fence write after it is refused (the real failure path of #6785).
    onCall = async () => {
      onCall = null;
      await claimWorktree(engine, 'default', defaultRoot);
    };
    const first = await sweep('default');
    expect(chatCalls).toBeGreaterThan(0);
    expect(skipped(first, 'corpus_file_error')).toBe(1);
    const paid = chatCalls;

    for (let i = 0; i < 3; i++) {
      const r = await sweep('default');
      expect(chatCalls).toBe(paid);
      expect(skipped(r, 'writer_coordinator_required')).toBe(1);
    }
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
    expect(logs.join('\n')).toContain('(writer_coordinator_required)');
    expect(logs.join('\n')).toContain('gbrain sources writer status default');
  });

  test('the compact harvest holds a segment of a claimed source without paying', async () => {
    const dir = tmp('gbrain-6785-harvest-');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const w = writeSegment(dir, 'sess-claimed', turnsText(2, 10));
      appendSegmentLedger(dir, 'sess-claimed', w.hash);
      const name = segmentFileName('sess-claimed', w.hash);
      __resetCheckpointHarvestForTests();
      const before = chatCalls;
      expect(scheduleCheckpointHarvest({ engine, sourceId: 'claimed-example', sessionId: 'sess-claimed', corpusDir: dir, file: name, capabilities: KEYED }).status).toBe('scheduled');
      await __drainCheckpointHarvestForTests();
      expect(chatCalls).toBe(before);
      expect(existsSync(join(dir, name) + HARVEST_RECEIPT_SUFFIX)).toBe(false);
      expect(existsSync(join(dir, name) + CORPUS_INGESTED_SUFFIX)).toBe(false);
    });
  });

  test('the HTTP drain logs the skip reasons and the writer hint once, and a thrown tick says why', async () => {
    await sessionFile('claimed-example', 'sess-drain');
    const lines: string[] = [];
    const drain = armCorpusDrain(engine, { sourceId: 'claimed-example', env: {}, setIntervalFn: () => 0, clearIntervalFn: () => {}, log: (m: string) => lines.push(m) } as never)!;
    const before = chatCalls;
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await drain.tick();
      await drain.tick();
    });
    drain.cancel();
    expect(chatCalls).toBe(before);
    const text = lines.join('\n');
    expect(text).toContain('writer_coordinator_required');
    expect(text).toContain('gbrain sources writer status claimed-example');
    expect(lines.filter((l) => l.includes('gbrain sources writer status claimed-example')).length).toBe(1);

    const failing: string[] = [];
    const broken = armCorpusDrain(engine, { env: {}, setIntervalFn: () => 0, clearIntervalFn: () => {},
      sweep: async () => { throw new Error('drain fixture failure'); }, log: (m: string) => failing.push(m) } as never)!;
    await withEnv({ GBRAIN_HOME: home }, () => broken.tick());
    broken.cancel();
    expect(failing.join('\n')).toContain('drain fixture failure');
  });
});

describe('#6785: a window that keeps failing after its model call is capped', () => {
  let engine: PGLiteEngine;
  let dir: string;
  let home: string;
  let chatCalls = 0;
  let failing = true;
  const logs: string[] = [];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    home = tmp('gbrain-6785-cap-home-');
  }, 120_000);

  beforeEach(async () => {
    dir = tmp('gbrain-6785-cap-');
    await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
    failing = true;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls++;
      if (failing) throw new Error('fixture failure after the model call');
      return { text: fact(null), blocks: [], stopReason: 'end', usage, model: 'anthropic:test-stub', providerId: 'anthropic' };
    });
  });

  afterEach(() => {
    __setChatTransportForTests(null);
  });

  afterAll(async () => {
    resetGateway();
    await engine.disconnect();
  });

  const at = async (nowMs: number): Promise<{ paid: boolean; report: SweepReport }> => {
    const before = chatCalls;
    const report = await withEnv({ GBRAIN_HOME: home }, () =>
      runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED, budgetMs: 120_000, now: () => nowMs, log: (m) => logs.push(m) }));
    return { paid: chatCalls > before, report };
  };

  /** Five failed attempts on the schedule: now, the next sweep, +10, +20, +40 minutes. */
  async function capped(file: string, t0: number): Promise<void> {
    writeFileSync(file, turnsText(2));
    const attempts = [];
    for (const m of [0, 0, 11, 32, 73]) attempts.push((await at(t0 + m * MIN)).paid);
    expect(attempts).toEqual([true, true, true, true, true]);
    expect(JSON.parse(readFileSync(file + '.failures.json', 'utf8')).count).toBe(5);
  }

  test('retried on the next sweep, then after 10, 20 and 40 minutes, then stopped; tail growth does not reset it', async () => {
    const file = join(dir, 'failing-session.txt');
    writeFileSync(file, turnsText(2));
    const t0 = Date.UTC(2026, 9, 15, 12);
    const attempts: boolean[] = [];
    attempts.push((await at(t0)).paid);              // 1
    attempts.push((await at(t0)).paid);              // 2: the next sweep retries at once
    const waiting = await at(t0 + 1 * MIN);          // backoff
    attempts.push(waiting.paid);
    expect(skipped(waiting.report, 'corpus_window_backoff')).toBe(1);
    appendFileSync(file, `\n\n${turnsText(1, 2)}`);  // the session grew
    attempts.push((await at(t0 + 11 * MIN)).paid);   // 3
    attempts.push((await at(t0 + 12 * MIN)).paid);   // backoff (20 minutes)
    attempts.push((await at(t0 + 32 * MIN)).paid);   // 4
    attempts.push((await at(t0 + 73 * MIN)).paid);   // 5
    expect(attempts).toEqual([true, true, false, true, false, true, true]);

    for (const later of [t0 + 200 * MIN, t0 + 2 * 1440 * MIN]) {
      const r = await at(later);
      expect(r.paid).toBe(false);
      expect(skipped(r.report, 'corpus_window_dead_lettered')).toBe(1);
    }
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
    expect(logs.join('\n')).toContain('gbrain sweep --retry-failed');
    const record = JSON.parse(readFileSync(file + '.failures.json', 'utf8'));
    expect(record.count).toBe(5);
    expect(record.last_code).toBe('provider_error');
    expect(JSON.stringify(record)).not.toContain('fixture failure after the model call');
  });

  test('one extraction-config change re-arms the capped window once; a second change does not', async () => {
    const file = join(dir, 'failing-session.txt');
    await capped(file, Date.UTC(2026, 9, 15, 12));
    expect((await at(Date.UTC(2026, 9, 16, 12))).paid).toBe(false);
    const t1 = Date.UTC(2026, 9, 20, 12);
    await engine.setConfig('facts.extraction_model', 'anthropic:claude-haiku-4-5');
    try {
      const rearmed = [(await at(t1)).paid, (await at(t1)).paid, (await at(t1 + 11 * MIN)).paid, (await at(t1 + 32 * MIN)).paid, (await at(t1 + 73 * MIN)).paid];
      expect(rearmed).toEqual([true, true, true, true, true]);
      expect((await at(t1 + 300 * MIN)).paid).toBe(false);
      await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
      const second = await at(t1 + 400 * MIN);
      expect(second.paid).toBe(false);
      expect(skipped(second.report, 'corpus_window_dead_lettered')).toBe(1);
      expect(JSON.parse(readFileSync(file + '.failures.json', 'utf8')).rearmed).toBe(true);
    } finally {
      await engine.unsetConfig('facts.extraction_model');
    }
  });

  test('doctor names the paid retry; the operator retry previews, then extracts the window and its facts land', async () => {
    const file = join(dir, 'failing-session.txt');
    await capped(file, Date.UTC(2026, 9, 15, 12));
    const { buildMemoryWritebackCheck } = await import('../src/commands/doctor/checks/memory-writeback.ts');
    const check = await withEnv({ GBRAIN_HOME: home }, () => buildMemoryWritebackCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain sweep --retry-failed --apply');
    const fix = (check as { fix?: { argv: string[]; consent: string[] } }).fix;
    expect(fix?.argv).toEqual(['gbrain', 'sweep', '--retry-failed', '--apply']);
    expect(fix?.consent).toEqual(['paid']);

    const { runSweep } = await import('../src/commands/sweep.ts');
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    try {
      await runSweep(engine, ['--retry-failed', '--json']);
      expect(existsSync(file + '.failures.json')).toBe(true);
      await runSweep(engine, ['--retry-failed', '--apply', '--json']);
    } finally {
      console.log = log;
    }
    const preview = JSON.parse(out[0]);
    expect(preview.applied).toBe(false);
    expect(preview.files).toEqual([expect.objectContaining({ file: 'failing-session.txt', attempts: 5, stopped: true })]);
    expect(JSON.parse(out[1]).applied).toBe(true);
    expect(existsSync(file + '.failures.json')).toBe(false);

    failing = false;
    const r = await at(Date.UTC(2026, 9, 25, 12));
    expect(r.paid).toBe(true);
    expect(r.report.corpusIngested).toBe(1);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(true);
    const facts = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source = 'sweep:corpus'`);
    expect(facts[0].n).toBeGreaterThan(0);
  });

  test('the cap is keyed to the window and the source incarnation, never to the error label', async () => {
    const { corpusFailureGate, recordCorpusFailure } = await import('../src/core/context/corpus-windows.ts');
    const full = join(dir, 'labels.txt');
    let rec = await recordCorpusFailure(full, null, 'k@0', 'inc-a', 'f1', 1, Object.assign(new Error('a'), { code: 'writer_coordinator_required' }));
    rec = await recordCorpusFailure(full, rec, 'k@0', 'inc-a', 'f1', 2, Object.assign(new Error('b'), { reason: 'provider_error' }));
    rec = await recordCorpusFailure(full, rec, 'k@0', 'inc-a', 'f1', 3, new TypeError('c'));
    expect([rec.count, rec.last_code]).toEqual([3, 'TypeError']);
    expect((await recordCorpusFailure(full, rec, 'k@9', 'inc-a', 'f1', 4, new Error('d'))).count).toBe(1);
    const record = { version: 1 as const, key: 'abc@0', source_incarnation: 'inc-a', count: 5, first_at: 0, last_at: 0, last_code: 'x', fingerprint: 'f1', rearmed: false };
    expect(corpusFailureGate(record, 'abc@0', 'inc-a', 'f1', 1e12)).toBe('dead_lettered');
    expect(corpusFailureGate(record, 'abc@0', 'inc-b', 'f1', 1e12)).toBe('run');
    expect(corpusFailureGate(record, 'def@0', 'inc-a', 'f1', 1e12)).toBe('run');
    expect(corpusFailureGate(record, 'abc@0', 'inc-a', 'f2', 1e12)).toBe('run');
    expect(corpusFailureGate({ ...record, rearmed: true }, 'abc@0', 'inc-a', 'f2', 1e12)).toBe('dead_lettered');
    expect(corpusFailureGate({ ...record, fingerprint: null }, 'abc@0', 'inc-a', 'f2', 1e12)).toBe('dead_lettered');
  });
});
