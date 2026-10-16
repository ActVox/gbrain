/**
 * W2 page-at-time probes (docs/designs/BELIEF_LEDGER.md section 10):
 * `get_page {known_as_of}` and `get_versions {known_as_of}` read the page as
 * this brain had recorded it at an instant, from validity intervals over the
 * ledger's publication events. Each cell of section 10's table, plus the
 * coverage, clock and purge refusals, runs on PGLite and on Postgres when
 * DATABASE_URL is set, and each has a forced probe that must make it fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operationsByName } from '../src/core/operations.ts';
import { withBeliefBatch } from '../src/core/belief/ledger.ts';
import { fillCommitMarks } from '../src/core/belief/coverage-report.ts';
import { backfillBeliefHistory } from '../src/core/belief/backfill.ts';
import { replayPurgesInRestore } from '../src/core/belief/purge-mirror.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { __setBeliefEmitterFaultForTests } from '../src/core/belief/append.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitForValue } from './helpers/wait-for.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

afterEach(() => __setBeliefEmitterFaultForTests(null));

const dbNow = async (b: BeliefBrain) => new Date(new Date((await b.engine.executeRaw<{ t: string }>(`SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS t`))[0]!.t).getTime()).toISOString();
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const at = async (b: BeliefBrain) => { await pause(); const t = await dbNow(b); await pause(); return t; };
const iso = (v: string) => new Date(v).toISOString();
const plus = (v: string, ms: number) => new Date(Date.parse(v) + ms).toISOString();
const read = (b: BeliefBrain, params: Record<string, unknown>) => operationsByName.get_page!.handler(b.ctx, params) as Promise<Record<string, any>>;
const versions = (b: BeliefBrain, params: Record<string, unknown>) => operationsByName.get_versions!.handler(b.ctx, params) as Promise<Record<string, any>>;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; reason?: string; retryable?: boolean; message: string }) => e);
const draft = (prose: string) => beliefPage({ prose, facts: ['Acme sells widgets'] });
const pageEvents = async (b: BeliefBrain, slug: string) => (await b.events()).filter(e => e.subject_kind === 'page' && e.slug === slug && e.origin !== 'backfill');

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger page-at-time (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, opts: { managed?: boolean; enable?: boolean } = {}) =>
      beliefBrain(run, { managed: opts.managed ?? true, enable: opts.enable, databaseUrl: engineCase.databaseUrl });
    const slug = 'companies/acme-example';

    test('before, at and after creation and each of two edits: each instant reads the body of its interval, never the preimage newest at T', () => brain(async b => {
      const before = await at(b);
      await b.put(slug, draft('First draft.'));
      const t1 = await at(b);
      await b.put(slug, draft('Second draft.'));
      const t2 = await at(b);
      await b.put(slug, draft('Third draft.'));
      const t3 = await at(b);
      const [create, edit1, edit2] = await pageEvents(b, slug);
      expect([create, edit1, edit2].map(e => e!.event_type)).toEqual(['page.published', 'page.published', 'page.published']);
      expect((await refusal(read(b, { slug, known_as_of: before })))?.code).toBe('page_not_found');
      const body = async (t: string) => { const r = await read(b, { slug, known_as_of: t }); return [r.compiled_truth.trim().split('\n')[0], r.body, r.event_id]; };
      expect(await body(t1)).toEqual(['First draft.', 'version', create!.id]);
      expect(await body(t2)).toEqual(['Second draft.', 'version', edit1!.id]);
      expect(await body(t3)).toEqual(['Third draft.', 'live', edit2!.id]);
      // At the instant an edit was recorded, before its commit was observed and with no later event of the page by then, the read is unproven, not answered.
      const atEdit = await refusal(read(b, { slug, known_as_of: iso(edit1!.recorded_at) }));
      expect(atEdit).toMatchObject({ code: 'known_as_of_unproven', retryable: true });
      const t1Read = await read(b, { slug, known_as_of: t1 });
      expect(t1Read).toMatchObject({ slug, deleted: false, until: null, certified: true, uncertified_reason: null, source_id: b.sourceId, known_as_of: t1 });
      const history = await versions(b, { slug, known_as_of: t3, include_body: true, diff: true });
      expect(history.versions.map((v: any) => [v.event_id, v.body, v.until])).toEqual([[edit2!.id, 'live', null], [edit1!.id, 'version', iso(edit2!.recorded_at)], [create!.id, 'version', iso(edit1!.recorded_at)]]);
      expect(history.versions[0].diff).toContain('-Second draft.');
      expect(history.versions[0].diff).toContain('+Third draft.');
      expect(history.versions[2].diff).toContain('+First draft.');
      expect((await versions(b, { slug, known_as_of: t1 })).versions.map((v: any) => [v.event_id, v.until])).toEqual([[create!.id, null]]);
      // The design's premise: the newest preimage at or before T is the wrong side of an edit.
      const [naive] = await b.engine.executeRaw<{ compiled_truth: string }>(`SELECT v.compiled_truth FROM page_versions v JOIN pages p ON p.id = v.page_id
        WHERE p.source_id = $1 AND p.slug = $2 AND v.snapshot_at <= $3::timestamptz ORDER BY v.id DESC LIMIT 1`, [b.sourceId, slug, t2]);
      expect(naive!.compiled_truth).toContain('First draft.');
      // Forced probe: with the preimages gone, the closed intervals disclose the missing body instead of borrowing the live one.
      await b.engine.executeRaw('DELETE FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = $2)', [b.sourceId, slug]);
      expect(await read(b, { slug, known_as_of: t2 })).toMatchObject({ body: 'unavailable', body_reason: 'version_missing' });
      expect((await read(b, { slug, known_as_of: t2 })).compiled_truth).toBeUndefined();
    }), 120_000);

    test('a write straddling T is unproven until its commit mark; a later event of the page proves it; a mark stamped at recorded time would answer it', () => brain(async b => {
      await b.put(slug, draft('First draft.'));
      await pause();
      await b.put(slug, draft('Second draft.'));
      const edit = (await pageEvents(b, slug)).at(-1)!;
      await b.engine.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [edit.publication_id]);
      const stalled = plus(iso(edit.recorded_at), 1);
      await pause();
      const unproven = await refusal(read(b, { slug, known_as_of: stalled }));
      expect(unproven).toMatchObject({ code: 'known_as_of_unproven', retryable: true });
      expect((await read(b, { slug, known_as_of: plus(iso(edit.recorded_at), -1) })).compiled_truth).toContain('First draft.');
      expect(await fillCommitMarks(b.engine, b.sourceId)).toBe(1);
      const marked = await at(b);
      expect((await read(b, { slug, known_as_of: marked })).compiled_truth).toContain('Second draft.');
      expect((await refusal(read(b, { slug, known_as_of: stalled })))?.code).toBe('known_as_of_unproven');
      await b.put(slug, draft('Third draft.'));
      const later = await at(b);
      await b.engine.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [edit.publication_id]);
      expect((await versions(b, { slug, known_as_of: later })).versions.map((v: any) => v.event_id)).toContain(edit.id);
      // Forced probe: a mark stamped at the event's own recorded time (an observer's early transaction start) answers the straddling instant.
      await b.engine.executeRaw(`INSERT INTO belief_commit_marks (publication_id, observed_at) SELECT publication_id, max(recorded_at) FROM belief_events
        WHERE publication_id = $1::uuid GROUP BY publication_id`, [edit.publication_id]);
      expect((await read(b, { slug, known_as_of: stalled })).compiled_truth).toContain('Second draft.');
    }), 120_000);

    test('a rolled-back write leaves no event and no interval', () => brain(async b => {
      await b.put(slug, draft('First draft.'));
      const mark = await b.lastId();
      await b.engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
        await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [slug], op: 'probe_rollback', origin: 'unmanaged' }, () =>
          tx.executeRaw(`UPDATE pages SET compiled_truth = 'Rolled back.', knowledge_revision = gen_random_uuid() WHERE source_id = $1 AND slug = $2`, [b.sourceId, slug]));
        throw new Error('rollback');
      }).catch(() => undefined);
      expect(await b.events(mark)).toEqual([]);
      const t = await at(b);
      expect((await read(b, { slug, known_as_of: t })).compiled_truth).toContain('First draft.');
      expect((await versions(b, { slug, known_as_of: t })).versions).toHaveLength(1);
    }), 120_000);

    test('delete then recreate: a soft delete and put restore the same lifetime; a purge and put mint a new one, and the purged lifetime keeps no body', () => brain(async b => {
      const revision = async () => (await b.engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, slug]))[0]!.r;
      await b.put(slug, draft('First draft.'));
      const t1 = await at(b);
      await b.op('delete_page', { slug, expected_revision: await revision() });
      const deleted = await at(b);
      await b.put(slug, draft('Back again.'));
      const t2 = await at(b);
      expect((await refusal(read(b, { slug, known_as_of: deleted })))?.code).toBe('page_not_found');
      expect(await read(b, { slug, known_as_of: deleted, include_deleted: true })).toMatchObject({ deleted: true, event: 'page.deleted', body: 'version' });
      expect((await read(b, { slug, known_as_of: deleted, include_deleted: true })).compiled_truth).toContain('First draft.');
      expect((await read(b, { slug, known_as_of: t1 })).compiled_truth).toContain('First draft.');
      expect((await read(b, { slug, known_as_of: t2 })).compiled_truth).toContain('Back again.');
      expect((await versions(b, { slug, known_as_of: t2 })).versions.map((v: any) => [v.event, v.deleted])).toEqual([['page.restored', false], ['page.deleted', true], ['page.published', false]]);
      expect(new Set((await pageEvents(b, slug)).map(e => e.page_lifetime)).size).toBe(1);
      await b.op('delete_page', { slug, purge: true, expected_revision: await revision() });
      const purged = await at(b);
      await b.put(slug, draft('Recreated.'));
      const t3 = await at(b);
      expect(new Set((await pageEvents(b, slug)).map(e => e.page_lifetime)).size).toBe(2);
      expect((await refusal(read(b, { slug, known_as_of: purged, include_deleted: true })))?.code).toBe('page_not_found');
      expect((await read(b, { slug, known_as_of: t3 })).compiled_truth).toContain('Recreated.');
      const history = await versions(b, { slug, known_as_of: t3, include_body: true });
      expect(history.versions.map((v: any) => [v.event, v.body, v.body_reason ?? null])).toEqual([['page.published', 'live', null], ['page.purged', 'unavailable', 'purged'],
        ['page.restored', 'unavailable', 'purged'], ['page.deleted', 'unavailable', 'purged'], ['page.published', 'unavailable', 'purged']]);
      expect(JSON.stringify(history)).not.toContain('First draft.');
      expect(JSON.stringify(history)).not.toContain('Back again.');
    }), 120_000);

    test('create, forget, materialize, edit: the pre-forget body, the withdrawn view and the materialized body each answer their own instant', () => brain(async b => {
      await b.put(slug, beliefPage({ prose: 'Profile.', facts: ['Acme raised a seed round', 'Acme has ten staff'] }));
      const created = await at(b);
      const [fact] = await b.engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id = $1 AND fact = 'Acme has ten staff' AND expired_at IS NULL`, [b.sourceId]);
      const mark = await b.lastId();
      await operationsByName.forget!.handler(b.ctx, { id: String(fact!.id), request_id: randomUUID() });
      const materialized = await waitForValue(async () => (await b.events(mark)).find(e => e.cause.op === 'withdrawal_materialize'), { timeoutMs: 30_000, label: 'withdrawal materialization' });
      const afterMaterialize = await at(b);
      await b.put(slug, beliefPage({ prose: 'Profile, edited.', facts: ['Acme raised a seed round'] }));
      const edited = await at(b);
      const forget = (await b.events(mark)).find(e => e.cause.op === 'forget' && e.subject_kind === 'page')!;
      expect((await read(b, { slug, known_as_of: created })).compiled_truth).toContain('Acme has ten staff');
      const history = await versions(b, { slug, known_as_of: edited, include_body: true });
      expect(history.versions.map((v: any) => [v.event, v.body])).toEqual([['page.published', 'live'], ['page.view_changed', 'version'], ['page.view_changed', 'version'], ['page.published', 'version']]);
      expect(history.versions.map((v: any) => v.event_id).slice(1, 3)).toEqual([materialized!.id, forget.id]);
      expect(history.versions[3].compiled_truth).toContain('Acme has ten staff');
      expect((await read(b, { slug, known_as_of: afterMaterialize })).event_id).toBe(materialized!.id);
      expect((await read(b, { slug, known_as_of: edited })).compiled_truth).toContain('Profile, edited.');
    }), 180_000);

    test('rename: before the rename the old slug answers and the new one does not; after it, the reverse; one lifetime', () => brain(async b => {
      await b.put('notes/old-example', beliefPage({ type: 'note', title: 'Old', prose: 'Before the move.' }));
      const before = await at(b);
      await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'notes/old-example', newSlug: 'notes/new-example', to: 'notes/new-example.md' });
      await fillCommitMarks(b.engine, b.sourceId);
      const after = await at(b);
      expect(await read(b, { slug: 'notes/old-example', known_as_of: before })).toMatchObject({ body: 'version', slug: 'notes/old-example' });
      expect((await read(b, { slug: 'notes/old-example', known_as_of: before })).compiled_truth).toContain('Before the move.');
      expect((await refusal(read(b, { slug: 'notes/new-example', known_as_of: before })))?.code).toBe('page_not_found');
      expect((await read(b, { slug: 'notes/new-example', known_as_of: after })).compiled_truth).toContain('Before the move.');
      expect((await refusal(read(b, { slug: 'notes/old-example', known_as_of: after })))?.code).toBe('page_not_found');
      const lifetimes = new Set((await b.events()).filter(e => e.subject_kind === 'page').map(e => e.page_lifetime));
      expect(lifetimes.size).toBe(1);
      // Forced probe: without the rename's preimage (the move advances the revision), the body before the rename is disclosed missing, not borrowed from the live page.
      await b.engine.executeRaw('DELETE FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = $2)', [b.sourceId, 'notes/new-example']);
      expect(await read(b, { slug: 'notes/old-example', known_as_of: before })).toMatchObject({ body: 'unavailable', body_reason: 'version_missing' });
    }, { managed: false }), 120_000);

    test('refusals: coverage_from before enable (with and without a backfill), coverage_gap inside a restore gap, clock_mismatch for a date, a future instant', () => brain(async b => {
      await b.put(slug, draft('First draft.'));
      const unrecorded = await at(b);
      await b.enable();
      await b.put(slug, draft('Second draft.'));
      const covered = await at(b);
      const from = await refusal(read(b, { slug, known_as_of: unrecorded }));
      expect(from).toMatchObject({ code: 'coverage_from', reason: 'not_recorded' });
      await backfillBeliefHistory(b.engine, b.sourceId, { slugs: [slug] });
      expect(await refusal(read(b, { slug, known_as_of: unrecorded }))).toMatchObject({ code: 'coverage_from' });
      expect(['backfill_only', 'backfill_incomplete']).toContain(String((await refusal(read(b, { slug, known_as_of: unrecorded })))!.reason));
      expect((await read(b, { slug, known_as_of: covered })).compiled_truth).toContain('Second draft.');
      expect(await refusal(read(b, { slug, known_as_of: covered.slice(0, 10) }))).toMatchObject({ code: 'clock_mismatch', reason: 'date_for_instant' });
      expect((await refusal(read(b, { slug, known_as_of: 'yesterday' })))?.code).toBe('invalid_params');
      expect((await refusal(read(b, { slug, known_as_of: plus(covered, 86_400_000) })))?.code).toBe('invalid_params');
      const archivedAt = await at(b);
      const inGap = await at(b);
      await b.engine.transaction(tx => replayPurgesInRestore(tx, { lines: [], archivedAt, restoreId: randomUUID() }));
      await fillCommitMarks(b.engine, b.sourceId);
      expect(await refusal(read(b, { slug, known_as_of: inGap }))).toMatchObject({ code: 'coverage_gap', reason: 'restore' });
      expect((await read(b, { slug, known_as_of: await at(b) })).compiled_truth).toContain('Second draft.');
    }, { enable: false }), 120_000);

    test('an unmanaged source answers with a disclosure, never as certified fact', () => brain(async b => {
      await b.put(slug, draft('First draft.'));
      expect(await read(b, { slug, known_as_of: await at(b) })).toMatchObject({ certified: false, uncertified_reason: 'unmanaged' });
    }, { managed: false }), 120_000);

    test('a purged page discloses every body as purged, never a neighbouring version', () => brain(async b => {
      await b.put(slug, draft('First draft.'));
      await pause();
      await b.put(slug, draft('Second draft.'));
      const t = await at(b);
      const revision = (await b.engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, slug]))[0]!.r;
      await b.op('delete_page', { slug, purge: true, expected_revision: revision });
      const history = await versions(b, { slug, known_as_of: await at(b), include_body: true });
      expect(history.versions.map((v: any) => [v.event, v.body, v.body_reason, v.compiled_truth])).toEqual([
        ['page.purged', 'unavailable', 'purged', undefined], ['page.published', 'unavailable', 'purged', undefined], ['page.published', 'unavailable', 'purged', undefined]]);
      expect(await read(b, { slug, known_as_of: t })).toMatchObject({ event: 'page.published', deleted: false, body: 'unavailable', body_reason: 'purged' });
      expect((await read(b, { slug, known_as_of: t })).compiled_truth).toBeUndefined();
    }), 120_000);
  });
}
