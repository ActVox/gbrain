/**
 * Wave B PR 2 fix lane C2 (D3): timeline retraction reads a segmented page's
 * retained versions.
 *
 * 1. Protects: a dated bullet an earlier segmented version held and the
 *    current body no longer holds is retracted (its row was produced by a
 *    version of the page). A segmented page_versions row has NULL body
 *    columns and references a body generation, so the reconciliation streams
 *    that generation's stored text block by block (each block once: the work
 *    counter equals the live body's bytes plus the retained generation's).
 * 2. Fails when: the retraction reads the segmented version's NULL columns
 *    (the text `null\n`), finds no version producing the row, and keeps the
 *    removed bullet's row forever.
 * 3. Why existing coverage misses it: segmented-derived-passes.test.ts seeds
 *    an inline version only.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set. Seams: segmentedPassWork (a work counter, not time).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { extractTimelineFromDB } from '../../src/commands/extract-timeline-db.ts';
import { pruneTimelineOrphans } from '../../src/core/timeline-extract.ts';
import { segmentedPassWork } from '../../src/core/page-body/segment-blocks.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const SLUG = 'notes/segmented-retract';
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const KICKOFF = '- **2026-03-04** | Kickoff with the design team';
const PRICING = '- **2026-04-05** | Pricing review';

/** ~2.4 MiB, the dated bullets after the first ~1.2 MiB. */
const page = (bullets: string[]) => `---\ntype: note\ntitle: Retract\n---\n\n${conversationBody(1_200_000, { seed: 41 })}\n\n`
  + `${conversationBody(1_200_000, { seed: 42 })}\n\n## Timeline\n\n${bullets.join('\n')}\n`;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
});

describe('timeline retraction over segmented versions', () => {
  test('a bullet only a retained segmented generation held is retracted, reading that generation once', async () => {
    for (const engine of engines) {
      await engine.setConfig('pages.segmented_storage', 'on');
      expect(await importFromContent(engine, SLUG, page([KICKOFF, PRICING]), { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
      await extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: 'default', slugs: [SLUG] });
      const rows = async () => (await engine.executeRaw<{ summary: string }>(`SELECT t.summary FROM timeline_entries t JOIN pages p ON p.id=t.page_id
        WHERE p.slug=$1 AND t.event_page_id IS NULL ORDER BY t.date`, [SLUG])).map(row => row.summary);
      expect(await rows()).toEqual(['Kickoff with the design team', 'Pricing review']);
      expect(await importFromContent(engine, SLUG, page([KICKOFF]), { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
      const [live] = await engine.executeRaw<{ id: number; body_storage: string; body_bytes: number; body_generation: number }>(
        'SELECT id, body_storage, body_bytes, body_generation FROM pages WHERE slug=$1', [SLUG]);
      expect(live!.body_storage).toBe('segmented');
      const versions = await engine.executeRaw<{ body_storage: string; body_bytes: number; body_generation: number; compiled_truth: string | null }>(
        'SELECT body_storage, body_bytes, body_generation, compiled_truth FROM page_versions WHERE page_id=$1', [live!.id]);
      // The rewrite versioned the page first: a reference to the older generation, its body columns NULL.
      const retained = new Map(versions.map(v => [Number(v.body_generation), Number(v.body_bytes)]));
      expect(versions.every(v => v.body_storage === 'segmented' && v.compiled_truth === null)).toBe(true);
      expect([...retained.keys()].every(g => g < Number(live!.body_generation))).toBe(true);
      const before = segmentedPassWork.bytes;
      const pruned = await pruneTimelineOrphans(engine, { sourceId: 'default', dryRun: false });
      expect({ removed: pruned.removed, rows: await rows(), bytes: segmentedPassWork.bytes - before })
        .toEqual({ removed: 1, rows: ['Kickoff with the design team'], bytes: Number(live!.body_bytes) + [...retained.values()].reduce((a, b) => a + b, 0) });
    }
  }, 600_000);
});
