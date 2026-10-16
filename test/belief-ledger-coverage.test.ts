/**
 * Belief ledger coverage probes (docs/designs/BELIEF_LEDGER.md section 11:
 * 13, 15, 16, 17, 33) and the coverage tooling they rest on: intervals,
 * certified status, drift and reconcile, commit marks, coverageAt. Each probe
 * asserts exact event types, keys and values on PGLite and on Postgres when
 * DATABASE_URL is set, and each has a forced probe: a deliberately broken
 * emitter (or marker) that must make it fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { __setBeliefEmitterFaultForTests, markBeliefCommits, type BeliefEventDraft } from '../src/core/belief/append.ts';
import { currentStateHash, readLedgerSource, withBeliefBatch } from '../src/core/belief/ledger.ts';
import { deleteSourceRow } from '../src/core/source-delete.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { enableBeliefLedger, disableBeliefLedger } from '../src/core/belief/coverage.ts';
import {
  beliefEventVisibility, coverageAt, coverageIntervals, fillCommitMarks, orphanLifetimes, reconcileBeliefDrift, scanBeliefDrift, unmarkedPublications,
} from '../src/core/belief/coverage-report.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, shape, type BeliefBrain } from './helpers/belief-ledger.ts';

afterEach(() => { __setBeliefEmitterFaultForTests(null); });

const page = (o: Parameters<typeof beliefPage>[0] = {}) => beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff'],
  takes: ['Acme will win its market', 'Acme will hire fast'], links: ['people/alice-example'], ...o });
const fault = (f: (drafts: BeliefEventDraft[]) => BeliefEventDraft[]) => __setBeliefEmitterFaultForTests(f);
/** The database clock rounded up to the next millisecond, so a JS timestamp is never below a microsecond time read before it. */
const dbNow = async (b: BeliefBrain) => new Date(new Date((await b.engine.executeRaw<{ t: string }>(`SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS t`))[0]!.t).getTime()).toISOString();
const pause = () => new Promise(resolve => setTimeout(resolve, 20));

