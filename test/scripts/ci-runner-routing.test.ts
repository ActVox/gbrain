import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeLoad } from 'js-yaml';

type Job = {
  'runs-on'?: string;
  strategy?: { matrix: { os?: string[]; include?: Array<{ runner: string; target: string }> } };
};

const root = join(import.meta.dir, '../..');
const workflows = ['test.yml', 'e2e.yml', 'heavy-tests.yml', 'persistence-validation.yml', 'native-locks.yml', 'actionlint.yml', 'semgrep.yml'];
const load = (name: string) => safeLoad(readFileSync(join(root, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> };
const standard = 'ubuntu-latest';
const pinned = 'ubuntu-24.04';
const arm = 'ubuntu-24.04-arm';

describe('CI runner routing', () => {
  test('fork-owned validation never depends on unavailable third-party runners', () => {
    for (const file of workflows) {
      const source = readFileSync(join(root, '.github/workflows', file), 'utf8');
      expect(source, file).not.toContain('ubicloud');
    }

    const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(release).not.toContain('ubicloud');
    expect(load('osv-scanner.yml').jobs['osv-scan']['runs-on']).toBeUndefined();
  });

  test('Linux validation jobs use GitHub-hosted runners available to this public fork', () => {
    for (const name of ['verify', 'serial-tests', 'test', 'slow-eval-longmemeval', 'slow-brainbench-e2e', 'brainbench', 'slow-entity-resolve-perf', 'admin-browser', 'shared-skills-compatibility']) {
      expect(load('test.yml').jobs[name]['runs-on'], name).toBe(standard);
    }
    for (const name of ['jsonb-parity', 'selected-e2e', 'tier1', 'tier2', 'coverage-full-unit', 'coverage-full-serial', 'coverage-full-slow', 'coverage-full-e2e']) {
      expect(load('e2e.yml').jobs[name]['runs-on'], name).toBe(standard);
    }
    expect(load('heavy-tests.yml').jobs.heavy['runs-on']).toBe(standard);
    expect(load('persistence-validation.yml').jobs['read-performance']['runs-on']).toBe(pinned);
    expect(load('persistence-validation.yml').jobs['deployment-matrix']['runs-on']).toBe(pinned);
    expect(load('persistence-validation.yml').jobs.invariants['runs-on']).toBe(pinned);
  });

  test('security and native matrices preserve platform identity', () => {
    const security = load('test.yml').jobs['security-regressions'];
    expect(security.strategy!.matrix.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    expect(security['runs-on']).toBe('${{ matrix.os }}');

    const native = load('native-locks.yml');
    const platforms = [
      { runner: pinned, target: 'linux-x64-glibc' },
      { runner: arm, target: 'linux-arm64-glibc' },
      { runner: 'macos-15', target: 'darwin-arm64' },
      { runner: 'macos-15-intel', target: 'darwin-x64' },
      { runner: 'windows-2022', target: 'win32-x64' },
      { runner: 'windows-11-arm', target: 'win32-arm64' },
    ];
    expect(native.jobs.native.strategy!.matrix.include).toEqual(platforms);
    expect(native.jobs.musl.strategy!.matrix.include).toEqual(
      platforms.slice(0, 2).map(({ runner, target }) => ({ runner, target: target.replace('glibc', 'musl') })),
    );
  });

  test('planning, reports and static analysis use standard GitHub-hosted Linux', () => {
    for (const name of ['gitleaks', 'dependency-audit', 'test-status', 'native-only-status', 'coverage-report']) {
      expect(load('test.yml').jobs[name]['runs-on'], name).toBe(standard);
    }
    for (const name of ['prepare-e2e', 'e2e-status', 'coverage-full-report']) {
      expect(load('e2e.yml').jobs[name]['runs-on'], name).toBe(standard);
    }
    expect(load('actionlint.yml').jobs.actionlint['runs-on']).toBe(standard);
    expect(load('semgrep.yml').jobs.semgrep['runs-on']).toBe(standard);
  });

  test('no stale custom-runner actionlint policy can hide runner drift', () => {
    expect(existsSync(join(root, '.github/actionlint.yaml'))).toBe(false);
    const workflow = readFileSync(join(root, '.github/workflows/actionlint.yml'), 'utf8');
    expect(workflow).not.toContain('.github/actionlint.yaml');
  });
});
