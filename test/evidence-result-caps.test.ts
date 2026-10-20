/**
 * #7164: a search/query row returns a bounded amount of text by default.
 *   - An implied `auto` grows a conversation block around its match up to
 *     AUTO_BLOCK_CHAR_CAP (was EVIDENCE_BLOCK_CHAR_CAP, 60k), says
 *     `delivered.truncated`, and an explicit `return_unit` keeps the full cap.
 *   - On the chunk path a row's text stops at RESULT_CHUNK_CHARS with a marker
 *     naming the read that returns the rest and `chunk_chars` (the full
 *     length); `snippet_chars: 0` returns the whole chunk.
 * Keyword-only (search.mcp_keyword_only), PGLite, no provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { AUTO_BLOCK_CHAR_CAP, EVIDENCE_BLOCK_CHAR_CAP } from '../src/core/search/evidence-delivery.ts';
import { RESULT_CHUNK_CHARS } from '../src/core/search/snippet-cap.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { mcpCall, seedLongPages } from './helpers/long-page-fixture.ts';

const turn = (i: number) => `**alice-example:** item ${i} on the depot roster and the forklift lease renewal schedule for the quarter.\n\n**bob-example:** noted, item ${i} stays with the night shift and the lease desk follows up.`;
const MEETING = { slug: 'meetings/2026-04-01-depot-review', type: 'meeting', body: Array.from({ length: 400 }, (_, i) => i === 200 ? '**alice-example:** the zircon clause sets the forklift lease at 900 a month.' : turn(i)).join('\n\n') };
const BIG_CHUNK = 'Old export. ' + 'The harbor ledger lists every pallet, the berth, the crane and the tally clerk for the shift. '.repeat(120);

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedLongPages(engine, [MEETING]);
  await engine.putPage('notes/harbor-ledger', { type: 'note', title: 'Harbor ledger', compiled_truth: BIG_CHUNK, timeline: '', frontmatter: {} });
  await installFixtureChunks(engine, 'notes/harbor-ledger', [{ chunk_index: 0, chunk_text: BIG_CHUNK, chunk_source: 'compiled_truth' as const }]);
}, 240_000);
afterAll(async () => { await engine?.disconnect(); }, 120_000);

describe('implied auto: a long conversation block stops at AUTO_BLOCK_CHAR_CAP', () => {
  test('default call: bounded and marked truncated; explicit page unit: the old cap', async () => {
    expect(MEETING.body.length).toBeGreaterThan(EVIDENCE_BLOCK_CHAR_CAP);
    for (const name of ['search', 'query'] as const) {
      const { rows } = await mcpCall(engine, name, { query: 'zircon clause forklift lease', ...(name === 'query' ? { expand: false } : {}) });
      const hit = rows.find(r => r.slug === MEETING.slug)!;
      expect((hit.chunk_text as string).length).toBeLessThanOrEqual(AUTO_BLOCK_CHAR_CAP + 200);
      expect(hit.chunk_text as string).toContain('zircon clause');
      expect(hit.delivered).toMatchObject({ truncated: true });
    }
    const { rows } = await mcpCall(engine, 'search', { query: 'zircon clause forklift lease', return_unit: 'page' });
    expect((rows.find(r => r.slug === MEETING.slug)!.chunk_text as string).length).toBeGreaterThan(AUTO_BLOCK_CHAR_CAP * 2);
  });
});

describe('chunk path: one row returns at most RESULT_CHUNK_CHARS', () => {
  test('cut with chunk_chars and the read marker; snippet_chars 0 returns the whole chunk', async () => {
    expect(BIG_CHUNK.length).toBeGreaterThan(RESULT_CHUNK_CHARS);
    const cut = (await mcpCall(engine, 'search', { query: 'harbor ledger pallet berth' })).rows.find(r => r.slug === 'notes/harbor-ledger')!;
    expect((cut.chunk_text as string).startsWith(BIG_CHUNK.slice(0, RESULT_CHUNK_CHARS))).toBe(true);
    expect(cut.chunk_text as string).toContain('get_page notes/harbor-ledger');
    expect(cut.chunk_chars).toBe(BIG_CHUNK.length);
    const whole = (await mcpCall(engine, 'search', { query: 'harbor ledger pallet berth', snippet_chars: 0 })).rows.find(r => r.slug === 'notes/harbor-ledger')!;
    expect(whole.chunk_text).toBe(BIG_CHUNK);
    expect(whole.chunk_chars).toBeUndefined();
  });
});
