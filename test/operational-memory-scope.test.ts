import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { injectCanonicalOperationalResults } from '../src/core/search/operational-memory.ts';
import type { SearchResult } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('safe', 'safe'), ('other', 'other') ON CONFLICT DO NOTHING`,
  );
});

describe('operational canonical injection source scope', () => {
  test('injects a live canonical page while respecting private, type and prefix guards', async () => {
    await engine.putPage('ops/retrieval-policy', {
      type: 'retrieval-policy', title: 'Canonical synthetic policy', compiled_truth: 'Allowed canonical body',
    }, { sourceId: 'safe' });
    await engine.putPage('ops/memory-operating-contract', {
      type: 'memory-system-contract', title: 'Private synthetic contract', compiled_truth: 'Private canonical body',
      frontmatter: { visibility: 'private' },
    }, { sourceId: 'safe' });
    const query = 'retrieval policy status';
    const scope = { sourceId: 'safe', excludePrivate: true };
    const rows = await injectCanonicalOperationalResults(engine, [], query, scope);
    expect(rows.map(row => [row.slug, row.source_id, row.chunk_text])).toEqual([
      ['ops/retrieval-policy', 'safe', 'Allowed canonical body'],
    ]);
    expect(rows[0].exact_lookup).toBeUndefined();
    expect(rows[0].alias_hit).toBeUndefined();
    expect(await injectCanonicalOperationalResults(engine, [], query, { ...scope, type: 'note' })).toEqual([]);
    expect(await injectCanonicalOperationalResults(engine, [], query, { ...scope, excludeSlugPrefixes: ['ops/'] })).toEqual([]);
  });

  test('archived and quarantined canonical pages stay hidden from search discovery', async () => {
    await engine.putPage('ops/retrieval-policy', {
      type: 'retrieval-policy', title: 'Allowed synthetic policy', compiled_truth: 'Allowed canonical body',
    }, { sourceId: 'safe' });
    await engine.putPage('ops/memory-operating-contract', {
      type: 'memory-system-contract', title: 'Archived synthetic contract', compiled_truth: 'Archived canonical body',
    }, { sourceId: 'other' });
    await engine.putPage('ops/canonical-page-registry', {
      type: 'canonical-page-registry', title: 'Quarantined synthetic registry', compiled_truth: 'Quarantined canonical body',
      frontmatter: { quarantine: { reason: 'junk_pattern' } },
    }, { sourceId: 'safe' });
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'other'`);
    const rows = await injectCanonicalOperationalResults(engine, [], 'retrieval policy status', {
      sourceIds: ['safe', 'other'], excludePrivate: true,
    });
    expect(rows.map(row => [row.slug, row.source_id, row.chunk_text])).toEqual([
      ['ops/retrieval-policy', 'safe', 'Allowed canonical body'],
    ]);
  });

  test('the search wrapper ranks current actions even without a canonical slug rule', async () => {
    const makeResult = (slug: string, type: string, score: number): SearchResult => ({
      slug, type, score, title: slug, page_id: 1, chunk_id: 1,
      chunk_text: slug, chunk_source: 'compiled_truth', chunk_index: 0,
      stale: false, source_id: 'default',
    });
    const rows = await injectCanonicalOperationalResults(engine, [
      makeResult('meetings/circleback/project-status', 'meeting', 2),
      makeResult('ops/current-actions', 'synthesized-action-page', 1),
    ], 'project current actions status');
    expect(rows.map(row => row.slug)).toEqual([
      'ops/current-actions', 'meetings/circleback/project-status',
    ]);
    const evidence = await injectCanonicalOperationalResults(engine, [
      makeResult('meetings/circleback/project-status', 'meeting', 2),
    ], 'raw meeting transcript for project status');
    expect(evidence[0].score).toBe(2);
  });

  test('operational priorities preserve reranked neutral rows and exact identity pins', async () => {
    const makeResult = (slug: string, type: string, score: number, rerank_score: number): SearchResult => ({
      slug, type, score, rerank_score, title: slug, page_id: 1, chunk_id: 1,
      chunk_text: slug, chunk_source: 'compiled_truth', chunk_index: 0,
      stale: false, source_id: 'default',
    });
    const exact = { ...makeResult('notes/status', 'note', 0.5, 0.01), exact_lookup: 'slug' as const };
    const best = makeResult('notes/best', 'note', 1, 0.9);
    const weaker = makeResult('notes/weaker', 'note', 2, 0.1);
    const actions = makeResult('ops/current-actions', 'synthesized-action-page', 1, 0.05);
    const rows = await injectCanonicalOperationalResults(engine, [exact, best, weaker, actions], 'project status');
    expect(rows.map(row => row.slug)).toEqual([
      'notes/status', 'ops/current-actions', 'notes/best', 'notes/weaker',
    ]);
    expect(rows.map(row => row.rerank_score)).toEqual([0.01, 0.05, 0.9, 0.1]);
  });

  test('multi-source grants never inject canonical pages from an ungranted source', async () => {
    await engine.putPage('ops/retrieval-policy', {
      type: 'retrieval-policy',
      title: 'Private default retrieval policy',
      compiled_truth: 'default-only secret retrieval policy',
    });
    await installFixtureChunks(engine, 'ops/retrieval-policy', [{
      chunk_index: 0,
      chunk_text: 'default-only secret retrieval policy',
      chunk_source: 'compiled_truth',
      token_count: 5,
    }]);

    await engine.putPage('notes/safe', {
      type: 'note',
      title: 'Safe status',
      compiled_truth: 'retrieval policy status for safe source',
    }, { sourceId: 'safe' });
    await installFixtureChunks(engine, 'notes/safe', [{
      chunk_index: 0,
      chunk_text: 'retrieval policy status for safe source',
      chunk_source: 'compiled_truth',
      token_count: 6,
    }], { sourceId: 'safe' });

    await withEnv({
      OPENAI_API_KEY: undefined,
      ZEROENTROPY_API_KEY: undefined,
      VOYAGE_API_KEY: undefined,
      COHERE_API_KEY: undefined,
    }, async () => {
      const rows = await hybridSearch(engine, 'retrieval policy status', {
        limit: 10,
        expansion: false,
        relationalRetrieval: false,
        graph_signals: false,
        sourceIds: ['safe', 'other'],
      });

      expect(rows.some((row) => row.slug === 'notes/safe' && row.source_id === 'safe')).toBe(true);
      expect(rows.some((row) => row.slug === 'ops/retrieval-policy' && row.source_id === 'default')).toBe(false);
    });
  });
});
