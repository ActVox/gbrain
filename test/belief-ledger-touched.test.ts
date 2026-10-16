/**
 * Belief ledger write-overhead probes (docs/designs/BELIEF_LEDGER.md section 9):
 * a fence projection leaves rows that already hold their values unwritten, and
 * the batch's post-read reuses the pre-read for every table the transaction did
 * not write (its pg_stat_xact counter is unchanged). Each probe runs on PGLite
 * and on Postgres when DATABASE_URL is set; the forced probe suppresses the
 * touched signal and shows the drift check catches the event it loses.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { __suppressBeliefTouchedSignalForTests, readBeliefState, type RawState } from '../src/core/belief/state.ts';
import { withBeliefBatch } from '../src/core/belief/ledger.ts';
import { keyedSubjects } from '../src/core/belief/subjects.ts';
import { beliefLedgerEntry } from '../src/commands/doctor/checks/belief-ledger.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, shape, type BeliefBrain } from './helpers/belief-ledger.ts';

afterEach(() => { __suppressBeliefTouchedSignalForTests(false); });

const SLUG = 'companies/acme-example';
const page = (o: Parameters<typeof beliefPage>[0] = {}) => beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff', 'Acme is in Austin'],
  takes: ['Acme will win its market', 'Acme will hire fast'], links: ['people/alice-example'], ...o });

/** Every fact and take row of the page with its row version (xmin moves on any rewrite, identical values included). */
async function rowVersions(b: BeliefBrain): Promise<string[]> {
  const rows = await b.engine.executeRaw<{ r: string }>(`SELECT 'fact:' || f.id || ':' || f.xmin::text AS r FROM facts f
      WHERE f.source_id = $1 AND f.source_markdown_slug = $2
    UNION ALL SELECT 'take:' || k.id || ':' || k.xmin::text FROM takes k JOIN pages p ON p.id = k.page_id WHERE p.source_id = $1 AND p.slug = $2
    ORDER BY 1`, [b.sourceId, SLUG]);
  return rows.map(r => r.r);
}