async function seeded(b: BeliefBrain) {
  await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
  await b.put('companies/acme-example', page());
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger coverage (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, opts: { managed?: boolean; enable?: boolean; setup?: (b: BeliefBrain) => Promise<void> } = {}) =>
      beliefBrain(run, { managed: opts.managed ?? true, enable: opts.enable, setup: opts.setup, databaseUrl: engineCase.databaseUrl });

    test('journaled publications leave no drift; the interval is certified on a managed source', async () => {
      await brain(async b => {
        await seeded(b);
        await b.put('companies/acme-example', page({ facts: ['Acme raised a seed round', { claim: 'Acme has ten staff', confidence: '0.5' }] }));
        const scan = await scanBeliefDrift(b.engine, b.sourceId, { deep: true });
        expect(scan.drifted).toEqual([]);
        expect(scan.exact).toBe(true);
        const [interval] = await coverageIntervals(b.engine, b.sourceId);
        expect(interval).toMatchObject({ certified: true, links_certified: 'journaled_only', stopped_at: null, baseline: { complete: true }, drift: [] });
        expect(interval!.watermark).not.toBeNull();
      });
    }, 120_000);

    test('probe 15: unmanaged source, a resolution then its undo between two scans: the hash matches, the interval stays uncertified', async () => {
      const run = async (b: BeliefBrain) => {
        await seeded(b);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        const [interval] = await coverageIntervals(b.engine, b.sourceId);
        await pause();
        const between = await dbNow(b);
        await b.engine.executeRaw(`UPDATE takes SET resolved_at = now(), resolved_outcome = true, resolved_by = 'grader'
          WHERE claim = 'Acme will win its market' AND page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = 'companies/acme-example')`, [b.sourceId]);
        const mid = await scanBeliefDrift(b.engine, b.sourceId, { deep: true });
        expect(mid.drifted.map(d => d.slug)).toEqual(['companies/acme-example']);
        await b.engine.executeRaw(`UPDATE takes SET resolved_at = NULL, resolved_outcome = NULL, resolved_by = NULL
          WHERE claim = 'Acme will win its market' AND page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = 'companies/acme-example')`, [b.sourceId]);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        return { interval: interval!, at: await coverageAt(b.engine, b.sourceId, between, 'companies/acme-example') };
      };
      await brain(async b => {
        const { interval, at } = await run(b);
        expect(interval).toMatchObject({ certified: false, links_certified: false, baseline: { complete: true } });
        expect(at).toMatchObject({ ok: true, certified: false, uncertified_reason: 'unmanaged' });
      }, { managed: false });
      // Forced probe: an emitter that stamps the unmanaged activation certified is caught.
      await brain(async b => {
        const { interval, at } = await run(b);
        expect(interval.certified).toBe(true);
        expect(at).toMatchObject({ ok: true, certified: true });
      }, { managed: false, enable: false, setup: async b => {
        fault(drafts => drafts.map(d => d.eventType === 'coverage.complete' ? { ...d, cause: { ...d.cause, certified: true } } : d));
        await b.enable();
        __setBeliefEmitterFaultForTests(null);
      } });
    }, 180_000);

    test('drift on a managed source: reconcile restates the moved keys and the slug interval stays uncertified after a clean hash', async () => {
      await brain(async b => {
        await seeded(b);
        await b.put('people/bob-example', beliefPage({ type: 'person', title: 'Bob Example' }));
        const before = await b.lastId();
        const prior = (await b.events()).filter(e => e.slug === 'companies/acme-example').at(-1)!;
        await b.engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source, context, origin_page_id)
          SELECT a.id, p.id, 'mentions', 'markdown', 'bypass', a.id FROM pages a, pages p
          WHERE a.source_id = $1 AND a.slug = 'companies/acme-example' AND p.source_id = $1 AND p.slug = 'people/bob-example'`, [b.sourceId]);
        const scan = await scanBeliefDrift(b.engine, b.sourceId, { deep: true });
        expect(scan.drifted.map(d => d.slug)).toEqual(['companies/acme-example']);
        expect(scan.drifted[0]!.recorded_hash).toBe(prior.state_hash);
        const fixed = await reconcileBeliefDrift(b.engine, b.sourceId);
        expect(fixed.reconciled).toEqual(['companies/acme-example']);
        const events = await b.events(before);
        const current = await b.engine.transaction(tx => currentStateHash(tx, b.sourceId, prior.source_incarnation, 'companies/acme-example'));
        // The creation snapshot proves no key, so every current key is restated, then the page carries the full set.
        expect(shape(events).sort()).toEqual(['fact:reconcile', 'fact:reconcile', 'link:reconcile', 'link:reconcile', 'page:reconcile', 'take:reconcile', 'take:reconcile']);
        expect(events.every(e => e.origin === 'reconcile' && e.state_hash === current.hash && e.cause.uncertified_from === new Date(prior.recorded_at).toISOString())).toBe(true);
        const bypass = events.find(e => e.subject_kind === 'link' && e.value!.context === 'bypass')!;
        expect(bypass).toMatchObject({ trust_tier: 'unknown', tier_basis: 'unknown', value: { context: 'bypass', link_kind: null } });
        expect(events.find(e => e.subject_kind === 'page')!.value).toMatchObject({ full_set: true, counts: { facts: 2, takes: 2, links: 2, link_transitions: 0 } });
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        await b.engine.executeRaw(`DELETE FROM links WHERE context = 'bypass'`);
        const again = await reconcileBeliefDrift(b.engine, b.sourceId);
        const second = await b.events(events.at(-1)!.id);
        // A per-key reconcile event now proves every surviving key: only the gone link and the page are written.
        expect(again.reconciled).toEqual(['companies/acme-example']);
        expect(shape(second).sort()).toEqual(['link:reconcile', 'page:reconcile']);
        expect(second.find(e => e.subject_kind === 'link')).toMatchObject({ subject_key: bypass.subject_key, value: null, cause: { absent: true } });
        const [interval] = await coverageIntervals(b.engine, b.sourceId);
        expect(interval!.certified).toBe(true);
        expect(interval!.drift.map(d => [d.slug, d.from])).toEqual([['companies/acme-example', new Date(prior.recorded_at).toISOString()],
          ['companies/acme-example', new Date(events.at(-1)!.recorded_at).toISOString()]]);
        const inside = new Date(new Date(events[0]!.recorded_at).getTime() - 1).toISOString();
        expect(await coverageAt(b.engine, b.sourceId, inside, 'companies/acme-example')).toMatchObject({ ok: true, certified: false, uncertified_reason: 'drift' });
        expect(await coverageAt(b.engine, b.sourceId, await dbNow(b), 'companies/acme-example')).toMatchObject({ ok: true, certified: true });
        // Forced probe: an emitter that drops the page-level reconcile leaves no drift mark, so the interval would read certified.
        fault(drafts => drafts.filter(d => !(d.eventType === 'reconcile' && d.subjectKind === 'page')));
        await b.engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source, context, origin_page_id)
          SELECT a.id, p.id, 'mentions', 'markdown', 'forced', a.id FROM pages a, pages p
          WHERE a.source_id = $1 AND a.slug = 'companies/acme-example' AND p.source_id = $1 AND p.slug = 'people/bob-example'`, [b.sourceId]);
        const marks = (await coverageIntervals(b.engine, b.sourceId))[0]!.drift.length;
        await reconcileBeliefDrift(b.engine, b.sourceId);
        expect((await coverageIntervals(b.engine, b.sourceId))[0]!.drift.length).toBe(marks);
      });
    }, 180_000);

    test('probe 13: a stalled publication stays unproven until its commit mark, then becomes visible; a later event of the page proves it', async () => {
      await brain(async b => {
        await seeded(b);
        const slug = 'companies/acme-example';
        const beforeTx = await dbNow(b);
        await pause();
        const mark = await b.lastId();
        await b.engine.transaction(async tx => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
          await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [slug], op: 'probe_stall', origin: 'unmanaged' }, () =>
            tx.executeRaw(`UPDATE facts SET confidence = 0.4 WHERE source_id = $1 AND fact = 'Acme has ten staff'`, [b.sourceId]));
          await new Promise(resolve => setTimeout(resolve, 400));
        });
        const [event] = await b.events(mark);
        expect(shape([event!])).toEqual(['fact:fact.revised']);
        expect(event!.value).toMatchObject({ fact: 'Acme has ten staff', confidence: 0.4 });
        const stalled = new Date(new Date(event!.recorded_at).getTime() + 100).toISOString();
        const committed = await dbNow(b);
        expect(await unmarkedPublications(b.engine, b.sourceId)).toEqual([event!.publication_id]);
        expect(await beliefEventVisibility(b.engine, event!.id, beforeTx)).toBe('not_visible');
        expect(await beliefEventVisibility(b.engine, event!.id, stalled)).toBe('unproven');
        expect(await beliefEventVisibility(b.engine, event!.id, committed)).toBe('unproven');
        expect(await fillCommitMarks(b.engine, b.sourceId)).toBe(1);
        const marked = await dbNow(b);
        expect(await beliefEventVisibility(b.engine, event!.id, marked)).toBe('visible');
        expect(await beliefEventVisibility(b.engine, event!.id, committed)).toBe('unproven');
        await b.engine.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
        await b.put(slug, page({ prose: 'A later edit.' }));
        const afterLater = await dbNow(b);
        await markBeliefCommits(b.engine, [event!.publication_id]);
        expect(shape(await b.events(event!.id))).toEqual(['page:page.published', 'fact:fact.revised']);
        expect(await beliefEventVisibility(b.engine, event!.id, afterLater)).toBe('visible');
        // Forced probe: a marker that stamps the event's own recorded time (an observer's early transaction start) makes the stalled interval visible.
        await b.engine.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
        await b.engine.executeRaw(`INSERT INTO belief_commit_marks (publication_id, observed_at) SELECT publication_id, max(recorded_at) FROM belief_events
          WHERE publication_id = $1::uuid GROUP BY publication_id`, [event!.publication_id]);
        expect(await beliefEventVisibility(b.engine, event!.id, stalled)).toBe('visible');
      }, { managed: false });
    }, 120_000);

    test('probe 33: an observer that starts before a publication commits and marks it afterwards writes observed_at at or after recorded_at', async () => {
      await brain(async b => {
        await seeded(b);
        const mark = await b.lastId();
        const observe = async (publish: () => Promise<void>) => b.engine.transaction(async obs => {
          const [{ start }] = await obs.executeRaw<{ start: string }>('SELECT now() AS start');
          await publish();
          const other = engineCase.name === 'postgres' ? b.engine : obs;
          const [event] = await other.executeRaw<{ publication_id: string; recorded_at: string }>(`SELECT publication_id::text AS publication_id, recorded_at
            FROM belief_events WHERE source_id = $1 AND id > $2 ORDER BY id LIMIT 1`, [b.sourceId, mark]);
          await other.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
          await markBeliefCommits(obs, [event!.publication_id]);
          const [row] = await obs.executeRaw<{ observed_at: string }>('SELECT observed_at FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
          await obs.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
          await obs.executeRaw(`INSERT INTO belief_commit_marks (publication_id, observed_at) SELECT publication_id, now() FROM belief_events
            WHERE publication_id = $1::uuid GROUP BY publication_id`, [event!.publication_id]);
          const [broken] = await obs.executeRaw<{ observed_at: string }>('SELECT observed_at FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
          return { start: new Date(start).getTime(), recorded: new Date(event!.recorded_at).getTime(), observed: new Date(row!.observed_at).getTime(),
            broken: new Date(broken!.observed_at).getTime() };
        });
        if (engineCase.name === 'postgres') {
          const r = await observe(async () => { await b.put('companies/acme-example', page({ prose: 'Observed edit.' })); });
          expect(r.start).toBeLessThan(r.recorded);
          expect(r.observed).toBeGreaterThanOrEqual(r.recorded);
          // Forced probe: a marker using now() (the observer's start) writes a mark below the event's recorded time.
          expect(r.broken).toBeLessThan(r.recorded);
          return;
        }
        // PGLite runs one transaction at a time, so an observer cannot start before a publication commits: the publication precedes it.
        await b.put('companies/acme-example', page({ prose: 'Observed edit.' }));
        const r = await observe(async () => {});
        expect(r.start).toBeGreaterThanOrEqual(r.recorded);
        expect(r.observed).toBeGreaterThanOrEqual(r.recorded);
        expect(r.broken).toBe(r.start);
      });
    }, 120_000);

    test('probe 16: activation interrupted by a concurrent edit resumes with one consistent cut per page', async () => {
      await brain(async b => {
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        await b.put('companies/acme-example', page());
        await b.put('companies/beta-example', page({ title: 'Beta Example' }));
        await b.put('companies/gamma-example', page({ title: 'Gamma Example' }));
        fault(drafts => { if (drafts.some(d => d.eventType === 'baseline' && d.slug === 'companies/gamma-example')) throw new Error('interrupted'); return drafts; });
        await expect(enableBeliefLedger(b.engine, b.sourceId)).rejects.toThrow('interrupted');
        __setBeliefEmitterFaultForTests(null);
        const [running] = await coverageIntervals(b.engine, b.sourceId);
        expect(running).toMatchObject({ watermark: null, baseline: { pages_done: 2, pending: 2, complete: false } });
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).checked).toBe(0);
        const mark = await b.lastId();
        await b.put('companies/gamma-example', page({ title: 'Gamma Example', facts: ['Acme raised a seed round', 'Gamma has twelve staff'] }));
        const edited = await b.events(mark);
        expect(shape(edited).sort()).toEqual(['fact:fact.asserted', 'fact:fact.retracted', 'page:page.published']);
        const run = await enableBeliefLedger(b.engine, b.sourceId);
        expect(run).toMatchObject({ resumed: true, pages: 2, complete: true, certified: true });
        const events = await b.events();
        const baselines = events.filter(e => e.event_type === 'baseline' && e.subject_kind === 'page');
        expect(baselines.map(e => e.slug).sort()).toEqual(['companies/acme-example', 'companies/beta-example', 'companies/gamma-example', 'people/alice-example']);
        const gamma = events.filter(e => e.slug === 'companies/gamma-example');
        expect(shape(gamma)).toEqual(['page:page.published', 'fact:fact.asserted', 'fact:fact.retracted', 'page:baseline']);
        const cut = gamma.at(-1)!;
        const now = await b.engine.transaction(tx => currentStateHash(tx, b.sourceId, cut.source_incarnation, 'companies/gamma-example'));
        expect(cut.state_hash).toBe(now.hash);
        expect(cut.value).toMatchObject({ snapshot: true, counts: { facts: 2, takes: 2, links: 1 } });
        const edit = new Date(gamma[0]!.recorded_at).toISOString();
        expect(await coverageAt(b.engine, b.sourceId, edit, 'companies/gamma-example')).toMatchObject({ ok: false, code: 'coverage_from', from: new Date(cut.recorded_at).toISOString() });
        expect(await coverageAt(b.engine, b.sourceId, edit, 'companies/acme-example')).toMatchObject({ ok: true, certified: true });
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        const [interval] = await coverageIntervals(b.engine, b.sourceId);
        expect(interval).toMatchObject({ baseline: { pages_done: 4, pending: null, complete: true }, certified: true });
        expect(interval!.watermark).toBe(new Date(events.at(-1)!.recorded_at).toISOString());
      }, { enable: false });
      // Forced probe: a resume whose emitter drops a page's baseline leaves that page with no cut.
      await brain(async b => {
        await b.put('companies/acme-example', page());
        await b.put('companies/gamma-example', page({ title: 'Gamma Example' }));
        fault(drafts => drafts.filter(d => !(d.eventType === 'baseline' && d.slug === 'companies/gamma-example')));
        await enableBeliefLedger(b.engine, b.sourceId);
        __setBeliefEmitterFaultForTests(null);
        const baselines = (await b.events()).filter(e => e.event_type === 'baseline' && e.subject_kind === 'page');
        expect(baselines.map(e => e.slug)).not.toContain('companies/gamma-example');
        expect(await coverageAt(b.engine, b.sourceId, await dbNow(b), 'companies/gamma-example')).toMatchObject({ ok: false, code: 'coverage_from', from: null });
      }, { enable: false });
    }, 180_000);

    test('probe 16: activation after large-page version pruning baselines the page per subject at its current state', async () => {
      await brain(async b => {
        const big = (n: number) => page({ prose: `Edit ${n}. ${'Long prose. '.repeat(100_000)}` });
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        for (let n = 0; n < 7; n++) await b.put('companies/huge-example', big(n));
        const [{ versions }] = await b.engine.executeRaw<{ versions: number }>(`SELECT count(*)::int AS versions FROM page_versions v JOIN pages p ON p.id = v.page_id
          WHERE p.source_id = $1 AND p.slug = 'companies/huge-example'`, [b.sourceId]);
        expect(Number(versions)).toBeLessThan(6);
        await enableBeliefLedger(b.engine, b.sourceId);
        const events = (await b.events()).filter(e => e.slug === 'companies/huge-example');
        expect(shape(events).sort()).toEqual(['fact:baseline', 'fact:baseline', 'link:baseline', 'page:baseline', 'take:baseline', 'take:baseline']);
        const head = events.find(e => e.subject_kind === 'page')!;
        expect(head.value).toMatchObject({ snapshot: false, counts: { facts: 2, takes: 2, links: 1 } });
        const now = await b.engine.transaction(tx => currentStateHash(tx, b.sourceId, head.source_incarnation, 'companies/huge-example'));
        expect(events.every(e => e.state_hash === now.hash && e.origin === 'baseline')).toBe(true);
        expect(events.filter(e => e.subject_kind === 'link').every(e => e.trust_tier === 'unknown' && e.tier_basis === 'unknown')).toBe(true);
        // Forced probe: an emitter that writes the large page as a text-free snapshot drops the values no retained version holds.
        await disableBeliefLedger(b.engine, b.sourceId);
        fault(drafts => drafts.filter(d => d.subjectKind === 'page' || d.eventType !== 'baseline'));
        const mark = await b.lastId();
        await enableBeliefLedger(b.engine, b.sourceId);
        expect(shape((await b.events(mark)).filter(e => e.slug === 'companies/huge-example'))).toEqual(['page:baseline']);
      }, { enable: false });
    }, 300_000);

    test('probe 17: a source removed and re-added with the same id inherits no event, interval or watermark', async () => {
      await brain(async b => {
        await seeded(b);
        const old = (await readLedgerSource(b.engine, b.sourceId))!;
        const oldEvents = await b.events();
        expect(await deleteSourceRow(b.engine, b.sourceId)).toBe(true);
        await b.engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [b.sourceId, b.root]);
        rmSync(join(b.root, 'companies'), { recursive: true, force: true });
        rmSync(join(b.root, 'people'), { recursive: true, force: true });
        await claimWorktree(b.engine, b.sourceId, b.root);
        const fresh = (await readLedgerSource(b.engine, b.sourceId))!;
        expect(fresh.incarnation).not.toBe(old.incarnation);
        expect(fresh.coverage).toBeNull();
        expect(await coverageIntervals(b.engine, b.sourceId)).toEqual([]);
        expect(await coverageAt(b.engine, b.sourceId, await dbNow(b))).toMatchObject({ ok: false, code: 'coverage_from', from: null });
        const mark = await b.lastId();
        await b.put('companies/acme-example', page());
        expect(await b.events(mark)).toEqual([]);
        await enableBeliefLedger(b.engine, b.sourceId);
        const intervals = await coverageIntervals(b.engine, b.sourceId);
        expect(intervals.map(i => [i.incarnation, i.baseline.pages_done])).toEqual([[fresh.incarnation, 1]]);
        expect(Date.parse(intervals[0]!.watermark!)).toBeGreaterThan(new Date(oldEvents.at(-1)!.recorded_at).getTime());
        const after = await b.events(mark);
        expect(after.every(e => e.source_incarnation === fresh.incarnation)).toBe(true);
        const lifetime = after.find(e => e.subject_kind === 'page')!.page_lifetime;
        expect(oldEvents.some(e => e.page_lifetime === lifetime)).toBe(false);
        expect((await b.events()).filter(e => e.source_incarnation === old.incarnation)).toEqual(oldEvents);
        // Forced probe: an emitter that stamps the old incarnation on the new source's coverage hides the new interval.
        await disableBeliefLedger(b.engine, b.sourceId);
        fault(drafts => drafts.map(d => ({ ...d, incarnation: old.incarnation })));
        await enableBeliefLedger(b.engine, b.sourceId).catch(() => null);
        __setBeliefEmitterFaultForTests(null);
        expect((await coverageIntervals(b.engine, b.sourceId)).map(i => i.incarnation)).toEqual([fresh.incarnation]);
        expect((await coverageIntervals(b.engine, b.sourceId)).at(-1)!.stopped_at).not.toBeNull();
      }, { managed: false });
    }, 120_000);
  });
}
