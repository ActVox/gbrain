/**
 * D-23 (GBRA-131, #6986): extract_atoms reads a declared `storage.db_only` page from the database and publishes it
 * whether or not a local cache file sits at its path.
 *
 * Protects: on a managed brain whose gbrain.yml declares `meetings/` db_only, a meeting page is extracted and its
 * atoms publish when (a) no file exists (the database is the only copy) and (b) a stale cache file exists at the
 * slug path (db_only directories are written to disk as a gitignored cache that sync never imports, so the
 * database copy is the copy of record). The cache file's bytes are left exactly as they were. A page that is NOT
 * declared db_only and whose canonical file differs still refuses `file_database_drift`, so the drift guard is not
 * loosened for file-backed pages.
 * Fails when: the coordinated publication compares the db_only page with its stale cache file and refuses
 * "The canonical file contains an uncoordinated local edit" (`source_changed` / `file_database_drift`), which halts
 * every db_only meeting page on every run (doctor extract_health at 100% halt).
 * Seams: a stub chat model (no paid calls); the real managed coordinator. PGLite always, Postgres when DATABASE_URL
 * is set.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { operations } from '../../src/core/operations.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const MEETING = 'meetings/2026-04-03-acme-example';
const NOTE = 'notes/acme-example-plan';
const prose = (label: string) => `${label}: the team agreed to measure every launch against clear exit criteria and to review them weekly. `.repeat(12);

function stubChat() {
  const calls: string[] = [];
  const chat = async (opts: ChatOpts): Promise<ChatResult> => {
    const last = opts.messages[opts.messages.length - 1];
    calls.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
    const text = JSON.stringify([{ title: `Launch exit criteria ${calls.length}`, body: 'Measure every launch against clear exit criteria.', atom_type: 'insight' }]);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { calls, chat };
}

const atomsFrom = (engine: BrainEngine, slug: string) => engine.executeRaw<{ slug: string }>(
  `SELECT slug FROM pages WHERE source_id='default' AND type='atom' AND deleted_at IS NULL AND frontmatter->>'source_slug'=$1`, [slug]);
const item = async (engine: BrainEngine, slug: string) => {
  const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
  return { slug, content: page.compiled_truth, contentHash: page.content_hash! };
};

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-23 extract_atoms on declared db_only pages (${backend})`, () => {
    for (const cache of ['absent', 'stale', 'stale-recorded'] as const) {
      test(`D-23 db_only meeting with its cache file ${cache}: atoms publish from the database copy and the cache is untouched`, async () => {
        let cacheBytes: string | null = null;
        await managedBrain(async ({ engine, root }) => {
          const { calls, chat } = stubChat();
          const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: chat, _transcripts: [] });
          await disposePersistenceConsumer(engine);
          const refusals = await engine.executeRaw<{ error_code: string | null }>(
            "SELECT error_code FROM persistence_requests WHERE source_id='default' AND outcome->>'status' IS DISTINCT FROM 'completed' AND error_code IS NOT NULL");
          expect({ status: result.status, refusals: refusals.map(r => r.error_code) }).toEqual({ status: 'ok', refusals: [] });
          expect(calls.length).toBe(1);
          expect((await atomsFrom(engine, MEETING)).length).toBe(1);
          if (cacheBytes !== null) expect(readFileSync(join(root, `${MEETING}.md`), 'utf8')).toBe(cacheBytes);
        }, { databaseUrl, setup: async ({ engine, root }) => {
          writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - meetings/\n');
          await engine.putPage(MEETING, { type: 'meeting', title: 'Acme example sync', compiled_truth: prose('current'), timeline: '' }, { sourceId: 'default' });
          if (cache === 'stale-recorded') await engine.executeRaw("UPDATE pages SET source_path=$1 WHERE source_id='default' AND slug=$2", [`${MEETING}.md`, MEETING]);
          if (cache !== 'absent') {
            const path = join(root, `${MEETING}.md`);
            mkdirSync(dirname(path), { recursive: true });
            cacheBytes = `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('older cache')}\n`;
            writeFileSync(path, cacheBytes);
          }
        } });
      }, 180_000);
    }


    test('D-23 a coordinated write to a db_only meeting whose cache file is stale publishes to the database and leaves the cache', async () => {
      const cacheBytes = `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('older cache')}\n`;
      await managedBrain(async ({ engine, root, ctx }) => {
        const snap = (await engine.readPageSnapshot(MEETING, { sourceId: 'default' }))!;
        const outcome = await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: MEETING, expected_revision: snap.revision,
          content: `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('edited in the database')}\n` })
          .then(() => 'published', (error: { code?: string; detail?: string }) => `${error.code}/${error.detail}`);
        await disposePersistenceConsumer(engine);
        expect(outcome).toBe('published');
        expect((await engine.getPage(MEETING, { sourceId: 'default' }))!.compiled_truth).toContain('edited in the database');
        expect(readFileSync(join(root, `${MEETING}.md`), 'utf8')).toBe(cacheBytes);
      }, { databaseUrl, setup: async ({ engine, root }) => {
        writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - meetings/\n');
        await engine.putPage(MEETING, { type: 'meeting', title: 'Acme example sync', compiled_truth: prose('current'), timeline: '' }, { sourceId: 'default' });
        mkdirSync(dirname(join(root, `${MEETING}.md`)), { recursive: true });
        writeFileSync(join(root, `${MEETING}.md`), cacheBytes);
      } });
    }, 180_000);

    test('D-23 control: an atom whose published file was edited still refuses file_database_drift on re-extraction and the file is untouched', async () => {
      await managedBrain(async ({ engine, root, ctx }) => {
        const sameTitle = (chat: ReturnType<typeof stubChat>['chat']) => async (o: ChatOpts) => {
          const r = await chat(o);
          const text = r.text.replace(/Launch exit criteria \d+/, 'Launch exit criteria 1');
          return { ...r, text, blocks: [{ type: 'text' as const, text }] };
        };
        await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: sameTitle(stubChat().chat), _transcripts: [] });
        await disposePersistenceConsumer(engine);
        const [atom] = await atomsFrom(engine, MEETING);
        const rel = `${atom!.slug}.md`;
        expect(existsSync(join(root, rel))).toBe(true);
        const edited = readFileSync(join(root, rel), 'utf8').replace('Measure every launch', 'HAND-EDIT: measure every launch');
        writeFileSync(join(root, rel), edited);
        const snap = (await engine.readPageSnapshot(MEETING, { sourceId: 'default' }))!;
        await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: MEETING, expected_revision: snap.revision,
          content: `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('edited')}\n` });
        await disposePersistenceConsumer(engine);
        await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: sameTitle(stubChat().chat), _transcripts: [] });
        await disposePersistenceConsumer(engine);
        const refusals = await engine.executeRaw<{ slug: string; error_code: string }>(
          "SELECT slug, error_code FROM persistence_requests WHERE source_id='default' AND error_code IS NOT NULL");
        expect(refusals).toEqual([{ slug: atom!.slug, error_code: 'source_changed' }]);
        expect(readFileSync(join(root, rel), 'utf8')).toBe(edited);
      }, { databaseUrl, setup: async ({ engine, root }) => {
        writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - meetings/\n');
        await engine.putPage(MEETING, { type: 'meeting', title: 'Acme example sync', compiled_truth: prose('current'), timeline: '' }, { sourceId: 'default' });
      } });
    }, 180_000);
  });
}
