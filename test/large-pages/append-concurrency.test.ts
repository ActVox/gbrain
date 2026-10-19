/**
 * Wave B PR 3 (spec 6.1): append_page under concurrency, replay and preconditions.
 *
 * 1. Protects: two appends with distinct request_ids both land once each, whole and in order (one prepares again
 *    against the other's tail); a replay of a request_id appends nothing, and the same id with other text is an
 *    idempotency_conflict; a stale expected_tail_sha256 refuses with tail_changed and a fix naming the current tail,
 *    a stale expected_revision with revision_changed; an inline page appends in place, reports tail_sha256 on
 *    body:'none', and is promoted once the result crosses 1 MiB; a remote caller never sees or tests a tail that holds
 *    a facts fence; an append while an embed run is chunking converges to a sealed, fully embedded page; a file-backed
 *    page's canonical file gains exactly the appended bytes.
 * 2. Fails when: an append is lost, duplicated or interleaved, a replay appends again, a precondition passes stale, a
 *    hidden tail leaks its digest to a remote caller, or the file and the database disagree.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conversationBody, conversationPage } from '../helpers/conversation-page.ts';
import { FACTS_BLOCK } from '../helpers/segment-bodies.ts';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';

const LOG = 'notes/append-log';
const SMALL = 'notes/append-small';
const GUARDED = 'notes/append-guarded';
const FILED = 'notes/append-filed';
const fm = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n`;

for (const kind of testBackends()) {
  describe(`append_page concurrency and preconditions (${kind})`, () => {
    let brain: AppendBrain;
    const append = (slug: string, text: string, extra: Record<string, unknown> = {}, remote = false) =>
      brain.call('append_page', { slug, text, request_id: randomUUID(), ...extra }, { remote });
    const none = async (slug: string, remote = false) => (await brain.call('get_page', { slug, body: 'none' }, { remote })).body;

    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      await brain.seed(LOG, conversationPage(1_500_000, { seed: 11 }));
      expect((await brain.body(LOG)).storage).toBe('segmented');
    }, 600_000);
    afterAll(() => brain.close(), 120_000);

    test('two appenders land once each, whole and in order; a replay appends nothing', async () => {
      const before = (await brain.body(LOG)).truth;
      expect(await append(LOG, 'first sequential turn')).toMatchObject({ isError: false });
      expect(await append(LOG, 'second sequential turn')).toMatchObject({ isError: false });
      expect((await brain.body(LOG)).truth === before + '\nfirst sequential turn\nsecond sequential turn').toBe(true);

      const both = await Promise.all([append(LOG, 'racing turn alpha'), append(LOG, 'racing turn bravo')]);
      expect(both.map(r => r.isError)).toEqual([false, false]);
      const raced = (await brain.body(LOG)).truth;
      const tail = raced.slice(raced.length - '\nracing turn alpha\nracing turn bravo'.length);
      expect(['\nracing turn alpha\nracing turn bravo', '\nracing turn bravo\nracing turn alpha']).toContain(tail);
      expect(raced.length).toBe(before.length + '\nfirst sequential turn\nsecond sequential turn\nracing turn alpha\nracing turn bravo'.length);

      const request_id = randomUUID();
      const once = await brain.call('append_page', { slug: LOG, text: 'replayed turn', request_id });
      const again = await brain.call('append_page', { slug: LOG, text: 'replayed turn', request_id });
      expect(again.body.revision).toBe(once.body.revision);
      expect((await brain.body(LOG)).truth.split('replayed turn').length).toBe(2);
      expect((await brain.call('append_page', { slug: LOG, text: 'other text', request_id })).body.error).toBe('idempotency_conflict');
    }, 600_000);

    test('stale preconditions refuse with tail_changed and revision_changed', async () => {
      const read = await none(LOG);
      expect(read.size.tail_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await append(LOG, 'moves the tail')).toMatchObject({ isError: false });
      const stale = await append(LOG, 'never lands', { expected_tail_sha256: read.size.tail_sha256 });
      expect(stale.body.error).toBe('tail_changed');
      const current = (await none(LOG)).size.tail_sha256;
      expect(stale.body.fix.then.mcp.arguments.expected_tail_sha256).toBe(current);
      expect(JSON.parse(stale.body.detail).current_tail_sha256).toBe(current);
      const moved = await append(LOG, 'never lands either', { expected_revision: read.revision });
      expect(moved.body.error).toBe('revision_changed');
      expect((await brain.body(LOG)).truth.includes('never lands')).toBe(false);
      expect(await append(LOG, 'lands on the current tail', { expected_tail_sha256: current, expected_revision: (await none(LOG)).revision })).toMatchObject({ isError: false });
      expect((await append(LOG, 'bad <!--- gbrain:facts:begin --> marker')).body.error).toBe('invalid_params');
    }, 600_000);

    test('an inline page appends in place and is promoted past 1 MiB; a guarded tail stays hidden from remote callers', async () => {
      expect(await brain.call('put_page', { slug: SMALL, content: fm('Small') + 'Opening line.\n', request_id: randomUUID() })).toMatchObject({ isError: false });
      const tail = (await none(SMALL)).size.tail_sha256;
      expect(tail).toMatch(/^[0-9a-f]{64}$/);
      expect(await append(SMALL, 'Second line.', { expected_tail_sha256: tail })).toMatchObject({ isError: false });
      expect(await brain.body(SMALL)).toMatchObject({ storage: 'inline', truth: 'Opening line.\nSecond line.' });
      const big = await append(SMALL, conversationBody(1_100_000, { seed: 12 }));
      expect(big).toMatchObject({ isError: false });
      expect((await brain.body(SMALL)).storage).toBe('segmented');

      expect(await brain.call('put_page', { slug: GUARDED, content: fm('Guarded') + 'Intro.\n\n' + FACTS_BLOCK, request_id: randomUUID() })).toMatchObject({ isError: false });
      expect((await none(GUARDED)).size.tail_sha256).toMatch(/^[0-9a-f]{64}$/);
      const hidden = await none(GUARDED, true);
      expect(hidden.size.tail_sha256).toBeUndefined();
      const guess = await append(GUARDED, 'remote text', { expected_tail_sha256: (await none(GUARDED)).size.tail_sha256 }, true);
      expect(guess.body.error).toBe('tail_changed');
      expect(JSON.parse(guess.body.detail).current_tail_sha256).toBeNull();
      expect(await append(GUARDED, 'remote text', {}, true)).toMatchObject({ isError: false });
    }, 600_000);

    test('an append while an embed run is chunking converges', async () => {
      const page = (await brain.engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [LOG]))[0]!;
      const text = conversationBody(20_000, { seed: 13 });
      const [, appended] = await Promise.all([runEmbedCore(brain.engine, { stale: true, quiet: true } as never), append(LOG, text)]);
      expect(appended).toMatchObject({ isError: false });
      expect((await brain.body(LOG)).truth.endsWith('\n' + text)).toBe(true);
      await runEmbedCore(brain.engine, { stale: true, quiet: true } as never);
      const [state] = await brain.engine.executeRaw<{ unembedded: number; sealed: boolean }>(`SELECT
          (SELECT count(*)::int FROM content_chunks WHERE page_id=$1 AND embedded_at IS NULL) AS unembedded,
          (SELECT text_projection_revision = knowledge_revision FROM pages WHERE id=$1) AS sealed`, [page.id]);
      expect(state).toEqual({ unembedded: 0, sealed: true });
    }, 600_000);
  });

  describe(`append_page on a file-backed page (${kind})`, () => {
    let brain: AppendBrain;
    beforeAll(async () => { brain = await openAppendBrain(kind, { repo: true }); }, 600_000);
    afterAll(() => brain.close(), 120_000);

    test("the canonical file gains exactly the appended bytes", async () => {
      expect(await brain.call('put_page', { slug: FILED, content: conversationPage(1_200_000, { seed: 14 }), request_id: randomUUID() })).toMatchObject({ isError: false });
      expect((await brain.body(FILED)).storage).toBe('segmented');
      const file = join(brain.root!, FILED + '.md');
      const before = readFileSync(file, 'utf8');
      const res = await brain.call('append_page', { slug: FILED, text: 'a turn appended to the file', request_id: randomUUID() });
      expect(res).toMatchObject({ isError: false, body: { receipt: { write_through: { written: true } } } });
      const after = readFileSync(file, 'utf8');
      // A segmented flip renders the head from the stored frontmatter (as a segmented tag write does): same keys, stored order.
      const split = (text: string) => { const at = text.indexOf('\n---\n\n'); return { head: text.slice(0, at).split('\n').sort(), body: text.slice(at + 6) }; };
      expect(split(after).head).toEqual(split(before).head);
      expect(split(after).body === split(before).body.slice(0, -1) + '\na turn appended to the file\n').toBe(true);
    }, 600_000);
  });
}
