import { describe, expect, test } from 'bun:test';
import { applyOperationalMemoryPolicy } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

function result(slug: string, type: string, score = 1): SearchResult {
  return {
    slug,
    page_id: Math.floor(Math.random() * 100000),
    title: slug,
    type,
    chunk_text: slug,
    chunk_source: 'compiled_truth',
    chunk_id: Math.floor(Math.random() * 100000),
    chunk_index: 0,
    score,
    stale: false,
    source_id: 'default',
  };
}

describe('operational memory retrieval policy', () => {
  test('boosts canonical action pages and demotes raw meetings for action/status queries', () => {
    const rows = [
      result('meetings/circleback/2026-06-20-project-status', 'meeting', 2),
      result('ops/current-actions', 'synthesized-action-page', 1),
    ];

    applyOperationalMemoryPolicy(rows, 'project current actions status');

    expect(rows.find(r => r.slug === 'ops/current-actions')!.score)
      .toBeGreaterThan(rows.find(r => r.slug.startsWith('meetings/'))!.score);
  });

  test('does not demote raw meetings when user asks for transcript/source evidence', () => {
    const rows = [result('meetings/circleback/2026-06-20-project-status', 'meeting', 2)];

    applyOperationalMemoryPolicy(rows, 'show me the raw meeting transcript for project status');

    expect(rows[0].score).toBe(2);
  });

  test('operator policy JSON can add private/local intent rules without hardcoding them in source', async () => {
    await withEnv({
      GBRAIN_OPERATIONAL_MEMORY_POLICY_JSON: JSON.stringify({
        intent_patterns: ['\\bproject-alpha\\b'],
        boost_prefixes: { 'private/current-alpha': 3 },
        demote_prefixes: { 'raw/imports/': 0.2 },
      }),
    }, async () => {
      const rows = [
        result('raw/imports/alpha-call', 'meeting', 5),
        result('private/current-alpha', 'note', 1),
      ];

      applyOperationalMemoryPolicy(rows, 'project-alpha status');

      expect(rows.find(r => r.slug === 'private/current-alpha')!.score)
        .toBeGreaterThan(rows.find(r => r.slug === 'raw/imports/alpha-call')!.score);
    });
  });

  test('operator patterns are case-insensitive and catastrophic shapes degrade safely', async () => {
    await withEnv({
      GBRAIN_OPERATIONAL_MEMORY_POLICY_JSON: JSON.stringify({
        intent_patterns: ['PROJECT-ALPHA', '(a+)+$'],
        boost_prefixes: { 'private/current-alpha': 3 },
      }),
    }, async () => {
      const matched = [result('private/current-alpha', 'note', 1)];
      applyOperationalMemoryPolicy(matched, 'project-alpha');
      expect(matched[0].score).toBe(3);

      const degraded = [result('private/current-alpha', 'note', 1)];
      applyOperationalMemoryPolicy(degraded, `${'a'.repeat(2_000)}!`);
      expect(degraded[0].score).toBe(1);
    });
  });
});