async function doctor(b: BeliefBrain): Promise<Check> {
  const [check] = await beliefLedgerEntry.run({ engine: b.engine, tier: 'standard', doFix: false, dryRun: false, orphanRatioSourceId: b.sourceId } as DoctorContext) as Check[];
  return check!;
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger write overhead (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, managed = true) => beliefBrain(run, { managed, databaseUrl: engineCase.databaseUrl });
    const seeded = async (b: BeliefBrain) => {
      await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
      await b.put(SLUG, page());
    };

    test('a prose-only edit rewrites no fact or take row and records no belief event', async () => {
      await brain(async b => {
        await seeded(b);
        const versions = await rowVersions(b);
        expect(versions).toHaveLength(5);
        const before = await b.lastId();
        await b.put(SLUG, page({ prose: 'Rewritten prose only.' }));
        expect(shape(await b.events(before))).toEqual(['page:page.published']);
        expect(await rowVersions(b)).toEqual(versions);
      });
    }, 120_000);

    test('a one-value change among identical rows rewrites that row alone and is recorded', async () => {
      await brain(async b => {
        await seeded(b);
        const versions = await rowVersions(b);
        const before = await b.lastId();
        await b.put(SLUG, page({ facts: ['Acme raised a seed round', { claim: 'Acme has ten staff', confidence: '0.5' }, 'Acme is in Austin'] }));
        const events = await b.events(before);
        expect(shape(events)).toEqual(['page:page.published', 'fact:fact.revised']);
        expect(events[1]!.value).toMatchObject({ confidence: 0.5 });
        const changed = (await rowVersions(b)).filter(v => !versions.includes(v));
        expect(changed).toHaveLength(1);
        expect(changed[0]!.startsWith('fact:')).toBe(true);
        const mark = await b.lastId();
        await b.put(SLUG, page({ facts: ['Acme raised a seed round', { claim: 'Acme has ten staff', confidence: '0.5' }, 'Acme is in Austin'],
          takes: [{ claim: 'Acme will win its market', weight: '0.9' }, 'Acme will hire fast'] }));
        expect(shape(await b.events(mark))).toEqual(['page:page.published', 'take:take.revised']);
      });
    }, 120_000);

    test('forced probe: with the touched signal suppressed the change goes unrecorded and the drift check names the slug', async () => {
      await brain(async b => {
        await seeded(b);
        expect((await doctor(b)).status).toBe('ok');
        const before = await b.lastId();
        __suppressBeliefTouchedSignalForTests(true);
        await b.put(SLUG, page({ facts: ['Acme raised a seed round', { claim: 'Acme has ten staff', confidence: '0.5' }, 'Acme is in Austin'] }));
        __suppressBeliefTouchedSignalForTests(false);
        expect(shape(await b.events(before))).toEqual(['page:page.published']);
        const drifted = await doctor(b);
        expect(drifted.status).toBe('warn');
        expect(drifted.message).toContain(`${b.sourceId}: 1 drifted slug(s) (e.g. ${SLUG})`);
      });
    }, 120_000);

    test('a batch reads state under generic plans and leaves its projections and the rest of the transaction on the mode it found', async () => {
      await brain(async b => {
        await seeded(b);
        const modes = await b.engine.transaction(async tx => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug: SLUG }]);
          await tx.executeRaw("SET LOCAL plan_cache_mode = 'force_custom_plan'");
          const mode = async () => (await tx.executeRaw<{ m: string }>("SELECT current_setting('plan_cache_mode') AS m"))[0]!.m;
          const inside = await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [SLUG], op: 'probe_plan_mode' }, mode);
          return [inside, await mode()];
        });
        expect(modes).toEqual(['force_custom_plan', 'force_custom_plan']);
        await expect(b.engine.transaction(async tx => {
          await tx.executeRaw("SET LOCAL plan_cache_mode = 'force_custom_plan'");
          try { await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [SLUG], op: 'probe_unheld' }, async () => null); } catch {}
          return (await tx.executeRaw<{ m: string }>("SELECT current_setting('plan_cache_mode') AS m"))[0]!.m;
        })).resolves.toBe('force_custom_plan');
      });
    }, 120_000);

    test('with track_counts off the post-read reads every table again', async () => {
      await brain(async b => {
        await seeded(b);
        await b.engine.transaction(async tx => {
          await tx.executeRaw('SET LOCAL track_counts = off');
          const pre = await readBeliefState(tx, b.sourceId, [SLUG]);
          await tx.executeRaw(`UPDATE facts SET confidence = 0.25 WHERE source_id = $1 AND source_markdown_slug = $2 AND fact = 'Acme is in Austin'`, [b.sourceId, SLUG]);
          const post = await readBeliefState(tx, b.sourceId, [SLUG], pre.pages.map(p => p.id), pre);
          expect(post.facts.find(f => f.fact === 'Acme is in Austin')!.confidence).toBe(0.25);
          await tx.executeRaw('SET LOCAL track_counts = on');
          const counted = await readBeliefState(tx, b.sourceId, [SLUG]);
          await tx.executeRaw(`UPDATE facts SET confidence = 0.75 WHERE source_id = $1 AND source_markdown_slug = $2 AND fact = 'Acme is in Austin'`, [b.sourceId, SLUG]);
          const recounted = await readBeliefState(tx, b.sourceId, [SLUG], counted.pages.map(p => p.id), counted);
          expect(recounted.facts.find(f => f.fact === 'Acme is in Austin')!.confidence).toBe(0.75);
          expect(recounted.takes).toBe(counted.takes);
          throw new Error('rollback');
        }).catch(e => { if ((e as Error).message !== 'rollback') throw e; });
      }, false);
    }, 120_000);
  });
}

test('reused take subjects take their visibility from the side they are keyed for', () => {
  const page = { id: 7, slug: SLUG, deleted: false, revision: '1', content_hash: null, tier: 'unknown', visible: true, large: false, incarnation: 'i' };
  const take = { id: 70, page_id: 7, row_num: 1, claim: 'Acme will win', claim_fp: 'fp', kind: 'take', holder: 'brain', weight: 0.5, since_date: null,
    until_date: null, source: null, active: true, resolved_at: null, resolved_outcome: null, resolved_value: null, resolved_unit: null, resolved_source: null,
    resolved_by: null, resolved_quality: null, tier: 'unknown' };
  const pre: RawState = { pages: [page], facts: [], takes: [take], links: [], transitions: [], writerTier: null };
  const post: RawState = { ...pre, pages: [{ ...page, visible: false }] };
  const ctx = (state: RawState) => ({ incarnation: 'i', lifetimes: new Map([[7, '00000000-0000-0000-0000-000000000007']]), pagesBySlug: new Map(state.pages.map(p => [p.slug, p])) });
  const visibility = (state: RawState) => (id: number) => state.pages.find(p => p.id === id)?.visible === false ? 'private' : 'world';
  const before = keyedSubjects(ctx(pre), pre, visibility(pre));
  const after = keyedSubjects(ctx(post), post, visibility(post), { state: pre, subjects: before });
  expect(before.map(s => s.visibility)).toEqual(['world']);
  expect(after.map(s => [s.key, s.visibility])).toEqual([[before[0]!.key, 'private']]);
});
