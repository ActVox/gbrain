import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { safeLoad } from 'js-yaml';

type Job = {
  'runs-on'?: string;
  strategy?: { matrix: { os?: string[]; target?: string[] } };
};
const root = join(import.meta.dir, '../..');
const load = (name: string) => safeLoad(readFileSync(join(root, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> };
const normal = 'ubuntu-24.04';
const heavy = 'ubuntu-24.04';
const small = 'ubuntu-24.04';
const report = 'ubuntu-24.04';
const single = report;
const pooled = 'ubuntu-24.04';
const arm = 'ubuntu-24.04-arm';
const targetRunners = (job: Job) =>
  JSON.parse(/fromJSON\('([^']+)'\)\[matrix\.target\]/.exec(job['runs-on']!)![1]!) as Record<string, string>;

describe('CI runner routing', () => {
  test('owned Linux validation jobs use GitHub-hosted Ubuntu without moving release publishing', () => {
    for (const file of ['test.yml', 'e2e.yml', 'heavy-tests.yml', 'persistence-validation.yml', 'native-locks.yml', 'actionlint.yml', 'semgrep.yml']) {
      for (const job of Object.values(load(file).jobs)) {
        const runner = job['runs-on'];
        if (!runner || runner.startsWith('${{')) continue;
        expect(runner, file).toBe('ubuntu-24.04');
      }
    }
    const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(release).not.toContain('ubicloud');
    expect(load('osv-scanner.yml').jobs['osv-scan']['runs-on']).toBeUndefined();
  });

  test('all Linux workload lanes remain routed to the fork hosted runner policy', () => {
    // Capacity changes do not remove lanes or relax their workload contracts.
    for (const name of ['test', 'slow-eval-longmemeval', 'slow-brainbench-e2e', 'brainbench', 'slow-entity-resolve-perf', 'admin-browser', 'shared-skills-compatibility']) {
      expect(load('test.yml').jobs[name]['runs-on'], name).toBe(single);
    }
    for (const name of ['verify', 'serial-tests']) expect(load('test.yml').jobs[name]['runs-on'], name).toBe(pooled);
    for (const name of ['jsonb-parity', 'selected-e2e', 'tier2', 'coverage-full-unit', 'coverage-full-slow', 'coverage-full-e2e']) {
      expect(load('e2e.yml').jobs[name]['runs-on'], name).toBe(single);
    }
    expect(load('e2e.yml').jobs.tier1['runs-on']).toBe(normal);
    expect(load('e2e.yml').jobs['coverage-full-serial']['runs-on']).toBe(pooled);
    expect(load('persistence-validation.yml').jobs['read-performance']['runs-on']).toBe(single);
    expect(load('persistence-validation.yml').jobs.invariants['runs-on']).toBe(single);
    expect(load('persistence-validation.yml').jobs.reconciliation['runs-on']).toBe(single);
    expect(load('persistence-validation.yml').jobs['deployment-matrix']['runs-on']).toBe(pooled);
    expect(load('heavy-tests.yml').jobs.heavy['runs-on']).toBe(heavy);
  });

  test('security matrix labels and native platform coverage retain their identities', () => {
    const security = load('test.yml').jobs['security-regressions'];
    expect(security.strategy!.matrix.os).toEqual(['ubuntu-24.04', 'macos-26', 'windows-latest']);
    for (const os of security.strategy!.matrix.os!) {
      const expression = security['runs-on']!.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
      expect(runInNewContext(expression, { matrix: { os } }, { timeout: 100 })).toBe(os);
    }
    const native = load('native-locks.yml');
    expect(targetRunners(native.jobs.native)).toEqual({
      'linux-x64-glibc': single,
      'linux-arm64-glibc': arm,
      'darwin-arm64': 'macos-26',
      'darwin-x64': 'macos-26-intel',
      'win32-x64': 'windows-2022',
      'win32-arm64': 'windows-11-arm',
    });
    expect(native.jobs.native.strategy!.matrix.target).toEqual(Object.keys(targetRunners(native.jobs.native)));
    expect(targetRunners(native.jobs.musl)).toEqual({ 'linux-x64-musl': single, 'linux-arm64-musl': arm });
    expect(native.jobs.musl.strategy!.matrix.target).toEqual(['linux-x64-musl', 'linux-arm64-musl']);
  });

  test('macOS 26 validation is pinned, time-boxed, label-gated on pull requests and uses no secrets', () => {
    const text = readFileSync(join(root, '.github/workflows/macos-validation.yml'), 'utf8');
    const workflow = safeLoad(text) as { on: Record<string, unknown>; jobs: Record<string, Job & { 'timeout-minutes'?: number; if?: string }> };
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    const job = workflow.jobs['macos-26']!;
    expect(job['runs-on']).toBe('macos-26');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job.if).toContain("contains(github.event.pull_request.labels.*.name, 'macos-validation')");
    expect(text).not.toMatch(/\$\{\{[^}]*secrets\./);
  });

  test('status, planning and coverage reporting use the same hosted Linux policy', () => {
    for (const name of ['changes', 'gitleaks', 'dependency-audit', 'test-status', 'native-only-status']) {
      expect(load('test.yml').jobs[name]['runs-on'], name).toBe(small);
    }
    for (const name of ['prepare-e2e', 'e2e-status']) expect(load('e2e.yml').jobs[name]['runs-on'], name).toBe(small);
    expect(load('test.yml').jobs['coverage-report']['runs-on']).toBe(report);
    expect(load('e2e.yml').jobs['coverage-full-report']['runs-on']).toBe(report);
    expect(load('actionlint.yml').jobs.actionlint['runs-on']).toBe(small);
    expect(load('semgrep.yml').jobs.semgrep['runs-on']).toBe(report);
  });

  test('actionlint rejects custom runner labels and watches its configuration', () => {
    const config = safeLoad(readFileSync(join(root, '.github/actionlint.yaml'), 'utf8')) as { 'self-hosted-runner': { labels: string[] } };
    expect(config['self-hosted-runner'].labels).toEqual([]);
    const workflow = safeLoad(readFileSync(join(root, '.github/workflows/actionlint.yml'), 'utf8')) as { on: Record<string, { paths: string[] }> };
    for (const event of ['push', 'pull_request']) expect(workflow.on[event].paths).toContain('.github/actionlint.yaml');
  });
});
