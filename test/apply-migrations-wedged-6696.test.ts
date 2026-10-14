/**
 * #6696 (PR C, C5): a wedged orchestrator migration (3+ consecutive partial
 * runs with no completion) is outstanding work, not "All migrations up to
 * date". The run reports `migrations_pending` with reason `wedged` and a fix
 * the agent asks the user about (`--force-retry <v>`), `--list --json` lists
 * it with that fix, and the human `--list` never prints "up to date".
 *
 * Spawns the CLI against a throwaway PGLite brain (HOME / GBRAIN_HOME per
 * subprocess; process.env is never mutated).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const WEDGED = '0.22.4';
let home: string;

async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO, env: { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_NO_AUTOPILOT_INSTALL: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-wedged-6696-'));
  expect((await cli(['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
  expect((await cli(['apply-migrations', '--yes', '--no-autopilot-install'])).exitCode).toBe(0);
  const ledger = join(home, '.gbrain', 'migrations', 'completed.jsonl');
  const kept = readFileSync(ledger, 'utf8').split('\n').filter(line => line.trim() && JSON.parse(line).version !== WEDGED);
  const partial = (n: number) => JSON.stringify({ ts: `2026-10-0${n}T00:00:00.000Z`, version: WEDGED, status: 'partial' });
  writeFileSync(ledger, [...kept, partial(1), partial(2), partial(3)].join('\n') + '\n');
}, 240_000);

afterAll(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('apply-migrations with a wedged migration (#6696 C5)', () => {
  test('a run reports migrations_pending reason wedged with an ask_user force-retry fix instead of up to date', async () => {
    const run = await cli(['apply-migrations', '--yes', '--no-autopilot-install', '--json']);
    expect(run.stdout).not.toContain('"status":"up_to_date"');
    expect(run.exitCode).toBe(1);
    const envelope = JSON.parse(run.stdout) as Record<string, any>;
    expect(envelope).toMatchObject({ code: 'migrations_pending', reason: 'wedged' });
    expect(envelope.message).toContain(`v${WEDGED}`);
    expect(envelope.fix).toMatchObject({ next: 'ask_user', argv: ['gbrain', 'apply-migrations', '--force-retry', WEDGED],
      verify: { argv: ['gbrain', 'apply-migrations', '--list', '--json'] } });
  }, 120_000);

  test('--list --json lists the wedged migration with its fix; the human --list does not say up to date', async () => {
    const list = await cli(['apply-migrations', '--list', '--json']);
    expect(list.exitCode).toBe(0);
    const doc = JSON.parse(list.stdout) as Record<string, any>;
    expect(doc.migrations.find((m: { version: string }) => m.version === WEDGED)).toMatchObject({ status: 'wedged' });
    expect(doc.wedged).toEqual([{ version: WEDGED, fix: { argv: ['gbrain', 'apply-migrations', '--force-retry', WEDGED],
      command: `gbrain apply-migrations --force-retry ${WEDGED}` } }]);
    const human = await cli(['apply-migrations', '--list']);
    expect(human.stdout).not.toContain('All migrations up to date');
    expect(human.stdout).toContain(`gbrain apply-migrations --force-retry ${WEDGED}`);
  }, 120_000);
});
