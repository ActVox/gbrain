/**
 * GBRA-161 PR 1a: unmanaged extract_atoms publishes each item's atoms as one generation.
 *
 * Protects: (a) a failed publication (here the provenance edges) writes no atom at all, provisional or final, and the
 * retry publishes the atoms, their edges and the completion stamp together; (b) a re-extraction that keeps one of four
 * atoms is held `shrunk` and the four stay live (pre-fix: three were retired on a model's say-so); (c) an atom naming
 * the origin with no retained extractor evidence (a hand-written or hand-edited one) is protected, not retired.
 * Fails when: the atom loop writes outside the generation transaction, or retirement ignores the floor or ownership.
 * Seams: the extract_atoms phase's `_pages` / `_transcripts` / `_chat` inputs (no paid call). PGLite always,
 * Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const chat = (titles: string[]) => async (_o: ChatOpts): Promise<ChatResult> => {
  const text = JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `${title} body.` })));
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 } };
};

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-g1a-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        await run(engine);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const FILE = '/fake/2026-09-07-meeting.txt';
const extractTranscript = (engine: BrainEngine, titles: string[], hash: string) => runPhaseExtractAtoms(engine, {
  _transcripts: [{ filePath: FILE, content: `content ${hash}`, contentHash: hash }], _pages: [], _chat: chat(titles) });
const liveAtoms = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE type='atom' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-161 unmanaged atoms publish as one generation (${backend})`, () => {
    test('a failed provenance write leaves no atom row; the retry publishes atoms, edges and completion together', async () => {
      await withBrain(databaseUrl, async engine => {
        const source = 'meetings/2026-09-07-source-a';
        const content = 'A source page with two careful claims about shipping.';
        await engine.putPage(source, { type: 'meeting', title: 'Source A', compiled_truth: content, timeline: '' });
        const [stored] = await engine.executeRaw<{ content_hash: string }>('SELECT content_hash FROM pages WHERE slug=$1', [source]);
        const pages = [{ slug: source, content, contentHash: stored!.content_hash }];
        const links = engine.addLinksBatch;
        engine.addLinksBatch = async function (this: BrainEngine, ...args: Parameters<typeof links>) {
          throw new Error('synthetic provenance failure');
        };
        try {
          const failed = await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: pages, _chat: chat(['Ship smaller', 'Measure first']) });
          expect(failed.status).toBe('warn');
        } finally { engine.addLinksBatch = links; }
        expect(await engine.executeRaw("SELECT slug FROM pages WHERE type='atom'")).toEqual([]);
        const retry = await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: pages, _chat: chat(['Ship smaller', 'Measure first']) });
        expect(retry.status).toBe('ok');
        const hashes = await engine.executeRaw<{ hash: string }>("SELECT frontmatter->>'source_hash' AS hash FROM pages WHERE type='atom' AND deleted_at IS NULL");
        expect(hashes.map(row => row.hash)).toEqual([stored!.content_hash.slice(0, 16), stored!.content_hash.slice(0, 16)]);
        expect((await engine.getLinks(source)).filter(link => link.link_source === 'atom-provenance')).toHaveLength(2);
      });
    }, 120_000);

    test('a re-extraction that keeps one of four atoms is held shrunk and the four stay live', async () => {
      await withBrain(databaseUrl, async engine => {
        await extractTranscript(engine, ['Ship smaller', 'Measure first', 'Hire slowly', 'Write it down'], 'a'.repeat(64));
        const before = await liveAtoms(engine);
        expect(before).toHaveLength(4);
        const lines: string[] = [];
        const log = console.error;
        console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
        try { await extractTranscript(engine, ['Ship smaller'], 'b'.repeat(64)); } finally { console.error = log; }
        expect(await liveAtoms(engine)).toEqual(before);
        expect(lines.some(line => line.includes('result held (shrunk)') && line.includes('gbrain repair generations --kind atom --mode release-held'))).toBe(true);
        const [held] = await engine.executeRaw<{ held_reason: string }>("SELECT held_reason FROM derived_generations WHERE state='held'");
        expect(held?.held_reason).toBe('shrunk');
      });
    }, 120_000);

    test('an atom naming the origin without retained extractor evidence is protected, not retired', async () => {
      await withBrain(databaseUrl, async engine => {
        const hand = 'atoms/2026-09-07/hand-written-example';
        await engine.putPage(hand, { type: 'atom', title: 'Hand written', compiled_truth: 'A claim the user wrote by hand.', timeline: '',
          frontmatter: { source_path: FILE, source_hash: 'earlier000000000', atom_type: 'insight' } });
        await extractTranscript(engine, ['Ship smaller'], 'c'.repeat(64));
        const live = await liveAtoms(engine);
        expect(live).toContain(hand);
        expect(live).toHaveLength(2);
      });
    }, 120_000);
  });
}
