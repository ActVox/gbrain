/**
 * GBRA-133 (#6712 PR 4b lane F): one odd file never stops a managed source. Each case commits one odd input beside a
 * healthy file, syncs, then commits another healthy file and syncs again.
 *
 * Protects (each red at ed7e8e017, where the source stopped on every rerun and `last_commit` froze):
 * - S-39/S-44/S-53: a NUL byte in a Markdown file (and a UTF-16 save with a byte order mark) failed the admission insert
 *   with 22P05 (`storage_error`); it is held `content_null_bytes` naming the file and line, and with `sync.holds=fail`
 *   the run stops with that typed code instead of `storage_error`.
 * - S-33: a committed file whose Git blob is gone imports from identical working-tree bytes, and is held
 *   `git_object_missing` when the working tree differs.
 * - S-22: an imported file that became a directory (`notes/fd.md/x.md`) stopped the source with
 *   `page_identity_changed`; its page is deleted and the new file imports.
 * - S-63: an unexpected throw while freezing one entry is held `page_write_failed` (origin `freeze`) and re-tested by
 *   the next sync, which imports the file once the fault is gone; a deliberate refusal still stops the run, and a run where
 *   most freezes throw is systemic and stops without holding (guards).
 * - S-64: on Postgres, where bulk groups are on, the same throw in a group follower is held on the follower's own path,
 *   and with `sync.holds=fail` the run stops naming the follower (the group head's path before).
 * The deliberate-refusal and systemic guards pass before and after.
 *
 * PGLite here; Postgres through test/e2e/sync-entry-faults-6712-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { opError } from '../src/core/ops/contract.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { resolveBulkSettings } from '../src/core/persistence/sync-group.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\nThe body of ${title}.\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/seed.md'), note('notes/seed')); writeFileSync(join(root, 'notes/fd.md'), note('notes/fd'));
  commit(root, 'seed');
};
const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
const holds = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []);
const atHead = async (engine: BrainEngine, root: string) => (await engine.executeRaw<{ c: string | null }>("SELECT last_commit AS c FROM sources WHERE id='default'"))[0]!.c === git(root, 'rev-parse', 'HEAD');
const dropBlob = (root: string, path: string) => { const oid = git(root, 'rev-parse', `HEAD:${path}`); rmSync(join(root, '.git/objects', oid.slice(0, 2), oid.slice(2))); return oid; };
/** The odd commit beside a healthy file, the sync, then a later healthy commit and its sync: the source keeps moving. */
async function oddThenHealthy(engine: BrainEngine, root: string, odd: () => void, committed: () => void = () => {}) {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  writeFileSync(join(root, 'notes/ok.md'), note('notes/ok'));
  odd(); commit(root, 'odd'); committed();
  const first = await performManagedSync(engine, OPTS);
  expect(await atHead(engine, root)).toBe(true);
  writeFileSync(join(root, 'notes/ok2.md'), note('notes/ok2')); commit(root, 'ok2');
  const second = await performManagedSync(engine, OPTS);
  expect(second.status).toBe('synced');
  expect(await atHead(engine, root)).toBe(true);
  return first;
}
afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) describe(`[${backend}] GBRA-133: one odd file never stops a managed source`, () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  test('S-39: a NUL byte in a Markdown file is held content_null_bytes naming the file and line; the rest syncs', () => brain(async ({ engine, root }) => {
    const first = await oddThenHealthy(engine, root, () => writeFileSync(join(root, 'notes/odd.md'), '---\ntitle: odd\n---\nfirst line\nbody\u0000here\n'));
    expect(first.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/odd.md', 'content_null_bytes']]);
    const [hold] = await holds(engine);
    expect(hold).toMatchObject({ path: 'notes/odd.md', code: 'content_null_bytes', meta: { line: 5 } });
    expect(hold!.message).toContain('notes/odd.md holds a NUL byte (U+0000) on line 5');
    expect(await live(engine)).toEqual(['notes/fd', 'notes/ok', 'notes/ok2', 'notes/seed']);
  }), 240_000);

  test('S-53: a UTF-16 save with a byte order mark is held content_null_bytes and told to save as UTF-8', () => brain(async ({ engine, root }) => {
    const first = await oddThenHealthy(engine, root, () => writeFileSync(join(root, 'notes/odd.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(note('notes/odd'), 'utf16le')])));
    expect(first.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/odd.md', 'content_null_bytes']]);
    expect((await holds(engine))[0]!.message).toContain('UTF-16');
    expect(await live(engine)).toEqual(['notes/fd', 'notes/ok', 'notes/ok2', 'notes/seed']);
  }), 240_000);

  test('S-39 with sync.holds=fail: the run stops with the typed content_null_bytes refusal, never storage_error', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.holds', 'fail');
    writeFileSync(join(root, 'notes/odd.md'), 'body\u0000here\n'); commit(root, 'odd');
    await expect(performManagedSync(engine, OPTS)).rejects.toMatchObject({ code: 'content_null_bytes' });
  }), 240_000);

  test('S-33: a lost committed blob imports from identical working-tree bytes', () => brain(async ({ engine, root }) => {
    const first = await oddThenHealthy(engine, root, () => writeFileSync(join(root, 'notes/odd.md'), note('notes/odd')), () => dropBlob(root, 'notes/odd.md'));
    expect(first.held ?? []).toEqual([]);
    expect(await live(engine)).toEqual(['notes/fd', 'notes/odd', 'notes/ok', 'notes/ok2', 'notes/seed']);
  }), 240_000);

  test('S-33: a lost committed blob whose working-tree copy differs is held git_object_missing; the rest syncs', () => brain(async ({ engine, root }) => {
    // Git itself cannot build a later tree while the index names the lost object, so the rerun (not a new commit) shows the source is not stopped.
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/ok.md'), note('notes/ok')); writeFileSync(join(root, 'notes/odd.md'), note('notes/odd')); commit(root, 'odd');
    const oid = dropBlob(root, 'notes/odd.md');
    writeFileSync(join(root, 'notes/odd.md'), note('notes/odd edited'));
    git(root, 'update-index', '--assume-unchanged', 'notes/odd.md');
    const first = await performManagedSync(engine, OPTS);
    expect(first.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/odd.md', 'git_object_missing']]);
    expect(await atHead(engine, root)).toBe(true);
    expect((await performManagedSync(engine, OPTS)).status).not.toBe('blocked_by_failures');
    const [hold] = await holds(engine);
    expect(hold).toMatchObject({ code: 'git_object_missing', meta: { blob_oid: oid } });
    expect(hold!.message).toContain('git fsck');
    expect(await live(engine)).toEqual(['notes/fd', 'notes/ok', 'notes/seed']);
  }), 240_000);

  test('S-22: an imported file that became a directory deletes its page and imports the new file', () => brain(async ({ engine, root }) => {
    const first = await oddThenHealthy(engine, root, () => { rmSync(join(root, 'notes/fd.md')); mkdirSync(join(root, 'notes/fd.md')); writeFileSync(join(root, 'notes/fd.md/x.md'), note('notes/x')); });
    expect(first.held ?? []).toEqual([]);
    expect(await live(engine)).toEqual(['notes/fd.md/x', 'notes/ok', 'notes/ok2', 'notes/seed']);
  }), 240_000);

  test('S-63/S-64: an unexpected throw while freezing one file is held page_write_failed on that file; the next sync re-tests and imports it', () => brain(async ({ engine, root }) => {
    let failing = true;
    installFaultHook((point, detail) => { if (failing && point === 'sync:after_freeze' && detail.path === 'notes/b.md') throw new TypeError('synthetic freeze fault'); });
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`));
    commit(root, 'four');
    // The CLI's bulk settings: on for Postgres (b is the first group's follower), off for PGLite.
    const bulk = { ...OPTS, bulk: await resolveBulkSettings(engine, undefined) };
    const first = await performManagedSync(engine, bulk);
    expect(first.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/b.md', 'page_write_failed']]);
    expect(await atHead(engine, root)).toBe(true);
    const [hold] = await holds(engine);
    expect(hold!.meta.write_failure).toMatchObject({ origin: 'freeze', error_class: 'TypeError', request_id: null });
    expect(hold!.message).toContain('synthetic freeze fault');
    expect(await live(engine)).toEqual(['notes/a', 'notes/c', 'notes/d', 'notes/fd', 'notes/seed']);
    failing = false;
    writeFileSync(join(root, 'notes/e.md'), note('notes/e')); commit(root, 'e');
    expect((await performManagedSync(engine, bulk)).status).toBe('synced');
    expect(await live(engine)).toEqual(['notes/a', 'notes/b', 'notes/c', 'notes/d', 'notes/e', 'notes/fd', 'notes/seed']);
    expect(await holds(engine)).toEqual([]);
  }), 240_000);

  test('S-64 with sync.holds=fail: a group follower\'s throw stops the run naming the follower, not the group head', () => brain(async ({ engine, root }) => {
    installFaultHook((point, detail) => { if (point === 'sync:after_freeze' && detail.path === 'notes/b.md') throw new TypeError('synthetic follower fault'); });
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.holds', 'fail');
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`));
    commit(root, 'four');
    const failure = await performManagedSync(engine, { ...OPTS, bulk: await resolveBulkSettings(engine, undefined) }).then(() => null, (error: Error) => error.message);
    expect(failure).toContain('path=notes/b.md');
    expect(failure).toContain('synthetic follower fault');
  }), 240_000);

  test('S-63 guard: a deliberate refusal thrown while freezing still stops the run and holds nothing', () => brain(async ({ engine, root }) => {
    installFaultHook((point, detail) => { if (point === 'sync:after_freeze' && detail.path === 'notes/b.md') throw opError('plan_stale', 'synthetic deliberate refusal', 'none'); });
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/b.md'), note('notes/b')); commit(root, 'b');
    await expect(performManagedSync(engine, OPTS)).rejects.toMatchObject({ code: 'plan_stale' });
    expect(await holds(engine)).toEqual([]);
  }), 240_000);

  test('S-63 guard: when most freezes of a run throw, the run is systemic and stops without holding every file', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    installFaultHook(point => { if (point === 'sync:after_freeze') throw new TypeError('synthetic systemic fault'); });
    for (let i = 0; i < 8; i++) writeFileSync(join(root, `notes/n${i}.md`), note(`notes/n${i}`));
    commit(root, 'eight');
    await expect(performManagedSync(engine, OPTS)).rejects.toThrow('synthetic systemic fault');
    expect((await holds(engine)).length).toBeLessThan(8);
  }), 240_000);
});
