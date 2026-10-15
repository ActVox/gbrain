/**
 * Wave B segmented storage: visibility and GC under races (PR 2 switch-on blockers).
 *
 * 1. Protects: a demoted page never shows a racing preparation's chunks, and
 *    the preparation cannot stage more after the demotion; rows of retired
 *    occurrences a deferred retirement left behind are invisible to every
 *    generation reader (embed queue, unsealed chunk reads) before they are
 *    deleted; a text a preparation staged or deduped onto survives a sweep
 *    until publication references it; a page-scoped sweep collects only the
 *    texts its page released; chunks of a shifted occurrence keep stored
 *    spans that hold their text in the new body; segment GC's staged-chunk
 *    delete reads an index, not the whole chunk table; v249 drops
 *    content_chunks.retired_generation, which no reader still names.
 * 2. Fails when: visibility trusts body_generation alone, stageSegmentChunks
 *    skips the page's current generation and storage, text staging leaves a
 *    deduped text unlocked and its grace unrefreshed, the text sweep ignores
 *    live stagings, a page sweep scans its source's texts, raw spans are
 *    absolute body offsets, content_chunks_generation_idx is missing, or
 *    v249 leaves retired_generation behind or a chunk reader still names it.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import * as pageBodySql from '../../src/core/engine-sql/page-body.ts';
import type { SqlExecutor } from '../../src/core/engine-sql/executor.ts';
import { sqlFragment, type SqlFragment } from '../../src/core/engine-sql/fragment.ts';
import { chunk, publishSegmentedPage, segmentText } from '../helpers/page-body-fixtures.ts';
import { cpuMsAsync } from '../helpers/cpu-time.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { v249 } from '../../src/core/schema-migrations/v249-segmented-chunk-gc-index.ts';

/** ~1.4 MB of sections, each its own segment. */
function sections(tag: string, n = 60): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`## Section ${tag}${i}\n\n` + `Paragraph ${i} of ${tag} about widgets and gadgets number ${i}. `.repeat(400) + '\n\n');
  return parts.join('');
}
const page = (body: string) => `---\ntitle: Visibility\ntype: note\n---\n\n${body}`;
const squash = (s: string) => s.replace(/\s+/g, '');
const CHUNKING = { quarantined: false, corpusGeneration: null, tier: 'none' } as const;

