/**
 * Result-time collapse through bare hybridSearch on PGLite (#4612, #7153,
 * #7154): twins in another source, redirect stubs and copies of one document
 * take one slot, the folded pages stay named in `collapsed`, and pages that
 * only look alike (templated notes, a person and a company sharing a slug
 * leaf) keep their own slots. `search.collapse false` reproduces the
 * pre-collapse output, which is the failure shape each case pins.
 * Hermetic: a hash bag-of-words embedder through `queryEmbedFn`; network off.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { type CollapseDecision, collapseResults, redirectTargetSlug } from '../../src/core/search/collapse.ts';
import { fnv1a } from '../../src/eval/deterministic-embed.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';

const DIM = 1536;
function hashEmbed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (const tok of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const h = fnv1a(tok);
    v[Math.abs(h) % DIM] += (h & 1) === 0 ? 1 : -1;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

const LONG = (topic: string) => `${topic} memo. ` + 'The team reviewed the quarterly plan, the hiring targets and the vendor shortlist, then agreed on owners and dates. '.repeat(4);

interface Seed { slug: string; source?: string; type: string; title: string; body: string; frontmatter?: Record<string, unknown>; date?: string }
const SEEDS: Seed[] = [
  // twins: the same slug in two sources
  { slug: 'concepts/zephyr-ledger', type: 'concept', title: 'Zephyr ledger', body: 'Zephyr ledger: the shared accounting ledger for the zephyr program, reconciled weekly.' },
  { slug: 'concepts/zephyr-ledger', source: 'team-example', type: 'concept', title: 'Zephyr ledger', body: 'Zephyr ledger: the shared accounting ledger for the zephyr program, reconciled weekly.' },
  // a redirect stub (frontmatter redirect_to with a leading slash, markdown link body) whose target is in the pool
  { slug: 'concepts/zephyr-ledger-old', type: 'concept-redirect', title: 'Zephyr ledger', body: 'Zephyr ledger. See [Zephyr ledger](/concepts/zephyr-ledger).', frontmatter: { redirect_to: '/concepts/zephyr-ledger' } },
  // a redirect stub whose target never matches the query: it is read in
  { slug: 'concepts/quill-roster-old', type: 'concept', title: 'Quill roster', body: 'This page has been merged into [[people/bram-example]].' },
  { slug: 'people/bram-example', type: 'person', title: 'Bram Example', body: 'Bram Example runs the night shift scheduling for the harbor depot.' },
  // a bare-word redirect that names two pages: ambiguous, so the stub stays and says where it points
  { slug: 'concepts/kestrel-plan-old', type: 'concept-redirect', title: 'Kestrel plan', body: 'Kestrel plan moved.', frontmatter: { redirect_to: 'kestrel' } },
  { slug: 'projects/kestrel', type: 'project', title: 'Kestrel', body: 'Kestrel project overview.' },
  { slug: 'notes/kestrel', type: 'note', title: 'Kestrel', body: 'Kestrel note.' },
  // a document family by derivative suffix
  { slug: 'media/orbit-talk', type: 'media', title: 'Orbit talk', body: 'Orbit talk verbatim: orbit launch cadence, orbit telemetry and the orbit budget.' },
  { slug: 'media/orbit-talk-summary', type: 'media', title: 'Orbit talk summary', body: 'Orbit talk summary: launch cadence, telemetry, budget for orbit.' },
  { slug: 'media/orbit-talk-transcript', type: 'media', title: 'Orbit talk transcript', body: 'Orbit talk transcript, diarized: orbit launch cadence and orbit telemetry.' },
  { slug: 'notes/orbit-answer', type: 'note', title: 'Orbit answer', body: 'Orbit answer: the orbit launch cadence is every six weeks.' },
  // identical bodies under two types
  { slug: 'concepts/heron-memo', type: 'concept', title: 'Heron memo', body: LONG('Heron') },
  { slug: 'notes/heron-memo', type: 'note', title: 'Heron memo', body: LONG('Heron') },
  // a meeting and its transcript: one leaf extends the other on the same date
  { slug: 'meetings/2026-03-02-lumen-sync', type: 'meeting', title: 'Lumen sync', body: 'Lumen sync notes: lumen pricing decision and lumen rollout.', date: '2026-03-02' },
  { slug: 'transcripts/2026-03-02-lumen-sync-call', type: 'transcript', title: 'Lumen sync call', body: 'Lumen sync call transcript: lumen pricing decision discussed, lumen rollout.', date: '2026-03-02' },
  // look-alikes that must keep their own slots
  ...[1, 2, 3].map(i => ({ slug: `notes/standup-${i}`, type: 'note', title: `Standup ${i}`, body: `Standup ${i}: blockers none. ` + 'Yesterday we shipped the badge reader fix and today we test the badge reader. '.repeat(4) })),
  { slug: 'people/nimbus-example', type: 'person', title: 'Nimbus Example', body: 'Nimbus Example founded the nimbus weather service.' },
  { slug: 'companies/nimbus-example', type: 'company', title: 'Nimbus Example', body: 'Nimbus Example is the nimbus weather service company.' },
];

let engine: PGLiteEngine;
const realFetch = globalThis.fetch;
const search = async (q: string, extra: Record<string, unknown> = {}) => {
  let meta: HybridSearchMeta | null = null;
  const rows = await hybridSearch(engine, q, { limit: 20, queryEmbedFn: hashEmbed, onMeta: m => { meta = m; }, ...extra });
  return { rows, meta: meta as HybridSearchMeta | null };
};
const keys = (rows: SearchResult[]) => [...new Set(rows.map(r => `${r.source_id}:${r.slug}`))];
const row = (rows: SearchResult[], slug: string) => rows.find(r => r.slug === slug);

beforeAll(async () => {
  globalThis.fetch = (async () => { throw new Error('collapse test: network disabled'); }) as unknown as typeof fetch;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team-example', 'team-example') ON CONFLICT (id) DO NOTHING`);
  for (const s of SEEDS) {
    const sourceId = s.source ?? 'default';
    await engine.putPage(s.slug, { type: s.type, title: s.title, compiled_truth: s.body, ...(s.frontmatter ? { frontmatter: s.frontmatter } : {}) }, { sourceId });
    await installFixtureChunks(engine, s.slug, [{ chunk_index: 0, chunk_text: s.body, chunk_source: 'compiled_truth' as const, embedding: hashEmbed(s.body), token_count: s.body.split(/\s+/).length }], { sourceId });
    if (s.date) await engine.executeRaw(`UPDATE pages SET effective_date = $1::date, effective_date_source = 'date' WHERE slug = $2 AND source_id = $3`, [s.date, s.slug, sourceId]);
  }
}, 120_000);

afterEach(async () => { await engine.unsetConfig('search.collapse'); });
afterAll(async () => {
  globalThis.fetch = realFetch;
  await engine.disconnect();
});

describe('redirectTargetSlug', () => {
  test('wikilinks, markdown links, leading slashes, .md and anchors all name the slug', () => {
    expect(redirectTargetSlug('[[people/x|X]]')).toBe('people/x');
    expect(redirectTargetSlug('[X](/companies/x.md#top)')).toBe('companies/x');
    expect(redirectTargetSlug('/concepts/y')).toBe('concepts/y');
    expect(redirectTargetSlug('kestrel')).toBe('kestrel');
    expect(redirectTargetSlug('https://example.com/a')).toBeNull();
    expect(redirectTargetSlug('  ')).toBeNull();
  });
});

describe('twins and redirect stubs', () => {
  test('off: the twin and the stub each take a slot (the failure shape)', async () => {
    await engine.setConfig('search.collapse', 'false');
    const { rows } = await search('zephyr ledger');
    const zephyr = keys(rows).filter(k => k.includes('zephyr-ledger'));
    expect(zephyr).toEqual(expect.arrayContaining(['default:concepts/zephyr-ledger', 'team-example:concepts/zephyr-ledger', 'default:concepts/zephyr-ledger-old']));
  });

  test('on: one slot, the twin and the stub listed on it', async () => {
    const { rows, meta } = await search('zephyr ledger');
    const zephyr = keys(rows).filter(k => k.includes('zephyr-ledger'));
    expect(zephyr).toHaveLength(1);
    const kept = rows.find(r => r.slug === 'concepts/zephyr-ledger')!;
    expect(kept.collapsed).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'concepts/zephyr-ledger-old', source_id: 'default', reason: 'redirect' }),
      expect.objectContaining({ slug: 'concepts/zephyr-ledger', reason: 'twin' }),
    ]));
    expect(meta?.collapse?.twins).toBeGreaterThanOrEqual(1);
    expect(meta?.collapse?.redirects).toBeGreaterThanOrEqual(1);
  });

  test('a stub whose target the pool lacks returns the target in its slot', async () => {
    await engine.setConfig('search.collapse', 'false');
    const { rows } = await search('quill roster', { limit: 50 });
    const stub = row(rows, 'concepts/quill-roster-old')!;
    const other = row(rows, 'notes/orbit-answer')!;
    const decisions: CollapseDecision[] = [];
    const out = await collapseResults(engine, [{ ...stub, collapsed: undefined }, other], { onDecision: d => decisions.push(d) });
    expect(out.map(r => r.slug)).toEqual(['people/bram-example', 'notes/orbit-answer']);
    expect(out[0]).toMatchObject({ source_id: 'default', score: stub.score, collapsed: [{ slug: 'concepts/quill-roster-old', source_id: 'default', reason: 'redirect' }] });
    expect(out[0].chunk_text).toContain('night shift');
    expect(decisions).toEqual([{ twins: 0, redirects: 1, families: 0, redirect_reads: 1 }]);
    const scoped = await collapseResults(engine, [{ ...stub, collapsed: undefined }, other], { sourceIds: ['team-example'] });
    expect(scoped[0]).toMatchObject({ slug: 'concepts/quill-roster-old', redirect_to: 'people/bram-example' });
  });

  test('a read-in target honors the exclude contract: the stub stays, stamped redirect_to', async () => {
    const { rows } = await search('quill roster', { exclude_slug_prefixes: ['people/'] });
    expect(row(rows, 'people/bram-example')).toBeUndefined();
    expect(row(rows, 'concepts/quill-roster-old')?.redirect_to).toBe('people/bram-example');
  });

  test('an ambiguous bare-word target leaves the stub with redirect_to', async () => {
    const { rows } = await search('kestrel plan');
    expect(row(rows, 'concepts/kestrel-plan-old')?.redirect_to).toBe('kestrel');
  });
});

describe('document families', () => {
  test('derivative suffixes fold into the best-ranked copy; the answer page keeps its slot', async () => {
    await engine.setConfig('search.collapse', 'false');
    const off = await search('orbit talk launch cadence telemetry');
    expect(keys(off.rows).filter(k => k.includes('orbit-talk'))).toHaveLength(3);
    await engine.unsetConfig('search.collapse');
    const { rows } = await search('orbit talk launch cadence telemetry');
    const family = rows.filter(r => r.slug.startsWith('media/orbit-talk'));
    expect(family).toHaveLength(1);
    expect(family[0].collapsed?.map(c => c.reason)).toEqual(['family', 'family']);
    expect(row(rows, 'notes/orbit-answer')).toBeDefined();
  });

  test('identical bodies under two types fold', async () => {
    const { rows } = await search('heron memo quarterly plan');
    expect(rows.filter(r => r.slug.endsWith('/heron-memo'))).toHaveLength(1);
  });

  test('a meeting and its same-day transcript fold', async () => {
    const { rows } = await search('lumen sync pricing decision rollout');
    expect(rows.filter(r => r.slug.includes('lumen-sync'))).toHaveLength(1);
  });

  test('templated notes and a person and company sharing a leaf keep their own slots', async () => {
    const standups = await search('standup badge reader');
    expect(keys(standups.rows).filter(k => k.includes('standup-'))).toHaveLength(3);
    const nimbus = await search('nimbus weather service');
    expect(row(nimbus.rows, 'people/nimbus-example')).toBeDefined();
    expect(row(nimbus.rows, 'companies/nimbus-example')).toBeDefined();
  });
});
