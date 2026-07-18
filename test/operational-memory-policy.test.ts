import { describe, expect, test } from 'bun:test';
import { applyOperationalMemoryPolicy, applyRawSourceDemotion } from '../src/core/search/hybrid.ts';
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
});

describe('always-on raw-source demotion (task t_6bdbbd3e)', () => {
  test('demotes raw circleback transcript below canonical spec on an ORDINARY topical query', () => {
    // Reproduces the audit failure: a raw meeting transcript out-ranking the
    // distilled spec for a query that does NOT trip operational-intent gating.
    const rows = [
      result('meetings/circleback/2026-07-03-routing-bug-review', 'meeting', 0.95),
      result('ops/routing-architecture-spec', 'runbook', 0.85),
    ];

    // The operational-memory policy is a no-op here (query is not operational).
    applyOperationalMemoryPolicy(rows, 'routing architecture');
    expect(rows[0].score).toBeCloseTo(0.95); // untouched by the gated policy

    // The always-on demotion fires regardless of intent.
    applyRawSourceDemotion(rows, 'routing architecture');
    const meeting = rows.find(r => r.slug.startsWith('meetings/'))!;
    const spec = rows.find(r => r.slug.startsWith('ops/'))!;
    expect(meeting.score).toBeLessThan(spec.score);
    expect(meeting.raw_source_demotion).toBeLessThan(1);
  });

  test('does NOT demote when the user explicitly asks for the raw transcript', () => {
    const rows = [result('meetings/circleback/2026-07-03-routing-bug-review', 'meeting', 0.95)];
    applyRawSourceDemotion(rows, 'show me the raw meeting transcript about the routing bug');
    expect(rows[0].score).toBeCloseTo(0.95);
    expect(rows[0].raw_source_demotion).toBeUndefined();
  });

  test('leaves canonical / non-raw pages untouched', () => {
    const rows = [
      result('ops/canonical-page-registry', 'canonical-page-registry', 1),
      result('concepts/form-function-configuration', 'concept', 0.9),
    ];
    applyRawSourceDemotion(rows, 'routing architecture');
    expect(rows[0].score).toBeCloseTo(1);
    expect(rows[1].score).toBeCloseTo(0.9);
  });

  test('operator JSON can extend raw_demote_prefixes without source edits', async () => {
    await withEnv({
      GBRAIN_OPERATIONAL_MEMORY_POLICY_JSON: JSON.stringify({
        raw_demote_prefixes: { 'wiki/personal/reflections/': 0.4 },
      }),
    }, async () => {
      const rows = [
        result('wiki/personal/reflections/2026-05-30-gap-analysis', 'reflection', 0.99),
        result('ops/routing-architecture-spec', 'runbook', 0.8),
      ];
      applyRawSourceDemotion(rows, 'routing architecture');
      const reflection = rows.find(r => r.slug.startsWith('wiki/'))!;
      const spec = rows.find(r => r.slug.startsWith('ops/'))!;
      expect(reflection.score).toBeLessThan(spec.score);
    });
  });
});
