import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { safeLoad } from 'js-yaml';

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { name: string; if?: string; env: Record<string, string>; strategy?: { 'fail-fast': boolean; matrix: { lane: string } }; steps: Step[] };
const root = join(import.meta.dir, '../..');
const workflow = safeLoad(readFileSync(join(root, '.github/workflows/heavy-tests.yml'), 'utf8')) as {
  on: { workflow_dispatch: { inputs: Record<string, { default: boolean }> } };
  jobs: Record<string, Job>;
};
const hermes = workflow.jobs['hermes-door'];
const opencode = workflow.jobs['opencode-door'];

describe('heavy door supply chain and coverage gates', () => {
  test('ActVox paid and live coverage is opt-in without suppressing free corpus jobs', () => {
    const e2e = safeLoad(readFileSync(join(root, '.github/workflows/e2e.yml'), 'utf8')) as typeof workflow;
    const evaluate = (expression: string, event: string, paid: boolean, vars: Record<string, string> = {}) =>
      runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replaceAll('github.event.pull_request.labels.*.name', 'labels'), {
        github: { event_name: event }, inputs: { run_paid_e2e: paid, run_opencode_paid: false, run_grok_door: false }, vars,
        labels: [], contains: (values: string[], value: string) => values.includes(value), secrets: { OPENAI_API_KEY: 'synthetic', ZEROENTROPY_API_KEY: 'synthetic', ANTHROPIC_API_KEY: 'synthetic' },
      }, { timeout: 100 });
    expect(workflow.on.workflow_dispatch.inputs.run_paid_e2e.default).toBe(false);
    expect(e2e.on.workflow_dispatch.inputs.run_paid_e2e.default).toBe(false);
    for (const event of ['pull_request', 'schedule', 'workflow_dispatch']) {
      for (const name of ['real-agent-e2e', 'hermes-door', 'grok-door', 'opencode-door', 'opencode-door-canary']) {
        expect(Boolean(evaluate(workflow.jobs[name].if!, event, false)), `${event}/${name}`).toBe(false);
      }
      expect(Boolean(evaluate(e2e.jobs.tier2.if!, event, false))).toBe(false);
    }
    for (const job of [workflow.jobs['real-agent-e2e'], workflow.jobs['hermes-door'], e2e.jobs.tier2]) {
      expect(evaluate(job.if!, 'workflow_dispatch', true)).toBe(true);
      expect(evaluate(job.if!, 'schedule', false, { GBRAIN_PAID_E2E: '1' })).toBe(true);
    }
    expect(evaluate(workflow.jobs.heavy.if!, 'schedule', false)).toBe(true);
    expect(evaluate(e2e.jobs['coverage-full-e2e'].if!, 'schedule', false)).toBe(true);
    for (const job of [workflow.jobs.heavy, e2e.jobs['coverage-full-e2e']]) {
      const keys = job.steps.flatMap(step => Object.entries(step.env ?? {}).filter(([key]) => key.endsWith('_API_KEY')));
      expect(keys.length).toBeGreaterThan(0);
      for (const [, value] of keys) {
        expect(evaluate(value, 'schedule', false)).toBe('');
        expect(evaluate(value, 'workflow_dispatch', true)).toBe('synthetic');
      }
    }
    const aggregate = e2e.jobs['e2e-status'].steps.find(step => step.name === 'Aggregate result')!;
    for (const [paid, result, expected] of [[false, 'skipped', 0], [false, 'failure', 1], [true, 'success', 0], [true, 'skipped', 1], [true, 'failure', 1]] as const) {
      const script = aggregate.run!.replace(/\$\{\{ needs\.([a-z0-9-]+)\.result \}\}/g, (_match, job) => job === 'tier2' ? result : 'success')
        .replace('${{ github.event_name }}', 'workflow_dispatch');
      const run = spawnSync('bash', ['-eu', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, PAID_E2E: String(paid), FULL_CORPUS: 'false' } });
      expect(run.status, run.stderr).toBe(expected);
    }
    const tier2 = e2e.jobs.tier2.steps.find(step => step.name === 'Run Tier 2 skill tests')!;
    const temporary = mkdtempSync(join(tmpdir(), 'gbrain-paid-gate-'));
    try {
      for (const [output, code, expected] of [['5 pass', 0, 0], ['Skip reason: no provider key', 0, 1], ['fixture failure', 3, 3]] as const) {
        const run = spawnSync('bash', ['-euo', 'pipefail', '-c', `bun() { printf '%s\\n' "$FIXTURE_OUTPUT"; return "$FIXTURE_CODE"; }\n${tier2.run}`], {
          encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: temporary, FIXTURE_OUTPUT: output, FIXTURE_CODE: String(code) },
        });
        expect(run.status, run.stderr).toBe(expected);
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  test('isolated sync logs are retained in heavy artifacts', () => {
    const steps = workflow.jobs.heavy.steps;
    expect(steps.find(step => step.name === 'Run heavy tests')?.env?.GBRAIN_HEAVY_LOG_DIR)
      .toBe('${{ runner.temp }}/gbrain-heavy-logs');
    expect(steps.find(step => step.name === 'Stage heavy-test logs into workspace')?.run)
      .toContain('cp -r "$RUNNER_TEMP/gbrain-heavy-logs"/. heavy-artifacts/');
  });

  test('Hermes fetches the reviewed immutable installer and verifies it before execution', () => {
    const install = hermes.steps.find(step => step.name === 'Install hermes (pinned installer digest)')!.run!;
    expect(install).toContain('https://raw.githubusercontent.com/NousResearch/hermes-agent/95d42656021a22f20201c618a67da07a618d16f3/scripts/install.sh');
    expect(hermes.env.HERMES_INSTALL_SHA256).toBe('5854b15670b51a8daae8f59ddfa917062de9f74be261eb73b4b8d719710f8968');
    expect(install.indexOf('sha256sum -c -')).toBeLessThan(install.indexOf('bash hermes-install.sh'));
    expect(install).toContain('--commit "$HERMES_GIT_COMMIT"');
    expect(install).toContain('actual_commit');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-hermes-digest-test-'));
    try {
      writeFileSync(join(home, 'hermes-install.sh'), 'unreviewed generic installer fixture\n');
      const verification = install.slice(install.indexOf('if ! echo'), install.indexOf('for attempt'));
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', verification], {
        cwd: home, env: { PATH: process.env.PATH, ...hermes.env }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('installer digest drift');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('OpenCode defaults to keyless and explicitly requests a separate credentialed lane', () => {
    expect(workflow.on.workflow_dispatch.inputs.run_opencode_paid.default).toBe(false);
    expect(opencode.strategy?.matrix.lane).toBe('${{ fromJSON((inputs.run_opencode_paid || vars.GBRAIN_OPENCODE_PAID_E2E == \'1\') && \'["keyless","credentialed"]\' || \'["keyless"]\') }}');
    expect(opencode.strategy?.['fail-fast']).toBe(false);
    expect(opencode.env.ANTHROPIC_API_KEY).toBeUndefined();
    const keyless = opencode.steps.find(step => step.name?.startsWith('Run opencode door tests (keyless'))!;
    expect(keyless.if).toBe("matrix.lane == 'keyless'");
    expect(keyless.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(keyless.run).toContain('[ "$pass_count" != "5" ]');
    const paid = opencode.steps.find(step => step.name === 'Run opencode door tests (credentialed tier only)')!;
    expect(paid.if).toBe("steps.paidgate.outputs.paid == 'true'");
    expect(paid.env?.GBRAIN_REAL_OPENCODE_PAID_E2E).toBe('1');
    expect(paid.run).toContain("--test-name-pattern 'paid tier'");
    expect(paid.run).toContain('[ "$pass_count" != "1" ]');
    expect(opencode.steps.find(step => step.name === 'Upload opencode door evidence')?.with?.name).toContain('${{ matrix.lane }}');
  });

  test('requested OpenCode credentialed coverage fails honestly for absent or blank credentials', () => {
    const gate = opencode.steps.find(step => step.id === 'paidgate')!;
    expect(gate.if).toBe("matrix.lane == 'credentialed'");
    for (const key of [undefined, '', ' \t\n']) {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', gate.run!], {
        env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: key }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No paid turn ran');
      expect(result.stdout).not.toContain('paid=true');
    }
  });
});
