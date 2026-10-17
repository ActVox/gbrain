/**
 * #6712 PR 4b lane A: the live pass's fences, stop reasons and completion dependencies (design v3.2 §8, §9, §3).
 *
 * Protects:
 * - probe 51 (pass half): `sync.admission` is re-read in each admission transaction of a pass (a delete admitted after
 *   it turns `imports_only` is refused and the pass stops `partial` / `admission_paused`, the page live), and a pass's
 *   `managed_sync_delete` re-reads it at publication (completed `cancelled` / `admission_paused`, nothing written);
 *   once it is `normal` again the next pass deletes the page.
 *
 * Each test fails on capy/6712-pr4b (8cda2764b), where a non-company source still runs the cursor engine, whose intents
 * the fences do not cover, so both deletes publish.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { SYNC_ADMISSION_KEY } from '../src/core/persistence/sync-admission.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};
const liveSlugs = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
const deletes = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string; state: string; error_code: string | null }>(
  "SELECT slug, state, error_code FROM persistence_requests WHERE source_id='default' AND intent->>'kind'='managed_sync_delete' ORDER BY sequence"));

afterEach(() => installFaultHook(undefined));

describe('#6712 PR 4b live pass fences (pglite)', () => {
  test('probe 51 (pass half): sync.admission is re-read in the admission transaction; a delete classified under normal and admitted after imports_only is refused, and the pass stops admission_paused', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    git(root, 'rm', '-q', 'notes/a.md', 'notes/b.md'); commit(root, 'remove a and b');
    // After the pass classified both deletes under normal, before their admission transaction.
    let flipped = false;
    installFaultHook(async point => { if (point === 'sync:mid_checkpoint' && !flipped) { flipped = true; await engine.setConfig(SYNC_ADMISSION_KEY, 'imports_only'); } });
    const paused = await performManagedSync(engine, OPTS);
    installFaultHook(undefined);
    expect({ status: paused.status, reason: paused.reason }).toEqual({ status: 'partial', reason: 'admission_paused' });
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/b', 'notes/c']);
    expect(await deletes(engine)).toEqual([]);

    await engine.setConfig(SYNC_ADMISSION_KEY, 'normal');
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await liveSlugs(engine)).toEqual(['notes/c']);
  }, { setup }), 180_000);

  test('probe 51 (pass half): a managed_sync_delete re-reads sync.admission at publication: cancelled admission_paused, the page live', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    git(root, 'rm', '-q', 'notes/a.md'); commit(root, 'remove a');
    installFaultHook(async (point, detail) => {
      // Prepared, before its publication transaction.
      if (point === 'consumer:prepared' && detail.operation === 'submit_job' && (await deletes(engine)).some(row => row.state === 'running')) await engine.setConfig(SYNC_ADMISSION_KEY, 'imports_only');
    });
    const paused = await performManagedSync(engine, OPTS);
    installFaultHook(undefined);
    expect({ status: paused.status, reason: paused.reason }).toEqual({ status: 'partial', reason: 'admission_paused' });
    expect(await deletes(engine)).toEqual([{ slug: 'notes/a', state: 'cancelled', error_code: 'admission_paused' }]);
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/b', 'notes/c']);

    await engine.setConfig(SYNC_ADMISSION_KEY, 'normal');
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await liveSlugs(engine)).toEqual(['notes/b', 'notes/c']);
  }, { setup }), 180_000);
});
