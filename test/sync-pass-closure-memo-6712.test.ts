/**
 * #6712 PR 4b fix 1: one pass run computes the episode closure (design §6) once per key (sync-pass-episode.ts
 * `passClosureMemo`). A writeback round's fold offer and its checkpoint both stamp at the run's pinned head, so they share
 * one `ls-tree` walk; any change to what the closure depends on walks again.
 *
 * Protects:
 * - a writeback one-file commit (two stamps at the same head) walks the tree once (`sync:closure_walk`);
 * - each closure input (head, slug mode, the episode's and the pass's selections, `configured`, the configured selection)
 *   is part of the key: changing any one walks again and returns what a fresh walk returns.
 *
 * PGLite here; Postgres through test/e2e/sync-pass-closure-memo-6712-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { passClosureMemo, passEpisodeClosure } from '../src/core/persistence/sync-pass-episode.ts';
import type { PassEpisode, SyncSelection } from '../src/core/persistence/sync-pass-row.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b']) writeFileSync(join(root, `notes/${slug}.md`), `---\ntype: concept\ntitle: notes/${slug}\n---\n\nThe body of notes/${slug}.\n`);
  commit(root, 'notes');
};
const countWalks = () => { const seen = { walks: 0 }; installFaultHook(point => { if (point === 'sync:closure_walk') seen.walks++; }); return seen; };

afterEach(() => installFaultHook(undefined));

test('each closure input is part of the key: a change walks again and matches a fresh walk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-closure-memo-'));
  try {
    mkdirSync(join(root, 'notes'), { recursive: true }); mkdirSync(join(root, 'drafts'), { recursive: true }); git(root, 'init', '-q');
    writeFileSync(join(root, 'notes/a.md'), 'a\n'); writeFileSync(join(root, 'drafts/b.md'), 'b\n'); commit(root, 'one');
    const first = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'drafts/c.md'), 'c\n'); commit(root, 'two');
    const second = git(root, 'rev-parse', 'HEAD');
    const all: SyncSelection = { exclude: [], includeHidden: [], strategy: null, srcSubpath: null, mode: 'committed' };
    const noDrafts: SyncSelection = { ...all, exclude: ['drafts/**'] };
    const episode = (selection: SyncSelection): PassEpisode => ({ opened_at: '2026-01-01T00:00:00Z', selection, inherited: { noEmbed: true, noExtract: true, noSchemaPack: false, from: 'flag' } });
    const base = { gitRoot: root, root, head: first, slugMode: 'git-root' as 'git-root' | 'source-root', episode: episode(all), pass: all, configuredSelection: all, configured: false };
    const steps: Array<[string, typeof base]> = [
      ['same key', base], ['same key again', base],
      ['head', { ...base, head: second }],
      ['episode selection', { ...base, head: second, episode: episode(noDrafts) }],
      ['pass selection', { ...base, head: second, episode: episode(noDrafts), pass: noDrafts }],
      ['configured selection', { ...base, head: second, episode: episode(noDrafts), pass: noDrafts, configuredSelection: noDrafts }],
      ['configured', { ...base, head: second, episode: episode(noDrafts), pass: noDrafts, configuredSelection: noDrafts, configured: true }],
      ['slug mode', { ...base, head: second, episode: episode(noDrafts), pass: noDrafts, configuredSelection: noDrafts, configured: true, slugMode: 'source-root' }],
    ];
    const memo = passClosureMemo(), seen = countWalks(), walks: Record<string, number> = {};
    for (const [label, input] of steps) {
      const before = seen.walks, closure = await memo(input);
      walks[label] = seen.walks - before;
      installFaultHook(undefined); const fresh = await passEpisodeClosure(input); installFaultHook(point => { if (point === 'sync:closure_walk') seen.walks++; });
      expect({ label, closure }).toEqual({ label, closure: fresh });
    }
    expect(walks).toEqual({ 'same key': 1, 'same key again': 0, head: 1, 'episode selection': 1, 'pass selection': 1, 'configured selection': 1, configured: 1, 'slug mode': 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#6712 PR 4b episode closure memo (${backend})`, () => {
    test('a writeback one-file commit stamps twice at one head and walks the tree once', () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writeFileSync(join(root, 'notes/a.md'), '---\ntitle: notes/a\n---\nA committed change of notes/a.\n'); commit(root, 'change a, not canonical');
      const seen = countWalks();
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      const [stamps] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE intent ? 'stamp' AND state='committed'");
      expect(stamps!.n).toBeGreaterThanOrEqual(3);
      expect(seen.walks).toBe(1);
    }, { ...(databaseUrl ? { databaseUrl } : {}), setup }), 120_000);
  });
}
