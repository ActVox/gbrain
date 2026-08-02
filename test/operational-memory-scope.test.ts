import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
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
  test('multi-source grants never inject canonical pages from an ungranted source', async () => {
    await engine.putPage('ops/retrieval-policy', {
      type: 'retrieval-policy',
      title: 'Private default retrieval policy',
      compiled_truth: 'default-only secret retrieval policy',
    });
    await engine.upsertChunks('ops/retrieval-policy', [{
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
    await engine.upsertChunks('notes/safe', [{
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
