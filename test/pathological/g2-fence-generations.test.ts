/**
 * GBRA-161 PR 2: facts and takes publish through the generation primitive. A canonical fence retires rows only when it
 * is read whole and valid; an absent, unread or segmented fence holds (`generation_held`, reason `fence_absent`).
 * PGLite; Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { pathologicalArms } from './harness.ts';
import { FACTS_FENCE, managedSource, PERSON } from './managed-fixture.ts';

const ROW = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2020-01-01 |  | chat |  |`;
const SLUG = 'people/alice-example';

async function factRows(engine: BrainEngine, sourceId: string) {
  return engine.executeRaw<{ fact: string; row_num: number | null; expired: boolean }>(
    'SELECT fact, row_num, expired_at IS NOT NULL AS expired FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id', [sourceId, SLUG]);
}

describe('GBRA-161 PR 2 fence generations', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] B-5: a page write whose body lost its facts fence keeps every fact live`, async () => {
      await managedSource(databaseUrl, async () => {}, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', FACTS_FENCE([ROW(1, 'Alice founded acme-example'), ROW(2, 'Alice plays chess'), ROW(3, 'Alice lives in Lisbon')].join('\n'))));
        expect((await factRows(engine, sourceId)).map(row => [row.row_num, row.expired])).toEqual([[1, false], [2, false], [3, false]]);
        await put(SLUG, PERSON('Alice Example', 'Alice is an example person. The facts section was removed in this edit.\n'));
        expect((await factRows(engine, sourceId)).map(row => [row.fact, row.row_num, row.expired])).toEqual([
          ['Alice founded acme-example', 1, false], ['Alice plays chess', 2, false], ['Alice lives in Lisbon', 3, false]]);
      });
    }, 120_000);
  }
});
