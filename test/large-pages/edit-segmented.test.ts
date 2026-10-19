/**
 * Wave B PR 3 (spec 6.3): edit_page on a segmented page, and `within` from a window read's `edit_target`.
 *
 * 1. Protects: a window read returns edit_target (stored coordinates, the page revision); edit_page with `within` set
 *    to it picks one of two identical lines and reads only that range's segments plus the suffix the content hash
 *    streams; an old_text that spans a segment cut matches; the result equals a fresh import of the edited body
 *    (body, content_hash, segment cuts). A range read before the page moved is stale (revision_conflict), and a range
 *    that misses the text matches nothing. Fences stay protected: a trusted edit into a facts fence is
 *    edit_protected_span, a remote one finds nothing, and a remote window read past hidden text gets no edit_target.
 *    `within` works on an inline page too. A remote edit's diff context never starts inside hidden text, and its hunk
 *    lines count the remote view (hidden runs rendered as get_page renders them).
 * 2. Fails when: `within` is ignored or mis-mapped, a match across a cut is missed, the splice publishes a body or hash
 *    a fresh import would not give, or stored offsets leak hidden text lengths to a remote reader.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conversationBody } from '../helpers/conversation-page.ts';
import { FACTS_BLOCK } from '../helpers/segment-bodies.ts';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { spliceWork } from '../../src/core/page-body/splice.ts';
import { sanitizeRemoteBody } from '../../src/core/remote-body.ts';

const DUP = '**alice-example**: the duplicate status line.';
const PAGE = 'notes/edit-segmented';
const FENCED = 'notes/edit-fenced';
const INLINE = 'notes/edit-inline';
const HIDDEN_A = 'notes/edit-hidden-a';
const HIDDEN_B = 'notes/edit-hidden-b';
const MALFORMED = 'notes/edit-malformed';
const INLINE_MALFORMED = 'notes/edit-malformed-inline';
const fm = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n`;

for (const kind of testBackends()) {
  describe(`segmented edit_page (${kind})`, () => {
    let brain: AppendBrain;
    const row = async (slug: string) => (await brain.engine.executeRaw<{ id: number; content_hash: string; body_bytes: string }>(
      "SELECT id, content_hash, body_bytes::text AS body_bytes FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;
    const cuts = async (slug: string) => (await brain.engine.readManifest(Number((await row(slug)).id))).map(r => [r.region, Number(r.byteStart), r.byteLen]);
    const revision = async (slug: string, remote = false) => (await brain.call('get_page', { slug, body: 'none' }, { remote })).body.revision as string;
    const edit = (slug: string, rev: string, old_text: string, new_text: string, within?: unknown, remote = false) =>
      brain.call('edit_page', { slug, expected_revision: rev, edits: [{ old_text, new_text }], request_id: randomUUID(), ...(within ? { within } : {}) }, { remote });
    /** The edited page equals a fresh import of its own body (the CLI writer stamps agent_written, as the twin carries). */
    const matchesFreshImport = async (slug: string, twin: string) => {
      const body = await brain.body(slug);
      await brain.seed(twin, '---\ntitle: Edit\ntype: note\ntrust_tier: agent_written\n---\n\n' + body.truth + '\n');
      expect((await row(slug)).content_hash).toBe((await row(twin)).content_hash);
      expect(await cuts(slug)).toEqual(await cuts(twin));
    };

    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      const body = [conversationBody(1_000_000, { seed: 5 }), DUP, conversationBody(1_000_000, { seed: 6 }), DUP, conversationBody(100_000, { seed: 7 })].join('\n\n');
      await brain.seed(PAGE, fm('Edit') + body + '\n');
      await brain.seed(FENCED, fm('Fenced') + 'Intro.\n\n' + FACTS_BLOCK + '\n' + conversationBody(1_200_000, { seed: 8 }) + '\n');
      expect((await brain.body(PAGE)).storage).toBe('segmented');
      expect((await brain.body(FENCED)).storage).toBe('segmented');
    }, 600_000);
    afterAll(() => brain.close(), 120_000);

    test('within from a window read picks one of two identical lines, reading only that range', async () => {
      const before = (await brain.body(PAGE)).truth;
      const rev = await revision(PAGE);
      expect((await edit(PAGE, rev, DUP, 'x')).body.error).toBe('edit_ambiguous_match');
      const second = Buffer.from(before).lastIndexOf(Buffer.from(DUP));
      const win = (await brain.call('get_page', { slug: PAGE, body: 'window', bytes: { offset: second - 50, length: 300 } })).body;
      expect(win.window.text).toContain(DUP);
      expect(win.edit_target).toMatchObject({ revision: rev });
      expect(win.edit_target.byte_start).toBeLessThanOrEqual(second);
      expect(win.edit_target.byte_end).toBeGreaterThanOrEqual(second + DUP.length);
      const rows = await brain.engine.readManifest(Number((await row(PAGE)).id));
      const touched = rows.filter(r => Number(r.byteStart) <= second).at(-1)!;
      Object.assign(spliceWork, { segmented: 0, read: 0, rows: 0 });
      const res = await edit(PAGE, rev, DUP, '**alice-example**: the edited status line.', { byte_start: win.edit_target.byte_start, byte_end: win.edit_target.byte_end });
      expect(res).toMatchObject({ isError: false, body: { status: 'created_or_updated' } });
      expect(res.body.diff).toContain('+**alice-example**: the edited status line.');
      // The range's segment (located, spliced, diffed) and the suffix the content hash streams; nothing before the range.
      const suffix = Buffer.byteLength(before) - Number(touched.byteStart);
      expect(spliceWork.read).toBeLessThanOrEqual(2 * suffix + 2 * touched.byteLen);
      expect(spliceWork.read).toBeLessThan(Number(touched.byteStart));
      const after = (await brain.body(PAGE)).truth;
      expect(after === before.slice(0, second) + '**alice-example**: the edited status line.' + before.slice(second + DUP.length)).toBe(true);
      await matchesFreshImport(PAGE, 'notes/edit-twin-1');
    }, 600_000);

    test('an old_text across a segment cut matches; a stale or missing range refuses', async () => {
      const before = (await brain.body(PAGE)).truth;
      const rows = await brain.engine.readManifest(Number((await row(PAGE)).id));
      const cut = Number(rows[3]!.byteStart);
      const old = before.slice(cut - 30, cut + 30);
      expect(before.indexOf(old)).toBe(before.lastIndexOf(old));
      const rev = await revision(PAGE);
      const win = (await brain.call('get_page', { slug: PAGE, body: 'window', bytes: { offset: 10, length: 200 } })).body;
      expect((await edit(PAGE, rev, old, 'x', { byte_start: win.edit_target.byte_start, byte_end: win.edit_target.byte_end })).body.error).toBe('edit_no_match');
      const res = await edit(PAGE, rev, old, 'SPANNED');
      expect(res).toMatchObject({ isError: false });
      expect((await brain.body(PAGE)).truth === before.slice(0, cut - 30) + 'SPANNED' + before.slice(cut + 30)).toBe(true);
      await matchesFreshImport(PAGE, 'notes/edit-twin-2');
      // The range was read at rev; the page has moved since, so it is stale.
      expect((await edit(PAGE, rev, 'SPANNED', 'y', { byte_start: 0, byte_end: Number((await row(PAGE)).body_bytes) })).body.error).toBe('revision_conflict');
    }, 600_000);

    test('fences stay protected, and a remote reader past hidden text gets no edit_target', async () => {
      const body = (await brain.body(FENCED)).truth;
      const rev = await revision(FENCED);
      expect((await edit(FENCED, rev, 'private thing', 'x')).body.error).toBe('edit_protected_span');
      expect((await edit(FENCED, await revision(FENCED, true), 'private thing', 'x', undefined, true)).body.error).toBe('edit_no_match');
      const offset = Buffer.byteLength(body) - 5000;
      const trusted = (await brain.call('get_page', { slug: FENCED, body: 'window', bytes: { offset, length: 200 } })).body;
      expect(trusted.edit_target).toMatchObject({ revision: rev });
      const remote = (await brain.call('get_page', { slug: FENCED, body: 'window', bytes: { offset: 0, length: 200 } }, { remote: true })).body;
      expect(remote.window.text.length).toBeGreaterThan(0);
      const later = (await brain.call('get_page', { slug: FENCED, body: 'window', bytes: { offset: 100_000, length: 200 } }, { remote: true })).body;
      expect(later.window.text.length).toBeGreaterThan(0);
      expect(later.edit_target).toBeUndefined();
      expect((await brain.call('get_page', { slug: FENCED, body: 'none' }, { remote: true })).body.size.tail_sha256).toBeDefined();
    }, 600_000);

    test('a remote edit after hidden text: the diff never shows it, and its line numbers are the remote view\'s', async () => {
      // A takes fence longer than the 2 KB of diff context, right before the edited line: the context starts inside it.
      const takes = '<!--- gbrain:takes:begin -->\n' + Array.from({ length: 150 }, (_, i) => `A private take line ${i}.\n`).join('') + '<!--- gbrain:takes:end -->\n';
      const tail = conversationBody(1_200_000, { seed: 9 });
      const body = 'Intro.\n\n' + FACTS_BLOCK + '\n' + takes + '\n' + tail;
      for (const slug of [HIDDEN_A, HIDDEN_B]) await brain.seed(slug, fm('Hidden') + body + '\n');
      const at = body.length - tail.length;
      const old = body.slice(at, at + 60);
      expect(body.indexOf(old)).toBe(body.lastIndexOf(old));
      /** The new-side line number of the added line holding `marker`. */
      const addedLine = (diff: string, marker: string) => {
        let line = 0;
        for (const l of diff.split('\n')) {
          const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
          if (hunk) { line = Number(hunk[1]); continue; }
          if (l.startsWith('+') && !l.startsWith('+++') && l.includes(marker)) return line;
          if (l.startsWith(' ') || (l.startsWith('+') && !l.startsWith('+++'))) line++;
        }
        return -1;
      };
      const trusted = await edit(HIDDEN_A, await revision(HIDDEN_A), old, 'TRUSTED-EDIT');
      const remote = await edit(HIDDEN_B, await revision(HIDDEN_B, true), old, 'REMOTE-EDIT', undefined, true);
      expect(trusted).toMatchObject({ isError: false });
      expect(remote).toMatchObject({ isError: false });
      for (const hidden of ['private thing', 'private take', 'gbrain:facts', 'gbrain:takes']) expect(remote.body.diff).not.toContain(hidden);
      const newlines = (text: string) => text.split('\n').length - 1;
      const view = (text: string) => sanitizeRemoteBody(text, { includeWithdrawn: true, keepMaterializedMarkers: true });
      const prefix = body.slice(0, at);
      expect(addedLine(trusted.body.diff, 'TRUSTED-EDIT')).toBeGreaterThan(newlines(prefix));
      expect(addedLine(trusted.body.diff, 'TRUSTED-EDIT') - addedLine(remote.body.diff, 'REMOTE-EDIT')).toBe(newlines(prefix) - newlines(view(prefix)));
      expect(newlines(prefix) - newlines(view(prefix))).toBeGreaterThan(0);
    }, 600_000);

    test('a stored fence that does not compile refuses the edit as the whole-body path does', async () => {
      const bad = '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n'
        + '| 1 | a synthetic claim | fact | 1.0 | blorp | medium | 2026-01-01 |  | chat |  |\n<!--- gbrain:facts:end -->\n';
      const tail = conversationBody(1_200_000, { seed: 10 });
      await brain.seed(MALFORMED, fm('Malformed') + 'Intro.\n\n' + bad + '\n' + tail + '\n');
      expect((await brain.body(MALFORMED)).storage).toBe('segmented');
      const truth = (await brain.body(MALFORMED)).truth;
      const far = truth.slice(truth.length - 5000, truth.length - 4940);
      const near = truth.slice(truth.indexOf(tail), truth.indexOf(tail) + 60);
      for (const old of [far, near]) expect(truth.indexOf(old)).toBe(truth.lastIndexOf(old));
      const rev = await revision(MALFORMED);
      const refused = (res: { body: Record<string, any> }) => ({ error: res.body.error, code: res.body.code, reason: res.body.reason, fence: res.body.fence });
      // The whole-body path's refusal, on an inline page holding the same fence.
      expect(await brain.call('put_page', { slug: INLINE_MALFORMED, content: fm('Inline') + 'Intro.\n\nSynthetic prose.\n', request_id: randomUUID() })).toMatchObject({ isError: false });
      await brain.engine.executeRaw("UPDATE pages SET compiled_truth=$2 WHERE source_id='default' AND slug=$1", [INLINE_MALFORMED, 'Intro.\n\n' + bad + '\nSynthetic prose.\n']);
      const expected = refused(await edit(INLINE_MALFORMED, await revision(INLINE_MALFORMED), 'Synthetic prose.', 'x'));
      expect(expected).toMatchObject({ error: 'invalid_params', code: 'invalid_fence', reason: 'target_fence_malformed', fence: { fence: 'facts', section: 'body', rows: [1], line: 6 } });
      // No within: the whole page is checked, so an edit far from the fence refuses.
      expect(refused(await edit(MALFORMED, rev, far, 'x'))).toEqual(expected);
      // within: the touched segments and the fences crossing into them are checked.
      const at = Buffer.byteLength(truth.slice(0, truth.indexOf(near)));
      expect(refused(await edit(MALFORMED, rev, near, 'x', { byte_start: 0, byte_end: at + 60 }))).toEqual(expected);
      expect(await revision(MALFORMED)).toBe(rev);
    }, 600_000);

    test('within on an inline page and from a remote writer', async () => {
      const content = fm('Inline') + ['Intro line.', DUP, 'Middle line.', DUP, 'Last line.'].join('\n\n') + '\n';
      expect(await brain.call('put_page', { slug: INLINE, content, request_id: randomUUID() })).toMatchObject({ isError: false });
      const truth = (await brain.body(INLINE)).truth;
      const second = Buffer.from(truth).lastIndexOf(Buffer.from(DUP));
      const win = (await brain.call('get_page', { slug: INLINE, body: 'window', bytes: { offset: second, length: DUP.length } }, { remote: true })).body;
      expect(win.edit_target).toMatchObject({ byte_start: second, byte_end: second + DUP.length });
      const res = await edit(INLINE, win.edit_target.revision, DUP, 'Second status.', { byte_start: win.edit_target.byte_start, byte_end: win.edit_target.byte_end }, true);
      expect(res).toMatchObject({ isError: false });
      expect((await brain.body(INLINE)).truth).toBe(truth.slice(0, second) + 'Second status.' + truth.slice(second + DUP.length));
    }, 120_000);
  });
}
