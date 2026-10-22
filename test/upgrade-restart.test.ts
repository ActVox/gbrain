/**
 * GBRA-175: `gbrain upgrade` restarts every gbrain process on the host onto
 * the installed build, or refuses with the exact step for each process it
 * cannot restart, then verifies one build runs and the warm CLI socket
 * accepts it. Fakes stand in for ps, the PID file, the worker registry, the
 * heartbeat rows, the service managers and the socket.
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyGbrainCommand, collectHostProcesses, planRestart, restartProblems, runRestartSteps, supervisorRestartArgv, unverifiedBuilds, verifyRestart,
  type HostProcess, type ProcessSources, type RestartContext, type RestartExecutor, type WarmSocketState,
} from '../src/core/upgrade-restart.ts';
import { restartRefusal } from '../src/commands/upgrade-restart.ts';
import { exitCodeForCode } from '../src/core/error-catalogue.ts';

const NEW = '0.60.400.0';
const OLD = '0.60.390.0';
const HOME = '/home/alice-example';
const SERVE_SERVICE = ['systemctl', '--user', 'restart', 'gbrain-serve.service'];
const AUTOPILOT_SERVICE = ['systemctl', '--user', 'restart', 'gbrain-autopilot.service'];
const SERVE_PID = 9;
const AUTOPILOT_PID = 29;
const ctx = (over: Partial<RestartContext> = {}): RestartContext => ({
  expected: NEW, serveService: { argv: SERVE_SERVICE, pid: SERVE_PID }, autopilotService: { argv: AUTOPILOT_SERVICE, pid: AUTOPILOT_PID }, stopMcp: false, ...over,
});
const SUP_ARGS = ['jobs', 'supervisor', 'start'];
const DEFAULT_SUP = supervisorRestartArgv(SUP_ARGS);
const proc = (pid: number, role: HostProcess['role'], version: string | null = OLD, over: Partial<HostProcess> = {}): HostProcess => ({
  pid, ppid: null, role, version, started_ms: 1_000,
  ancestors: role === 'serve' ? [SERVE_PID] : role === 'autopilot' ? [AUTOPILOT_PID] : [],
  args: role === 'supervisor' ? SUP_ARGS : [role], ...over,
});

describe('classifyGbrainCommand', () => {
  test('long-running gbrain processes get a role; one-shot, transient and wrapper commands do not', () => {
    expect(classifyGbrainCommand('/usr/bin/bun /home/alice-example/.bun/bin/gbrain serve --http --port 3131')).toBe('serve');
    expect(classifyGbrainCommand('bun /srv/gbrain/src/cli.ts serve')).toBe('mcp');
    expect(classifyGbrainCommand('gbrain jobs work --queue default')).toBe('worker');
    expect(classifyGbrainCommand('gbrain jobs supervisor start --detach')).toBe('supervisor');
    expect(classifyGbrainCommand('gbrain jobs supervisor')).toBe('supervisor');
    expect(classifyGbrainCommand('gbrain jobs supervisor stop')).toBeNull();
    expect(classifyGbrainCommand('gbrain autopilot --repo /srv/brain-example')).toBe('autopilot');
    expect(classifyGbrainCommand('gbrain autopilot start')).toBe('autopilot');
    expect(classifyGbrainCommand('gbrain autopilot --install')).toBeNull();
    expect(classifyGbrainCommand('gbrain autopilot status')).toBeNull();
    expect(classifyGbrainCommand('gbrain jobs supervisor --max-rss 512')).toBe('supervisor');
    expect(classifyGbrainCommand('gbrain sync --source source-a')).toBe('sync');
    expect(classifyGbrainCommand('gbrain search alice')).toBeNull();
    expect(classifyGbrainCommand('gbrain upgrade --restart-only')).toBeNull();
    expect(classifyGbrainCommand('gbrain serve status')).toBeNull();
    expect(classifyGbrainCommand('vim notes/gbrain-serve.md')).toBeNull();
    expect(classifyGbrainCommand('/usr/bin/tini -s -- /home/alice-example/.bun/bin/gbrain jobs work --queue default')).toBeNull();
  });
});

describe('supervisorRestartArgv', () => {
  test('keeps the queue, concurrency and PID file the supervisor was launched with', () => {
    expect(supervisorRestartArgv(['jobs', 'supervisor', 'start', '--queue', 'ingest', '--concurrency', '4', '--pid-file', '/tmp/sup-example.pid'])).toEqual({
      stop: ['gbrain', 'jobs', 'supervisor', 'stop', '--pid-file', '/tmp/sup-example.pid', '--json'],
      start: ['gbrain', 'jobs', 'supervisor', 'start', '--detach', '--queue', 'ingest', '--concurrency', '4', '--pid-file', '/tmp/sup-example.pid', '--json'],
      pid_file: '/tmp/sup-example.pid',
    });
    expect(DEFAULT_SUP).toEqual({ stop: ['gbrain', 'jobs', 'supervisor', 'stop', '--json'], start: ['gbrain', 'jobs', 'supervisor', 'start', '--detach', '--json'], pid_file: null });
  });
});

describe('collectHostProcesses', () => {
  const sources = (over: Partial<ProcessSources> = {}): ProcessSources => ({
    heartbeats: async () => [], supervisor: () => null, workers: () => [], processTable: () => [], home: HOME, exclude: [], ...over,
  });

  test('merges ps, heartbeats, the PID file and the worker registry by pid; the parent is the nearest gbrain process (through tini)', async () => {
    const processes = await collectHostProcesses(sources({
      processTable: () => [
        { pid: 10, ppid: SERVE_PID, command: 'gbrain serve --http', started_ms: 500, gbrain_home: HOME },
        { pid: SERVE_PID, ppid: 1, command: '/bin/sh /home/alice-example/.gbrain/serve/gbrain-serve.sh', started_ms: 400, gbrain_home: HOME },
        { pid: 20, ppid: 1, command: 'gbrain jobs supervisor start --queue ingest', started_ms: 600, gbrain_home: HOME },
        { pid: 22, ppid: 20, command: '/usr/bin/tini -s -- /usr/local/bin/gbrain jobs work --queue ingest', started_ms: 650, gbrain_home: HOME },
        { pid: 21, ppid: 22, command: '/usr/local/bin/gbrain jobs work --queue ingest', started_ms: 700, gbrain_home: HOME },
        { pid: 30, ppid: 99, command: 'gbrain serve', started_ms: 800, gbrain_home: undefined },
      ],
      heartbeats: async () => [{ pid: 10, kind: 'serve', version: OLD }, { pid: 40, kind: 'autopilot', version: NEW }, { pid: 50, kind: 'cli', version: NEW }],
      supervisor: () => ({ pid: 20, version: OLD }),
      workers: () => [{ pid: 21, version: OLD }],
      installVersion: command => command.startsWith('/usr/local/bin/gbrain') ? NEW : null,
    }));
    expect(processes).toEqual([
      { pid: 10, ppid: null, role: 'serve', version: OLD, started_ms: 500, ancestors: [SERVE_PID], args: ['serve', '--http'], install_version: null },
      { pid: 20, ppid: null, role: 'supervisor', version: OLD, started_ms: 600, ancestors: [], args: ['jobs', 'supervisor', 'start', '--queue', 'ingest'], install_version: null },
      { pid: 21, ppid: 20, role: 'worker', version: OLD, started_ms: 700, ancestors: [22, 20], args: ['jobs', 'work', '--queue', 'ingest'], install_version: NEW },
      { pid: 30, ppid: null, role: 'mcp', version: null, started_ms: 800, ancestors: [99], args: ['serve'], install_version: null },
    ]);
  });

  test('a record whose pid the process table does not list as gbrain is stale and dropped (a dead or reused pid is never signalled)', async () => {
    const processes = await collectHostProcesses(sources({
      processTable: () => [{ pid: 77, ppid: 1, command: 'sleep 600', started_ms: 500, gbrain_home: HOME }],
      heartbeats: async () => [{ pid: 77, kind: 'mcp', version: OLD }, { pid: 78, kind: 'serve', version: OLD }],
      workers: () => [{ pid: 79, version: OLD }],
    }));
    expect(processes).toEqual([]);
  });

  test('without a process table, records are kept but an MCP server is never stopped', async () => {
    const processes = await collectHostProcesses(sources({ processTable: () => null, heartbeats: async () => [{ pid: 77, kind: 'mcp', version: OLD }] }));
    expect(processes).toEqual([{ pid: 77, ppid: null, role: 'mcp', version: OLD, started_ms: null }]);
    const plan = planRestart(processes, ctx({ stopMcp: true }));
    expect(plan.steps).toEqual([]);
    expect(plan.manual[0]!.instruction).toContain('not signalled');
  });

  test('skips another brain home and the upgrade process itself', async () => {
    const processes = await collectHostProcesses(sources({
      processTable: () => [
        { pid: 10, ppid: 1, command: 'gbrain serve --http', started_ms: 500, gbrain_home: '/home/bob-example' },
        { pid: 11, ppid: 1, command: 'gbrain serve --http', started_ms: 500, gbrain_home: `${HOME}/` },
        { pid: 12, ppid: 1, command: 'gbrain jobs work', started_ms: 500, gbrain_home: HOME },
      ],
      exclude: [12],
    }));
    expect(processes.map(p => p.pid)).toEqual([11]);
  });
});

describe('planRestart', () => {
  test('serve and autopilot restart through their services, the supervisor takes its worker along, current processes stay', () => {
    const plan = planRestart([
      proc(10, 'serve'), proc(11, 'serve', NEW), proc(20, 'supervisor'), proc(21, 'worker', OLD, { ppid: 20 }),
      proc(30, 'autopilot'), proc(31, 'worker', OLD, { ppid: 30 }),
    ], ctx());
    expect(plan.manual).toEqual([]);
    expect(plan.current.map(p => p.pid)).toEqual([11]);
    expect(plan.steps).toEqual([
      { kind: 'service', role: 'serve', argv: SERVE_SERVICE, pids: [10] },
      { kind: 'service', role: 'autopilot', argv: AUTOPILOT_SERVICE, pids: [30] },
      { kind: 'supervisor', pid: 20, workers: [21], ...DEFAULT_SUP },
    ]);
  });

  test('the supervisor restarts with the options it was launched with', () => {
    const args = ['jobs', 'supervisor', 'start', '--queue', 'ingest', '--concurrency', '4'];
    const plan = planRestart([proc(20, 'supervisor', OLD, { args }), proc(21, 'worker', OLD, { ppid: 20 })], ctx());
    expect(plan.steps).toEqual([{ kind: 'supervisor', pid: 20, workers: [21], ...supervisorRestartArgv(args) }]);
  });

  test('a stale worker under a current supervisor restarts the supervisor', () => {
    const plan = planRestart([proc(20, 'supervisor', NEW), proc(21, 'worker', OLD, { ppid: 20 })], ctx());
    expect(plan.steps).toEqual([{ kind: 'supervisor', pid: 20, workers: [21], ...DEFAULT_SUP }]);
  });

  test('a process that reports no build counts as stale', () => {
    expect(planRestart([proc(10, 'serve', null)], ctx()).steps).toEqual([{ kind: 'service', role: 'serve', argv: SERVE_SERVICE, pids: [10] }]);
  });

  test('an installed service restarts only the processes its manager runs; a hand-started serve beside it is manual', () => {
    const plan = planRestart([proc(10, 'serve'), proc(12, 'serve', OLD, { ancestors: [500] })], ctx());
    expect(plan.steps).toEqual([{ kind: 'service', role: 'serve', argv: SERVE_SERVICE, pids: [10] }]);
    expect(plan.manual.map(m => [m.pid, m.argv])).toEqual([[12, ['kill', '12']]]);
    expect(plan.manual[0]!.instruction).toContain(`(the service runs pid ${SERVE_PID})`);
    const stopped = planRestart([proc(10, 'serve')], ctx({ serveService: { argv: SERVE_SERVICE, pid: null } }));
    expect(stopped.steps).toEqual([]);
    expect(stopped.manual[0]!.instruction).toContain('the service is not running');
  });

  test('hand-started serve, standalone worker, service-less autopilot, a supervisor without readable options and a running sync are manual steps', () => {
    const plan = planRestart([proc(10, 'serve'), proc(21, 'worker', OLD), proc(30, 'autopilot'), proc(40, 'sync'), proc(20, 'supervisor', OLD, { args: undefined })],
      ctx({ serveService: null, autopilotService: null }));
    expect(plan.steps).toEqual([]);
    expect(plan.manual.map(m => [m.role, m.argv])).toEqual([
      ['serve', ['kill', '10']], ['worker', ['kill', '21']], ['autopilot', ['kill', '30']], ['sync', ['gbrain', 'sync', 'status', '--json']], ['supervisor', ['kill', '20']],
    ]);
    expect(plan.manual[0]!.instruction).toContain('was not started by the installed serve service');
    expect(plan.manual[1]!.instruction).toContain('gbrain jobs supervisor start --detach');
    expect(plan.manual[3]!.instruction).toContain('let it finish');
    expect(plan.manual[4]!.instruction).toContain('not restarted with defaults');
  });

  test('an MCP server refuses without --stop-mcp and is stopped with it', () => {
    expect(planRestart([proc(50, 'mcp')], ctx()).manual.map(m => m.role)).toEqual(['mcp']);
    const plan = planRestart([proc(50, 'mcp'), proc(10, 'serve')], ctx({ stopMcp: true }));
    expect(plan.manual).toEqual([]);
    expect(plan.steps.at(-1)).toEqual({ kind: 'stop', role: 'mcp', pid: 50, started_ms: 1_000 });
    expect(plan.steps[0]).toMatchObject({ kind: 'service', role: 'serve' });
  });
});

describe('restartRefusal', () => {
  test('MCP-only refusals ask the user to rerun with --stop-mcp; others tell the user the first manual step; exit 3', () => {
    const mcp = restartRefusal(planRestart([proc(50, 'mcp')], ctx()), ['gbrain', 'upgrade', '--channel', 'stable'], false)!;
    expect(mcp.code).toBe('restart_refused');
    expect(exitCodeForCode(mcp.code)).toBe(3);
    expect(mcp.message).toContain('nothing was installed');
    expect(mcp.fix).toMatchObject({ ask_user: true, actor: 'agent', argv: ['gbrain', 'upgrade', '--channel', 'stable', '--stop-mcp'] });
    expect(mcp.fix?.user_message).toContain('pid 50');
    const serve = restartRefusal(planRestart([proc(50, 'mcp'), proc(10, 'serve')], ctx({ serveService: null })), ['gbrain', 'upgrade', '--restart-only'], true)!;
    expect(serve.message).not.toContain('nothing was installed');
    expect(serve.fix).toMatchObject({ actor: 'user', argv: ['kill', '10'] });
    expect(restartRefusal(planRestart([proc(10, 'serve')], ctx()), ['gbrain', 'upgrade'], false)).toBeNull();
  });
});

describe('runRestartSteps', () => {
  const executor = (over: { status?: (argv: string[]) => number; supervisorPid?: (file: string | null) => number | null; terminate?: RestartExecutor['terminate'] } = {}) => {
    const calls: string[] = [];
    const exec: RestartExecutor = {
      run: argv => { calls.push(argv.join(' ')); return { status: over.status?.(argv) ?? 0, output: 'boom\nmore' }; },
      terminate: over.terminate ?? (pid => { calls.push(`SIGTERM ${pid}`); return 'stopped'; }),
      supervisorPid: over.supervisorPid ?? (() => null),
      sleep: async () => {},
    };
    return { calls, exec };
  };
  const plan = planRestart([proc(10, 'serve'), proc(20, 'supervisor'), proc(21, 'worker', OLD, { ppid: 20 }), proc(50, 'mcp')], ctx({ stopMcp: true }));

  test('runs serve first, then the supervisor stop and start, then stops MCP servers', async () => {
    const { calls, exec } = executor();
    const results = await runRestartSteps(plan, exec);
    expect(calls).toEqual([SERVE_SERVICE.join(' '), DEFAULT_SUP.stop.join(' '), DEFAULT_SUP.start.join(' '), 'SIGTERM 50']);
    expect(results.every(r => r.ok)).toBe(true);
  });

  test('a supervisor its service manager respawned is not started twice; the respawn is read from its own PID file', async () => {
    const files: Array<string | null> = [];
    const { calls, exec } = executor({ supervisorPid: file => { files.push(file); return 77; } });
    const custom = planRestart([proc(20, 'supervisor', OLD, { args: ['jobs', 'supervisor', '--pid-file', '/tmp/sup-example.pid'] })], ctx());
    const results = await runRestartSteps(custom, exec);
    expect(calls).toEqual(['gbrain jobs supervisor stop --pid-file /tmp/sup-example.pid --json']);
    expect(files).toEqual(['/tmp/sup-example.pid']);
    expect(results[0]!.detail).toContain('started pid 77');
  });

  test('an MCP pid that now names another process is not signalled and fails the step', async () => {
    const { exec } = executor({ terminate: () => 'changed' });
    const results = await runRestartSteps(plan, exec);
    expect(results.at(-1)).toMatchObject({ ok: false });
    expect(results.at(-1)!.detail).toContain('was not signalled');
  });

  test('a failed command is reported with its first output line', async () => {
    const { exec } = executor({ status: argv => argv[0] === 'systemctl' ? 5 : 0 });
    const results = await runRestartSteps(plan, exec);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.detail).toContain('exited 5: boom');
  });
});

describe('restartProblems and verifyRestart', () => {
  const plan = planRestart([proc(10, 'serve'), proc(20, 'supervisor'), proc(21, 'worker', OLD, { ppid: 20 })], ctx());
  const absent: WarmSocketState = { state: 'absent' };
  const accepted: WarmSocketState = { state: 'accepted' };
  const after = [proc(110, 'serve', NEW, { started_ms: 5_000 }), proc(120, 'supervisor', NEW, { started_ms: 5_000 }), proc(121, 'worker', NEW, { ppid: 120, started_ms: 5_000 })];

  test('done when the old pids are gone, every process reports the build and the roles came back', () => {
    expect(restartProblems(plan, after, 4_000, { before: accepted, after: accepted })).toEqual([]);
  });

  test('names a surviving old pid, another build, an unrecorded build from before the restart, and a role that did not return', () => {
    const problems = restartProblems(plan, [proc(10, 'serve'), proc(130, 'mcp', OLD), proc(140, 'autopilot', null, { started_ms: 3_000 })], 4_000, { before: absent, after: absent });
    expect(problems).toEqual([
      `serve pid 10 (v${OLD}) is still running after the restart.`,
      `mcp pid 130 (v${OLD}) runs a build other than v${NEW}.`,
      'autopilot pid 140 (build not recorded) reports no build and started before the restart.',
      'serve did not come back after `systemctl --user restart gbrain-serve.service`.',
      'supervisor did not come back after the supervisor restart.',
    ]);
  });

  test('a restarted supervisor whose worker has not come back is not done', () => {
    expect(restartProblems(plan, after.slice(0, 2), 4_000, { before: absent, after: absent }))
      .toEqual(['the jobs worker did not come back under the restarted supervisor (`' + DEFAULT_SUP.start.join(' ') + '`).']);
  });

  test('a process with no recorded build must have started after the restart from an install that holds the build', () => {
    expect(restartProblems(plan, [...after, proc(150, 'mcp', null, { started_ms: 6_000, install_version: NEW })], 4_000, { before: absent, after: absent })).toEqual([]);
    expect(restartProblems(plan, [...after, proc(151, 'mcp', null, { started_ms: 6_000, install_version: OLD })], 4_000, { before: absent, after: absent }))
      .toEqual([`mcp pid 151 (build not recorded) reports no build and was started from an install that holds v${OLD}.`]);
    const binary = [...after, proc(152, 'serve', null, { started_ms: 6_000, install_version: null })];
    expect(restartProblems(plan, binary, 4_000, { before: absent, after: absent })).toEqual([]);
    expect(unverifiedBuilds(plan, binary)).toEqual(['serve pid 152 (build not recorded) started after the restart but records no build, so its build is inferred from its start time.']);
  });

  test('the warm socket must accept the build; an env difference is this shell, not the upgrade', () => {
    const warm = (state: WarmSocketState) => restartProblems(plan, after, 4_000, { before: accepted, after: state });
    expect(warm({ state: 'refused', reason: 'identity_mismatch', mismatch: 'version' })).toEqual(['The warm CLI socket refused this build (identity_mismatch: version).']);
    expect(warm({ state: 'refused', reason: 'malformed_request' })).toEqual(['The warm CLI socket refused this build (malformed_request).']);
    expect(warm({ state: 'refused', reason: 'identity_mismatch', mismatch: 'env GBRAIN_MODEL' })).toEqual([]);
    expect(warm(absent)).toEqual(['The warm CLI socket serve had before the restart is gone.']);
    expect(restartProblems(plan, after, 4_000, { before: absent, after: absent })).toEqual([]);
  });

  test('verifyRestart polls until the restart settles, and gives up at the deadline with the problems', async () => {
    let clock = 0;
    const rounds = [[proc(10, 'serve'), ...after.slice(1)], after];
    let round = 0;
    const deps = { collect: async () => rounds[Math.min(round++, rounds.length - 1)]!, probeWarmSocket: async () => accepted, sleep: async (ms: number) => { clock += ms; }, now: () => clock };
    const ok = await verifyRestart(plan, 4_000, accepted, deps, { timeoutMs: 10_000, pollMs: 2_000 });
    expect(ok).toMatchObject({ ok: true, problems: [], unverified: [] });
    expect(clock).toBe(2_000);
    clock = 0;
    const stuck = await verifyRestart(plan, 4_000, accepted, { ...deps, collect: async () => [proc(10, 'serve'), ...after.slice(1)] }, { timeoutMs: 6_000, pollMs: 2_000 });
    expect(stuck.ok).toBe(false);
    expect(stuck.problems[0]).toContain('serve pid 10');
    expect(clock).toBe(6_000);
  });
});
