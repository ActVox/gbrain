/**
 * GBRA-156 bounded keyword OR fallback on real Postgres: the statistics read
 * (orTokenSharesSql over pg_stats.most_common_elems) returns what
 * narrowOrFallbackTokens needs, stopwords included, and the engine's OR retry
 * still returns relaxed rows for the rare and the common terms when every
 * term fits the cap. Postgres only (PGLite has no OR narrowing); skipped
 * without DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { seedPage } from '../helpers/keyword-paging-fixture.ts';
import { narrowOrFallbackTokens, orTokenSharesSql } from '../../src/core/search/keyword-or-narrow.ts';

const run = process.env.DATABASE_URL ? describe : describe.skip;
let engine: BrainEngine;
let close: () => Promise<void> = async () => {};

run('keyword OR fallback narrowing on Postgres', () => {
  beforeAll(async () => {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = isolated.engine;
    close = isolated.close;
    for (let i = 0; i < 40; i++) await seedPage(engine, `notes/quasar-log-${i}`, `Quasar log entry ${i}: the quasar survey, night ${i}.`);
    await seedPage(engine, 'notes/nebulith-field', 'Field notes on the nebulith deposit.');
    await engine.executeRaw('ANALYZE content_chunks');
  }, 300_000);

  afterAll(async () => { await close(); });

  test('the statistics read reports lexemes, tracked shares and the row estimate', async () => {
    const rows = await engine.executeRaw<{ token: string; lexemes: number; share: number | null; rows: number; analyzed: boolean }>(
      orTokenSharesSql('english'), [['the', 'quasar', 'nebulith', 'zzqxv']]);
    expect(rows.map(r => r.token)).toEqual(['the', 'quasar', 'nebulith', 'zzqxv']);
    expect(rows[0].analyzed).toBe(true);
    expect(Number(rows[0].rows)).toBeGreaterThan(30);
    expect(rows.map(r => Number(r.lexemes))).toEqual([0, 1, 1, 1]);
    expect(Number(rows[1].share)).toBeGreaterThan(0.9);
    expect(rows[3].share).toBeNull();
    const nebulith = rows[2].share === null ? null : Number(rows[2].share);
    expect(nebulith === null || nebulith < 0.05).toBe(true);

    const tokens = rows.map(r => ({ token: r.token, lexemes: Number(r.lexemes), share: r.share === null ? null : Number(r.share) }));
    expect(narrowOrFallbackTokens(tokens, Number(rows[0].rows), 10)).toEqual(['zzqxv', 'nebulith']);
    expect(narrowOrFallbackTokens(tokens, Number(rows[0].rows))).toBeNull();
  });

  test('an OR retry within the cap still returns relaxed rows for every term', async () => {
    expect(await engine.searchKeyword('quasar nebulith zzqxv', { limit: 10 })).toEqual([]);
    const rows = await engine.searchKeyword('quasar nebulith zzqxv', { limit: 50, orFallback: true });
    const slugs = new Set(rows.map(r => r.slug));
    expect(slugs.has('notes/nebulith-field')).toBe(true);
    expect([...slugs].some(s => s.startsWith('notes/quasar-log-'))).toBe(true);
    expect(rows.every(r => r.keyword_relaxed === true)).toBe(true);
  });
});
