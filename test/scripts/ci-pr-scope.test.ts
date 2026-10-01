import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { safeLoad } from 'js-yaml';

type Matrix = Record<string, unknown> & { exclude?: string };
type Job = { if?: string; 'runs-on'?: string; strategy?: { matrix: Matrix }; steps?: Array<{ id?: string; run?: string; env?: Record<string, string> }> };
const root = join(import.meta.dir, '../..');
const load = (name: string) => safeLoad(readFileSync(join(root, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> };
const evaluate = (expression: string, context: Record<string, unknown>) =>
  runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { fromJSON: JSON.parse, ...context }, { timeout: 100 });

function cells(job: Job, context: Record<string, unknown>): string[] {
  if (job.if && !evaluate(job.if, context)) return [];
  const { exclude, ...axes } = job.strategy!.matrix;
  const excluded = (exclude ? evaluate(exclude, context) : []) as Array<Record<string, string>>;
  let combos: Array<Record<string, string>> = [{}];
  for (const [key, values] of Object.entries(axes)) combos = combos.flatMap(combo => (values as string[]).map(value => ({ ...combo, [key]: value })));
  return combos.filter(combo => !excluded.some(rule => Object.entries(rule).every(([key, value]) => combo[key] === value)))
    .map(combo => Object.values(combo).join('/'));
}

const native = load('native-locks.yml').jobs;
const nativeCells = (scope: string) => ({
  native: cells(native.native, { inputs: { scope } }),
  musl: cells(native.musl, { inputs: { scope } }),
  console: cells(native['windows-backup-console'], { inputs: { scope } }),
  dotnet: cells(native['windows-backup-dotnet'], { inputs: { scope } }),
  openclaw: evaluate(native.openclaw.if!, { inputs: { scope } }),
});

function classify(files: string): string {
  const result = spawnSync('bash', [join(root, 'scripts/ci-native-scope.sh')], { input: files, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('pull-request CI scope', () => {
  test('pushes, schedules and manual runs keep every Bun version on every native target', () => {
    const full = nativeCells('full');
    expect(full.native).toHaveLength(18);
    expect(full.musl).toHaveLength(6);
    expect(full.console).toHaveLength(6);
    expect(full.dotnet).toHaveLength(6);
    expect(full.openclaw).toBe(true);
  });

  test('a pull request touching native paths runs every target on the primary Bun version', () => {
    const primary = nativeCells('primary');
    expect(primary.native.sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64-glibc', 'linux-x64-glibc', 'win32-arm64', 'win32-x64'].map(target => `1.4.2/${target}`));
    expect(primary.musl).toEqual(['1.4.2/linux-x64-musl', '1.4.2/linux-arm64-musl']);
    expect(primary.console).toEqual(['windows-2022/1.4.2', 'windows-11-arm/1.4.2']);
    expect(primary.dotnet).toEqual(['windows-2022/1.4.2', 'windows-11-arm/1.4.2']);
    expect(primary.openclaw).toBe(true);
  });

  test('other pull requests keep one Linux smoke cell that runs the whole native step list', () => {
    const smoke = nativeCells('smoke');
    expect(smoke).toEqual({ native: ['1.4.2/linux-x64-glibc'], musl: [], console: [], dotnet: [], openclaw: false });
  });

  test('native path changes, an empty list and docs-only diffs classify as expected', () => {
    expect(classify('docs/guides/example.md\nsrc/commands/doctor.ts\n')).toBe('smoke');
    for (const path of ['native/locks/lock.c', 'scripts/native/build.ts', 'src/core/pglite-lock.ts', 'src/core/persistence/journal.ts',
      'src/core/context/ipc-path.ts', 'src/commands/backup.ts', 'src/core/export-stage.ts', 'test/native-lock.test.ts',
      'bun.lock', 'package.json', '.github/workflows/native-locks.yml', 'openclaw.plugin.json']) {
      expect(classify(`README.md\n${path}\n`), path).toBe('primary');
    }
    expect(classify('')).toBe('primary');
    const large = Array.from({ length: 8000 }, (_, i) => `docs/guides/fixture-${i}-${'x'.repeat(72)}.md`);
    expect(Buffer.byteLength(large.join('\n'))).toBeGreaterThan(64 * 1024);
    expect(classify(large.join('\n'))).toBe('smoke');
    for (const at of [0, large.length >> 1, large.length]) {
      const files = [...large];
      files.splice(at, 0, 'src/core/pglite-lock.ts');
      expect(classify(files.join('\n')), `native marker at ${at}`).toBe('primary');
    }
  });

  test('the planning job runs the full matrix off pull requests and never narrows on an unreadable diff', () => {
    const step = load('test.yml').jobs.changes.steps!.find(entry => entry.id === 'scope')!;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ci-scope-'));
    try {
      const run = (event: string, gh: string, changedFiles = '1') => {
        writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash\n${gh}\n`);
        chmodSync(join(dir, 'gh'), 0o755);
        const output = join(dir, 'out');
        writeFileSync(output, '');
        const result = spawnSync('bash', ['-c', step.run!], { cwd: root, encoding: 'utf8',
          env: { PATH: `${dir}:${process.env.PATH}`, EVENT: event, PR: '7', REPO: 'example/repo', CHANGED_FILES: changedFiles, GITHUB_OUTPUT: output } });
        expect(result.status, result.stderr).toBe(0);
        return readFileSync(output, 'utf8').trim();
      };
      expect(run('push', 'exit 1')).toBe('native=full');
      expect(run('schedule', 'exit 1')).toBe('native=full');
      expect(run('workflow_dispatch', 'exit 1')).toBe('native=full');
      expect(run('pull_request', 'exit 1')).toBe('native=primary');
      expect(run('pull_request', "printf 'docs/a.md\\n'")).toBe('native=smoke');
      expect(run('pull_request', "printf 'src/core/pglite-lock.ts\\n'")).toBe('native=primary');
      for (const count of ['', 'invalid', '3000', '4230', '99999']) {
        expect(run('pull_request', "printf 'docs/a.md\\n'", count), count).toBe('native=primary');
      }
      // Even below the API cap, an incomplete or overlong successful response
      // is unknown. A complete large docs-only response can still use smoke.
      expect(run('pull_request', "printf 'docs/a.md\\n'", '2')).toBe('native=primary');
      expect(run('pull_request', "printf 'docs/a.md\\ndocs/b.md\\n'", '1')).toBe('native=primary');
      const fixture = join(dir, 'paths');
      const docs = Array.from({ length: 2999 }, (_, i) => `docs/guides/fixture-${i}-${'x'.repeat(72)}.md`);
      writeFileSync(fixture, docs.join('\n'));
      expect(run('pull_request', `cat '${fixture}'`, '2999')).toBe('native=smoke');
      docs[0] = 'src/core/pglite-lock.ts';
      writeFileSync(fixture, docs.join('\n'));
      expect(run('pull_request', `cat '${fixture}'`, '2999')).toBe('native=primary');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('security and persistence use primary Bun on pull requests and retain both compatibility versions elsewhere', () => {
    const pr = { github: { event_name: 'pull_request' } };
    const push = { github: { event_name: 'push' } };
    const security = load('test.yml').jobs['security-regressions'];
    expect(cells(security, push)).toHaveLength(9);
    expect(cells(security, pr)).toEqual(['ubuntu-24.04/1.4.2', 'macos-26/1.4.2', 'windows-latest/1.4.2']);
    const persistence = load('persistence-validation.yml').jobs;
    for (const name of ['read-performance', 'deployment-matrix', 'invariants', 'reconciliation']) {
      const full = cells(persistence[name], push);
      const primary = cells(persistence[name], pr);
      expect(full.filter(cell => cell.endsWith('1.3.11')).length, name).toBe(full.length / 3);
      expect(primary, name).toEqual(full.filter(cell => cell.endsWith('1.4.2')));
    }
  });

  test('export scale runs 10,001 pages on pull requests and 100,001 everywhere else', () => {
    const step = load('test.yml').jobs['slow-entity-resolve-perf'].steps!.find(entry => entry.run?.includes('test/export-scale.slow.test.ts'))!;
    const expression = step.env!.GBRAIN_TEST_EXPORT_SCALE_PAGES!;
    expect(evaluate(expression, { github: { event_name: 'pull_request' } })).toBe('10001');
    for (const event_name of ['push', 'schedule', 'workflow_dispatch']) expect(evaluate(expression, { github: { event_name } })).toBe('100001');
  });
});
