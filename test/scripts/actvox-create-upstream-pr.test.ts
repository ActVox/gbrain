/**
 * scripts/create-upstream-pr.sh runs the upstream merge in its own worktree.
 *
 * Protects: the caller's checkout (branch, HEAD, staged/unstaged edits and
 * untracked files) is untouched by an integration run; policy conflicts resolve
 * and produce a merge commit on the automation branch; a conflict outside the
 * policy fails the run (exit 10) instead of a green warning, and the temporary
 * worktree is removed.
 * Fails when: the script merges in the caller's checkout again, swallows a
 * residual conflict, or leaks its worktree.
 * Why new: the previous script ran `git checkout -B` + merge in place and exited
 * 0 on scheduled conflicts; neither was tested.
 *
 * Remotes are local bare repositories whose paths contain the owner/repo names
 * the script's remote checks require. --dry-run never pushes or calls gh.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO = join(import.meta.dir, '../..');
const SCRIPTS = [
  'scripts/create-upstream-pr.sh', 'scripts/audit-branch-topology.sh', 'scripts/guard-gbrain-upstream-merge.sh',
  'scripts/actvox/merge-policy.tsv', 'scripts/actvox/package-pins.json', 'scripts/actvox/ratchet-overrides.tsv',
  'scripts/actvox/resolve-upstream-merge.ts',
];
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function sh(cwd: string, cmd: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(cmd, {
    cwd, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid', ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function git(cwd: string, ...args: string[]): string {
  const r = sh(cwd, ['git', ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.out}`);
  return r.out;
}
function write(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
}

/** Seed origin + upstream from one base; fork bumps VERSION and edits src/a.ts; upstream bumps VERSION and edits `upstreamFile`. */
function fixture(upstreamFile: string) {
  const root = mkdtempSync(join(tmpdir(), 'actvox-upstream-pr-'));
  roots.push(root);
  const origin = join(root, 'ActVox/gbrain.git'), upstream = join(root, 'garrytan/gbrain.git');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin); git(root, 'init', '-q', '--bare', '-b', 'master', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '-b', 'master', seed);
  for (const p of SCRIPTS) { mkdirSync(dirname(join(seed, p)), { recursive: true }); copyFileSync(join(REPO, p), join(seed, p)); }
  write(seed, { VERSION: '1.0.0.0\n', 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', upstream, 'master'); git(seed, 'push', '-q', origin, 'master');

  write(seed, { VERSION: '1.0.1.0\n', [upstreamFile]: 'export const upstream = 2;\n' });
  git(seed, 'commit', '-q', '-am', 'upstream release'); git(seed, 'push', '-q', upstream, 'master');
  git(seed, 'reset', '-q', '--hard', 'HEAD~1');
  write(seed, { VERSION: '1.0.0.1\n', 'src/a.ts': 'export const a = 3;\n' });
  git(seed, 'commit', '-q', '-am', 'fork release'); git(seed, 'push', '-q', origin, 'master');

  const caller = join(root, 'caller');
  git(root, 'clone', '-q', origin, caller);
  git(caller, 'remote', 'add', 'upstream', upstream);
  git(caller, 'fetch', '-q', 'upstream');
  // Uncommitted state the integration must not disturb.
  write(caller, { 'src/b.ts': 'export const b = "local edit";\n', 'notes.local': 'untracked\n' });
  git(caller, 'add', 'src/b.ts');
  write(caller, { 'src/b.ts': 'export const b = "local edit, unstaged too";\n' });
  return { caller };
}

function snapshot(caller: string) {
  return {
    branch: git(caller, 'branch', '--show-current').trim(),
    head: git(caller, 'rev-parse', 'HEAD').trim(),
    status: git(caller, 'status', '--porcelain'),
    staged: git(caller, 'diff', '--cached'),
    b: readFileSync(join(caller, 'src/b.ts'), 'utf8'),
    untracked: readFileSync(join(caller, 'notes.local'), 'utf8'),
    worktrees: git(caller, 'worktree', 'list').split('\n').filter(Boolean).length,
  };
}

describe('create-upstream-pr.sh integrates in an isolated worktree', () => {
  test('a policy-only conflict resolves into a merge commit; the caller checkout is untouched', () => {
    const { caller } = fixture('src/c.ts');
    const before = snapshot(caller);
    const run = sh(caller, ['bash', 'scripts/create-upstream-pr.sh', '--dry-run']);
    expect(run.code).toBe(0);
    expect(run.out).toContain('resolved  upstream      VERSION');
    expect(snapshot(caller)).toEqual(before);
    const branch = 'automation/upstream-master';
    expect(git(caller, 'show', `${branch}:VERSION`)).toBe('1.0.1.0\n');
    expect(git(caller, 'show', `${branch}:src/a.ts`)).toBe('export const a = 3;\n');
    expect(git(caller, 'rev-list', '--parents', '-n', '1', branch).trim().split(' ')).toHaveLength(3);
  });

  test('a conflict outside the policy fails the run and leaves no worktree behind', () => {
    const { caller } = fixture('src/a.ts');
    const before = snapshot(caller);
    const run = sh(caller, ['bash', 'scripts/create-upstream-pr.sh', '--dry-run']);
    expect(run.code).toBe(10);
    expect(run.out).toContain('RESIDUAL  src/a.ts');
    expect(run.out).toContain('- src/a.ts');
    expect(snapshot(caller)).toEqual(before);
  });

  test('--keep-worktree keeps the residual conflict for hand resolution', () => {
    const { caller } = fixture('src/a.ts');
    const run = sh(caller, ['bash', 'scripts/create-upstream-pr.sh', '--dry-run', '--keep-worktree']);
    expect(run.code).toBe(10);
    const kept = /integration worktree kept at (\S+)/.exec(run.out)?.[1];
    expect(kept).toBeDefined();
    expect(existsSync(join(kept!, 'src/a.ts'))).toBe(true);
    expect(readFileSync(join(kept!, 'src/a.ts'), 'utf8')).toContain('<<<<<<<');
    expect(readFileSync(join(kept!, 'VERSION'), 'utf8')).toBe('1.0.1.0\n');
  });
});