for (const kind of testBackends()) {
  describe(`segmented storage visibility and GC (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw('DELETE FROM page_body_stagings');
      await engine.executeRaw('DELETE FROM page_segment_texts');
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.setConfig('pages.flip_retire_max_rows', '20000');
    });

    async function stage(slug: string, content: string) {
      const existing = await engine.getPage(slug, { sourceId: 'default' });
      const parsed = parseMarkdown(content, `${slug}.md`);
      const staged = await stageSegmentedImport(engine, { slug, sourceId: 'default', existing,
        page: { title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: parsed.tags },
        policy: await readPageBodyPolicy(engine), chunking: CHUNKING, baseRevision: null });
      const apply = () => engine.transaction(tx => staged.apply(tx, { type: parsed.type, title: parsed.title, frontmatter: parsed.frontmatter, page_kind: 'markdown' },
        { mode: 'none', corpusGeneration: null }));
      return { staged, apply };
    }

    async function generationReaderTexts(slug: string): Promise<string[]> {
      return (await engine.getChunks(slug, { sourceId: 'default', includeUnsealed: true })).map(c => c.chunk_text);
    }

    test('a demoted page shows none of a racing preparation\'s chunks, and the preparation stages no more', async () => {
      const slug = 'notes/demoted-race';
      await importFromContent(engine, slug, page(sections('a')), { sourceId: 'default', noEmbed: true });
      const { id } = await segmentedPageRow(engine, slug);
      const { staged } = await stage(slug, page('## Intro\n\nA quixotic new first paragraph.\n\n' + sections('a')));
      expect(await engine.searchKeyword('quixotic')).toEqual([]);
      const occurrence = (await engine.readManifest(id, { stagingId: staged.prepared.stagingId }))[0]!.occurrenceId;
      await importFromContent(engine, slug, page('Short replacement body.\n'), { sourceId: 'default', noEmbed: true });
      const demoted = await segmentedPageRow(engine, slug);
      expect([demoted.body_storage, demoted.body_generation]).toEqual(['inline', staged.prepared.newGeneration]);

      const refused = await engine.stageSegmentChunks(id, staged.prepared.newGeneration, [chunk(occurrence, 0, 'UNPUBLISHED quixotic staged text')])
        .then(() => null, (e: unknown) => e);
      expect((refused as { canonical?: string } | null)?.canonical).toBe('revision_changed');

      expect(await engine.searchKeyword('quixotic')).toEqual([]);
      expect(await generationReaderTexts(slug)).toEqual(['Short replacement body.']);

      // A row that bypassed the guard stays invisible to generation readers: its occurrence closed with the demotion.
      await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, occurrence_id, local_ordinal, body_generation)
        VALUES ($1, 100000, 'UNPUBLISHED quixotic staged text', 'compiled_truth', $2, 0, $3)`, [id, occurrence, staged.prepared.newGeneration]);
      expect(await generationReaderTexts(slug)).toEqual(['Short replacement body.']);
      expect((await engine.listStaleChunks({ batchSize: 1000 })).map(r => r.chunk_text)).not.toContain('UNPUBLISHED quixotic staged text');
    }, 180_000);

    test.skipIf(kind !== 'postgres')('a demotion waits for a chunk batch in flight and deletes its rows (the page row lock the guard relies on)', async () => {
      const slug = 'notes/demoted-in-flight';
      await importFromContent(engine, slug, page(sections('a')), { sourceId: 'default', noEmbed: true });
      const { id } = await segmentedPageRow(engine, slug);
      const { staged } = await stage(slug, page('## Intro\n\nA new first paragraph.\n\n' + sections('a')));
      const occurrence = (await engine.readManifest(id, { stagingId: staged.prepared.stagingId }))[0]!.occurrenceId;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const holding = new Promise<void>(resolve => { locked = resolve; });
      const batch = engine.transaction(async tx => {
        await tx.executeRaw("SELECT pg_advisory_xact_lock(hashtextextended('gbrain:page-body-chunks:' || $1::text, 0))", [id]);
        await tx.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, occurrence_id, local_ordinal, body_generation)
          VALUES ($1, 100000, 'in-flight lollapalooza staged text', 'compiled_truth', $2, 0, $3)`, [id, occurrence, staged.prepared.newGeneration]);
        locked();
        await gate;
      });
      await holding;
      let demoted = false;
      const demotion = importFromContent(engine, slug, page('Short replacement body.\n'), { sourceId: 'default', noEmbed: true }).then(() => { demoted = true; });
      await new Promise(resolve => setTimeout(resolve, 1000));
      const waited = !demoted;
      release();
      await batch;
      await demotion;
      expect(waited).toBe(true);
      expect(await engine.searchKeyword('lollapalooza')).toEqual([]);
      const [left] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1 AND occurrence_id IS NOT NULL', [id]);
      expect(Number(left!.n)).toBe(0);
    }, 180_000);

    test('a deferred retirement hides the old body\'s rows from generation readers before they are deleted', async () => {
      const slug = 'notes/deferred-retire';
      await importFromContent(engine, slug, page(sections('a')), { sourceId: 'default', noEmbed: true });
      const { id } = await segmentedPageRow(engine, slug);
      await engine.setConfig('pages.flip_retire_max_rows', '5');
      const { staged, apply } = await stage(slug, page(sections('b')));
      expect((await apply()).retireDeferred).toBe(true);
      const [old] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1 AND body_generation < $2`,
        [id, staged.prepared.newGeneration]);
      expect(Number(old!.n)).toBeGreaterThan(5);
      const texts = await generationReaderTexts(slug);
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.filter(text => text.includes(' of a about '))).toEqual([]);
      const stale = (await engine.listStaleChunks({ batchSize: 100_000 })).map(r => r.chunk_text);
      expect(stale.filter(text => text.includes(' of a about '))).toEqual([]);
      expect(stale.some(text => text.includes(' of b about '))).toBe(true);
    }, 180_000);

    test('a create published after its texts aged past the grace window and a sweep ran still publishes', async () => {
      const slug = 'notes/slow-publication';
      const { staged, apply } = await stage(slug, page(sections('c')));
      await engine.executeRaw(`UPDATE page_segment_texts SET created_at = now() - interval '2 hours'`);
      await engine.executeRaw(`UPDATE page_body_stagings SET created_at = now() - interval '3 hours' WHERE id = $1`, [staged.prepared.stagingId]);
      await engine.sweepSegments({ sourceId: 'default' });
      await apply();
      const body = await materializeSegmentedBody(engine, (await segmentedPageRow(engine, slug)).id, 'default');
      expect(body.compiled_truth).toBe(parseMarkdown(page(sections('c')), `${slug}.md`).compiled_truth);
    }, 180_000);

    test('a create that dedupes onto old orphan texts keeps them through a sweep before it publishes', async () => {
      const content = page(sections('d'));
      await importFromContent(engine, 'notes/orphaned', content, { sourceId: 'default', noEmbed: true });
      expect((await segmentedPageRow(engine, 'notes/orphaned')).body_storage).toBe('segmented');
      await engine.executeRaw(`DELETE FROM pages WHERE slug = 'notes/orphaned'`);
      await engine.executeRaw(`UPDATE page_segment_texts SET created_at = now() - interval '2 hours'`);
      const [orphans] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_segment_texts');
      expect(Number(orphans!.n)).toBeGreaterThan(3);
      const { apply } = await stage('notes/dedupe', content);
      await engine.sweepSegments({ sourceId: 'default' });
      await apply();
      const body = await materializeSegmentedBody(engine, (await segmentedPageRow(engine, 'notes/dedupe')).id, 'default');
      expect(body.compiled_truth).toBe(parseMarkdown(content, 'notes/dedupe.md').compiled_truth);
    }, 180_000);

    test('a page-scoped sweep collects the texts its page released and leaves the rest of the source', async () => {
      const slug = 'notes/page-sweep';
      await importFromContent(engine, slug, page(sections('e')), { sourceId: 'default', noEmbed: true });
      const { id } = await segmentedPageRow(engine, slug);
      const orphan = Buffer.from('an orphan text another page released\n');
      const orphanSha = createHash('sha256').update(orphan).digest();
      await engine.stageSegmentTexts('default', [{ sha256: orphanSha, body: orphan, lineCount: 1 }]);
      const released = await engine.readManifest(id);
      expect(released.length).toBeGreaterThan(3);
      await importFromContent(engine, slug, page(sections('f')), { sourceId: 'default', noEmbed: true });
      await engine.executeRaw('DELETE FROM page_versions WHERE page_id = $1', [id]);
      await engine.executeRaw(`UPDATE page_segment_texts SET created_at = now() - interval '2 hours'`);
      const swept = await engine.sweepSegments({ pageId: id });
      expect(swept.textsDeleted).toBe(new Set(released.map(row => Buffer.from(row.sha256).toString('hex'))).size);
      expect((await engine.readSegmentTexts('default', [orphanSha])).size).toBe(1);
      expect((await engine.sweepSegments({ sourceId: 'default' })).textsDeleted).toBe(1);
    }, 180_000);

    test.skipIf(kind !== 'pglite')('a page-scoped sweep costs the same in a source ten times larger', async () => {
      const seeded = async (texts: number) => {
        const sourceId = `sweep-${texts}`;
        await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [sourceId]);
        const { pageId } = await publishSegmentedPage(engine, `notes/sweep-${texts}`, [segmentText('# Page\nbody\n')], { sourceId });
        for (let start = 0; start < texts; start += 2000) {
          await engine.stageSegmentTexts(sourceId, Array.from({ length: Math.min(2000, texts - start) }, (_, i) => segmentText(`text ${start + i} of ${sourceId}\n`)));
        }
        return pageId;
      };
      const small = await seeded(1000);
      const large = await seeded(10_000);
      const best = async (pageId: number) => {
        let ms = Infinity;
        for (let k = 0; k < 3; k++) ms = Math.min(ms, await cpuMsAsync(async () => { for (let n = 0; n < 300; n++) await engine.sweepSegments({ pageId }); }));
        return ms;
      };
      await best(small);
      await best(large);
      const ratios: number[] = [];
      for (let round = 0; round < 3; round++) ratios.push(await best(large) / await best(small));
      expect(ratios.sort((a, b) => a - b)[1]!).toBeLessThan(1.5);
    }, 180_000);

    test('chunks of a shifted occurrence keep stored spans that hold their text in the new body', async () => {
      const slug = 'notes/shifted-spans';
      await importFromContent(engine, slug, page(sections('g')), { sourceId: 'default', noEmbed: true });
      const { id } = await segmentedPageRow(engine, slug);
      await importFromContent(engine, slug, page('## Intro\n\nA new first paragraph.\n\n' + sections('g')), { sourceId: 'default', noEmbed: true });
      const row = await segmentedPageRow(engine, slug);
      const body = Buffer.from((await materializeSegmentedBody(engine, id, 'default')).compiled_truth, 'utf8');
      const chunks = await engine.executeRaw<{ chunk_text: string; byte_start: number; raw_byte_start: number; raw_byte_end: number; shifted: boolean }>(`
        SELECT c.chunk_text, m.byte_start::int AS byte_start, c.raw_byte_start::int AS raw_byte_start, c.raw_byte_end::int AS raw_byte_end,
               (c.body_generation < m.gen_from) AS shifted
          FROM content_chunks c JOIN page_body_manifest m ON m.page_id = c.page_id AND m.occurrence_id = c.occurrence_id
           AND m.staging_id IS NULL AND m.gen_to IS NULL
         WHERE c.page_id = $1 AND c.projected_byte_start IS NOT NULL AND m.region = 'truth'`, [id]);
      const shifted = chunks.filter(c => c.shifted);
      expect(row.body_generation).toBe(2);
      expect(shifted.length).toBeGreaterThan(10);
      for (const c of chunks) {
        expect(squash(body.subarray(c.byte_start + c.raw_byte_start, c.byte_start + c.raw_byte_end).toString('utf8'))).toBe(squash(c.chunk_text));
      }
    }, 180_000);

    test('v249 drops retired_generation from a v248 brain and builds the GC index; no chunk reader names the column', async () => {
      const columns = async () => (await engine.executeRaw<{ attname: string }>(
        "SELECT attname FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attnum > 0 AND NOT attisdropped")).map(r => r.attname);
      expect(await columns()).not.toContain('retired_generation');
      await importFromContent(engine, 'notes/upgraded', page(sections('u')), { sourceId: 'default', noEmbed: true });
      await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN retired_generation BIGINT');
      await engine.executeRaw('DROP INDEX content_chunks_generation_idx');
      await engine.executeRaw(v249.sql);
      await v249.handler!(engine);
      expect(await columns()).not.toContain('retired_generation');
      const [index] = await engine.executeRaw<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'content_chunks_generation_idx'");
      expect(index?.indexdef).toContain('WHERE (body_generation IS NOT NULL)');
      for (const excludePrivate of [false, true]) {
        expect((await engine.searchKeyword('widgets', { limit: 5, excludePrivate, requireSafeChunks: false })).length).toBeGreaterThan(0);
        expect((await engine.getChunks('notes/upgraded', { sourceId: 'default', excludePrivate, requireSafeChunks: false })).length).toBeGreaterThan(0);
      }
      expect((await generationReaderTexts('notes/upgraded')).length).toBeGreaterThan(0);
    }, 120_000);

    test('the unscoped staged-chunk GC reads content_chunks through an index, never a full scan', async () => {
      for (let p = 0; p < 40; p++) {
        await engine.putPage(`notes/inline-${p}`, { type: 'note', title: `Inline ${p}`, compiled_truth: `inline ${p}`, timeline: '', frontmatter: {} });
      }
      await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
        SELECT p.id, g, 'inline chunk ' || g, 'compiled_truth' FROM pages p CROSS JOIN generate_series(1, 500) g WHERE p.slug LIKE 'notes/inline-%'`);
      await importFromContent(engine, 'notes/gc-plan', page(sections('h')), { sourceId: 'default', noEmbed: true });
      await engine.executeRaw('ANALYZE content_chunks');
      await engine.executeRaw('ANALYZE pages');
      const exec = (engine as unknown as { engineSql: SqlExecutor }).engineSql;
      const plans: string[] = [];
      const explaining = Object.assign(Object.create(exec) as SqlExecutor, {
        run: async (fragment: SqlFragment) => {
          const { rows } = await exec.run<Record<string, string>>(sqlFragment`EXPLAIN ${fragment}`);
          plans.push(rows.map(r => Object.values(r)[0]).join('\n'));
          return { rows: [], affectedRows: 0 };
        },
      });
      await pageBodySql.sweepSegments(explaining, { expireStagings: true });
      const chunkGc = plans.find(plan => /Delete on content_chunks/.test(plan));
      expect(chunkGc).toBeDefined();
      expect(chunkGc).not.toMatch(/Seq Scan on content_chunks/);
      expect(chunkGc).toMatch(/content_chunks_generation_idx/);
    }, 180_000);
  });
}
