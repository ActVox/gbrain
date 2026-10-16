/**
 * W4 weekly change diff (10x plan, wave 4a): `delta {beliefs: true}` and `gbrain beliefs changes` answer "what changed this
 * week" as a cited belief diff from the belief ledger: before, after, cause and an evidence pointer per belief, netted over
 * the window. Each cell runs on PGLite and on Postgres when DATABASE_URL is set; forced probes show the cell can fail.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { beliefsChangesArgs, runBeliefs } from '../src/commands/beliefs.ts';
import { currentExitCode, setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import { operationsByName } from '../src/core/operations.ts';
import { beliefChanges, renderBeliefChange, type BeliefChange } from '../src/core/belief/changes.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const dbNow = async (b: BeliefBrain) => (await b.engine.executeRaw<{ t: string }>('SELECT clock_timestamp() AS t'))[0]!.t;
const at = async (b: BeliefBrain) => { await pause(); const t = new Date(await dbNow(b)).toISOString(); await pause(); return t; };
const changes = (b: BeliefBrain, since: string, until: string, extra: { remote?: boolean; entities?: string[] } = {}) =>
  beliefChanges(b.engine, { sourceId: b.sourceId, since, until, remote: extra.remote ?? false, entities: extra.entities });
const brief = (cs: BeliefChange[]) => cs.map(c => [c.kind, c.change, c.kind === 'fact' || c.kind === 'take' ? c.subject.claim : c.kind === 'page' ? c.slug : `${c.subject.link_type}:${c.subject.to}${c.subject.transition ? `:${c.subject.transition}` : ''}`]);
const sorted = (rows: unknown[][]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const slug = 'companies/acme-example';

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger weekly change diff (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>) => beliefBrain(run, { managed: true, databaseUrl: engineCase.databaseUrl });

    test('edits in the window: a revised fact, a replaced claim, a take, a new link; each with before, after, cause and evidence', () => brain(async b => {
      await b.put('companies/widget-co', beliefPage({ title: 'Widget' }));
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', { claim: 'Acme has 40 staff', confidence: '0.6' }], takes: [{ claim: 'Acme will IPO', weight: '0.4' }] }));
      const t0 = await at(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells gadgets', { claim: 'Acme has 40 staff', confidence: '0.9' }], takes: [{ claim: 'Acme will IPO', weight: '0.7' }],
        links: ['companies/widget-co'] }));
      const t1 = await at(b);
      const diff = await changes(b, t0, t1);
      expect(diff.coverage_from).toBeNull();
      const facts = diff.changes.filter(c => c.kind === 'fact');
      expect(facts.map(c => [c.change, c.before?.fact ?? null, c.after?.fact ?? null, c.before_known])).toEqual(expect.arrayContaining([
        ['removed', 'Acme sells widgets', null, true], ['added', null, 'Acme sells gadgets', true], ['changed', 'Acme has 40 staff', 'Acme has 40 staff', true]]));
      expect(facts).toHaveLength(3);
      const revised = facts.find(c => c.change === 'changed')!;
      expect([revised.before!.confidence, revised.after!.confidence]).toEqual([0.6, 0.9]);
      expect(revised.cause).toMatchObject({ event: 'fact.revised', op: 'put_page' });
      expect(revised.evidence).toMatchObject({ slug, row: 2 });
      expect(facts.find(c => c.change === 'added')!.cause.replaces).toEqual(expect.any(String));
      const take = diff.changes.find(c => c.kind === 'take')!;
      expect([take.change, take.before!.weight, take.after!.weight]).toEqual(['changed', 0.4, 0.7]);
      expect(diff.changes.filter(c => c.kind === 'link').map(c => [c.change, c.subject.to])).toEqual([['added', 'companies/widget-co']]);
      const events = await b.events();
      for (const c of diff.changes) expect(events.find(e => e.id === c.evidence.event_id)?.recorded_at).toBeDefined();
      expect(renderBeliefChange(revised)).toContain('put_page, event ');
      // Narrowed to an entity the change does not touch, nothing is left; to the link's target, only the link.
      expect((await changes(b, t0, t1, { entities: ['people/nobody'] })).changes).toEqual([]);
      const link = diff.changes.find(c => c.kind === 'link')!;
      expect((await changes(b, t0, t1, { entities: ['companies/widget-co'] })).changes).toEqual([link]);
      // Forced probe: with the page's versions gone, a value that only the body at t0 held is disclosed as unknown, never guessed.
      await b.engine.executeRaw('DELETE FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = $2)', [b.sourceId, slug]);
      const blind = (await changes(b, t0, t1)).changes.find(c => c.kind === 'fact' && c.subject.claim === 'Acme has 40 staff')!;
      expect([blind.before, blind.before_known]).toEqual([null, false]);
    }), 120_000);

    test('the window nets out: an edit and its revert report nothing; a page created inside it lists its facts and takes', () => brain(async b => {
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets'] }));
      const t0 = await at(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells gadgets'] }));
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets'] }));
      await b.put('companies/widget-co', beliefPage({ title: 'Widget', facts: ['Widget makes sprockets'], takes: ['Widget will grow'] }));
      const t1 = await at(b);
      const diff = await changes(b, t0, t1);
      expect(sorted(brief(diff.changes))).toEqual(sorted([['page', 'added', 'companies/widget-co'], ['fact', 'added', 'Widget makes sprockets'], ['take', 'added', 'Widget will grow']]));
      // The same window read across the revert alone shows the change it undid.
      const mid = (await b.events()).find(e => e.subject_kind === 'fact' && e.event_type === 'fact.asserted' && (e.value as { fact?: string })?.fact === 'Acme sells gadgets')!;
      const half = await changes(b, t0, new Date(new Date(mid.recorded_at).getTime() + 1).toISOString());
      expect(sorted(brief(half.changes))).toEqual(sorted([['fact', 'removed', 'Acme sells widgets'], ['fact', 'added', 'Acme sells gadgets']]));
    }), 120_000);

    test('an inferred relationship end is reported as an upper bound', () => brain(async b => {
      await b.put('companies/acme-example', '---\ntype: company\ntitle: Acme\n---\nA company.\n');
      await b.put('companies/widget-co', '---\ntype: company\ntitle: Widget\n---\nAnother company.\n');
      const timeline = (extra: string[]) => ['---', 'type: person', 'title: Alice Example', '---', 'Alice.', '', '## Timeline', '',
        '- **2019-02-01** | linkedin — Joined [Acme](../companies/acme-example) as CTO', '- **2025-03-01** | linkedin — Joined [Widget](../companies/widget-co) as CTO', ...extra, ''].join('\n');
      await b.put('people/alice-example', timeline([]));
      const t0 = await at(b);
      await b.put('people/alice-example', timeline(['- **2025-03-01** | gbrain-dream (inferred) — Ended works_at [[companies/acme-example]] (superseded by works_at companies/widget-co)']));
      const t1 = await at(b);
      const end = (await changes(b, t0, t1)).changes.find(c => c.kind === 'link_transition' && c.subject.transition === 'end')!;
      expect(end).toMatchObject({ change: 'added', upper_bound: true, subject: { to: 'companies/acme-example', date: '2025-03-01', producer: 'dream' } });
      expect(renderBeliefChange(end)).toContain('end by 2025-03-01');
      expect(renderBeliefChange(end)).toContain('inferred end, an upper bound');
    }), 120_000);

    test('remote callers see only world beliefs on pages visible now; before the ledger the window says coverage_from', () => brain(async b => {
      const early = await at(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', { claim: 'Acme is in talks with Fund A', visibility: 'private' }] }));
      await b.put('people/secret-example', beliefPage({ title: 'Secret', type: 'person', facts: ['Secret person fact'], frontmatter: { visibility: 'private' } }));
      const t0 = await at(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells gadgets', { claim: 'Acme signed with Fund A', visibility: 'private' }] }));
      await b.put('people/secret-example', beliefPage({ title: 'Secret', type: 'person', facts: ['Secret person fact, revised'], frontmatter: { visibility: 'private' } }));
      const t1 = await at(b);
      const local = await changes(b, t0, t1);
      expect(local.changes.some(c => c.slug === 'people/secret-example')).toBe(true);
      expect(local.changes.some(c => c.subject.claim === 'Acme signed with Fund A')).toBe(true);
      const remote = await changes(b, t0, t1, { remote: true });
      expect(sorted(brief(remote.changes))).toEqual(sorted([['fact', 'removed', 'Acme sells widgets'], ['fact', 'added', 'Acme sells gadgets']]));
      expect(JSON.stringify(remote)).not.toContain('Fund A');
      expect(JSON.stringify(remote)).not.toContain('Secret');
      // Takes follow the takes surfaces' holder rule: a remote caller reads world-held takes only, both a revised take and the takes of
      // a page created in the window (N6 found the held take leaking through both paths before the rule was applied).
      const t2 = await at(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells gadgets', { claim: 'Acme signed with Fund A', visibility: 'private' }],
        takes: [{ claim: 'Acme is the public favorite', who: 'world', weight: '0.6' }, { claim: 'Acme is privately doubted', who: 'garry-example', weight: '0.3' }] }));
      await b.put('companies/newco-example', beliefPage({ title: 'Newco', takes: [{ claim: 'Newco looks public', who: 'world' }, { claim: 'Newco is privately loved', who: 'garry-example' }] }));
      const t3 = await at(b);
      const takesLocal = (await changes(b, t2, t3)).changes.filter(c => c.kind === 'take').map(c => c.subject.claim);
      expect(takesLocal.sort()).toEqual(['Acme is privately doubted', 'Acme is the public favorite', 'Newco is privately loved', 'Newco looks public']);
      const takesRemote = await changes(b, t2, t3, { remote: true });
      expect(takesRemote.changes.filter(c => c.kind === 'take').map(c => c.subject.claim).sort()).toEqual(['Acme is the public favorite', 'Newco looks public']);
      expect(JSON.stringify(takesRemote)).not.toContain('privately');
      const granted = await beliefChanges(b.engine, { sourceId: b.sourceId, since: t2, until: t3, remote: true, takesHolders: ['world', 'garry-example'] });
      expect(granted.changes.filter(c => c.kind === 'take')).toHaveLength(4);
      const before = await b.engine.executeRaw<{ t: string }>(`SELECT min(recorded_at) AS t FROM belief_events WHERE source_id = $1`, [b.sourceId]);
      const old = new Date(Date.parse(before[0]!.t) - 86_400_000).toISOString();
      expect((await changes(b, old, early)).coverage_from).toEqual(expect.any(String));
    }), 120_000);

    test('delta {beliefs: true} carries the diff and its text section; budget_tokens truncates it, and a remote caller gets the world view', () => brain(async b => {
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets'] }));
      const t0 = await at(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells gadgets', 'Acme opened an office in Berlin'] }));
      await pause(); await pause();
      const delta = (params: Record<string, unknown>, remote = false) => operationsByName.delta!.handler({ ...b.ctx, remote, ...(remote ? { auth: { clientId: 'w4-remote', scopes: ['read'] } } : {}) } as never, { since: t0, ...params }) as Promise<Record<string, any>>;
      await new Promise(r => setTimeout(r, 2_500));
      const full = await delta({ beliefs: true });
      expect(sorted(brief(full.beliefs.changes))).toEqual(sorted([['fact', 'removed', 'Acme sells widgets'], ['fact', 'added', 'Acme sells gadgets'], ['fact', 'added', 'Acme opened an office in Berlin']]));
      expect(full.text).toContain('## Belief changes since');
      expect(full.text).toContain('Acme opened an office in Berlin');
      expect((await delta({})).beliefs).toBeUndefined();
      const tight = await delta({ beliefs: true, budget_tokens: 200 });
      expect(tight.beliefs.truncated).toBe(true);
      expect(tight.beliefs.changes.length).toBeLessThan(3);
      expect(tight.budget_used).toBeLessThanOrEqual(200);
      const remote = await delta({ beliefs: true }, true);
      expect(remote.beliefs.changes).toHaveLength(3);
      // An empty window adds no section and leaves the wake's text as it was.
      const later = new Date(Date.now() + 60_000).toISOString();
      const quiet = [await delta({ since: later }), await delta({ since: later, beliefs: true })];
      expect(quiet[1]!.beliefs.changes).toEqual([]);
      expect(quiet[1]!.text).toBe(quiet[0]!.text);
    }), 120_000);

    test('gbrain beliefs changes prints the same diff for an entity and a --since window, and refuses a bad --since', () => brain(async b => {
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets'] }));
      const t0 = await at(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells gadgets'] }));
      await b.put('companies/widget-co', beliefPage({ facts: ['Widget Co makes widgets'] }));
      const t1 = await at(b);
      const logs: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
      try {
        await runBeliefs(b.engine, ['changes', slug, '--since', t0, '--source', b.sourceId]);
      } finally { log.mockRestore(); }
      const expected = await changes(b, t0, t1, { entities: [slug] });
      const printed = logs.join('\n').split('\n');
      expect(printed[0]).toStartWith(`Belief changes on ${b.sourceId} from ${t0} to `);
      expect(printed.slice(1)).toEqual(expected.changes.map(renderBeliefChange));
      expect(printed.join('\n')).toContain('Acme sells gadgets');
      expect(printed.join('\n')).not.toContain('Widget Co');
      expect(beliefsChangesArgs(['changes', 'a', '--source', 's', 'b', '--since', '7d'], Date.parse('2026-10-08T00:00:00Z')))
        .toEqual({ entities: ['a', 'b'], since: '2026-10-01T00:00:00.000Z' });
      const err = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await runBeliefs(b.engine, ['changes', '--since', 'last tuesday', '--source', b.sourceId]);
      } finally { err.mockRestore(); }
      expect(currentExitCode()).toBe(2);
      setCliExitVerdict(0);
    }), 120_000);
  });
}
