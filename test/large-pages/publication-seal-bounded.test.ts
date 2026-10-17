/**
 * The seal decision of a segmented write's publication reads no more than the write's own delta (flip lane C).
 *
 * 1. Protects: applySegmentedBody decides whether the publication seals the page (every occurrence chunked, no stale
 *    chunk row stored) without reading the page: the stale-row probe (projection.ts STALE_CHUNKS_SQL, one index walk
 *    over every occurrence of the page plus every row of each live one) and the live manifest read run in preparation,
 *    and the publication transaction only reads what the write staged. A small edit near the end of a 2 MiB and an
 *    8 MiB page still seals in its publication, and its new text is a keyword hit at once.
 * 2. Fails when: the probe runs inside the publication transaction, where its cost grows with the page and
 *    declareDurablePersistence's 5 s statement_timeout can end it on a loaded host (57014), so the whole write is
 *    prepared again; or when the publication stops sealing (the post-commit projection is lost here, so only the
 *    publication can seal).
 * 3. Existing coverage: second-write-deferred-retire.test.ts keeps a page whose earlier write deferred its retirement
 *    unsealed; chunk-retirement-plan.test.ts bounds the probe itself.
 * 4. Work is EXPLAIN (ANALYZE, FORMAT JSON) of each content_chunks / page_body_manifest statement the publication
 *    transaction issues (inside a savepoint rolled back before the real statement runs): rows produced plus rows
 *    removed by filters, times loops, summed over plan nodes. Counts, never time. Runs on PGLite, and on Postgres
 *    when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-publication-seal-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
afterAll(() => { rmSync(home, { recursive: true, force: true }); });
const PROJECTION_PAGE_READ = "FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND body_storage='segmented'";

interface PlanNode { 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] }
interface StatementWork { sql: string; rows: number }

function rowsExamined(node: PlanNode): number {
  const loops = node['Actual Loops'] ?? 1;
  const own = ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * loops;
  return own + (node.Plans ?? []).reduce((n, child) => n + rowsExamined(child), 0);
}

/** `tx` with each content_chunks / page_body_manifest statement measured first, in a savepoint rolled back before it runs. */
function measuredTx(tx: BrainEngine, log: StatementWork[]): BrainEngine {
  return new Proxy(tx, { get(target, prop) {
    if (prop === 'executeRaw') return async (sql: string, params?: unknown[], opts?: unknown) => {
      if (/content_chunks|page_body_manifest/.test(sql)) {
        await target.executeRaw('SAVEPOINT plan_probe');
        const [row] = await target.executeRaw<Record<string, unknown>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
        await target.executeRaw('ROLLBACK TO SAVEPOINT plan_probe');
        const raw = Object.values(row!)[0];
        const plan = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
        log.push({ sql: sql.replace(/\s+/g, ' ').slice(0, 100), rows: rowsExamined(plan[0]!.Plan) });
      }
      return target.executeRaw(sql, params, opts as never);
    };
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/**
 * The engine whose publication transaction (the one the generation flip runs in, `segmented:flipped`) has its statements
 * measured into `publication`, and whose post-commit projection is lost (its page read throws), so only the publication seals.
 */
function measuredWrite(engine: BrainEngine, publication: StatementWork[]): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    if (prop === 'executeRaw') return (sql: string, params?: unknown[], opts?: unknown) => sql.includes(PROJECTION_PAGE_READ)
      ? Promise.reject(new Error('projection lost (probe)')) : target.executeRaw(sql, params, opts as never);
    if (prop === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) => target.transaction(async tx => {
      const log: StatementWork[] = [];
      let flipped = false;
      installFaultHook(point => { if (point === 'segmented:flipped') flipped = true; });
      try {
        const out = await fn(measuredTx(tx, log));
        if (flipped) publication.push(...log);
        return out;
      } finally { installFaultHook(undefined); }
    }, opts as never);
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

for (const kind of testBackends()) describe(`a segmented write's publication reads its delta, not the page (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => withEnv(env, async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    await registerLocalWriter(engine, 'cli');
    await engine.setConfig('pages.segmented_storage', 'on');
  }), 120_000);
  afterAll(async () => withEnv(env, async () => { await disposePersistenceConsumer(engine); await close?.(); }));

  const found = async (slug: string, word: string) => (await engine.searchKeyword(word, { limit: 10 })).filter(r => r.slug === slug).length;

  for (const mib of [2, 8]) test(`an edit near the end of a ${mib} MiB page seals in its publication, reading only what it staged`, async () => withEnv(env, async () => {
    const v0 = conversationPage(mib * 1024 * 1024, { seed: 61, needles: [{ at: 0.95, word: 'tailmarkerquokka' }] });
    const file = join(home, `page-${mib}.md`);
    const slug = `notes/publication-seal-${mib}`;
    const write = async (on: BrainEngine) => expect(await importFromFile(on, file, `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) }))
      .toMatchObject({ status: 'imported' });
    writeFileSync(file, v0);
    await write(engine);
    const before = await segmentedPageRow(engine, slug);
    expect(before.text_projection_revision).toBe(before.knowledge_revision);

    writeFileSync(file, v0.replace('tailmarkerquokka', 'tailmarkerwalrus'));
    const publication: StatementWork[] = [];
    await write(measuredWrite(engine, publication));

    const page = await segmentedPageRow(engine, slug);
    expect(page.text_projection_revision).toBe(page.knowledge_revision);
    expect(await found(slug, 'tailmarkerwalrus')).toBeGreaterThan(0);
    expect(await found(slug, 'tailmarkerquokka')).toBe(0);
    const generation = Number(page.body_generation);
    const [{ staged }] = await engine.executeRaw<{ staged: number }>(`SELECT
      (SELECT count(*)::int FROM content_chunks WHERE page_id=$1 AND body_generation=$2) + (SELECT count(*)::int FROM page_body_manifest WHERE page_id=$1 AND gen_from=$2) AS staged`,
      [page.id, generation]);
    const [{ pageRows }] = await engine.executeRaw<{ pageRows: number }>('SELECT count(*)::int AS "pageRows" FROM content_chunks WHERE page_id=$1', [page.id]);
    expect(pageRows).toBeGreaterThan(4 * staged);
    const work = publication.reduce((n, statement) => n + statement.rows, 0);
    expect(work, JSON.stringify(publication)).toBeLessThanOrEqual(staged);
  }), 600_000);
});
