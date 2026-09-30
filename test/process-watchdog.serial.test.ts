/**
 * Bun-pinned integration for the out-of-band watchdog (#1633, plan A4).
 *
 * Bun's worker_threads Worker is flagged "experimental", and the whole #1633
 * fix rests on a worker timer firing + SIGKILLing the process while the MAIN
 * thread is starved by a synchronous loop. These tests spawn a real harness
 * process that starves its own loop and assert the watchdog kills it anyway.
 *
 * Serial because they use real subprocesses + wall-clock timing.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HARNESS = join(import.meta.dir, 'fixtures', 'watchdog-harness.ts');

async function runHarness(
  mode: string,
  deadlineMs: number,
  graceMs: number,
  hardCapMs: number,
  stderrFd?: number,
): Promise<{ exitCode: number | null; signalCode: string | null; signalled: boolean; elapsedMs: number; stdout: string; stderr: string; killedByTest: boolean }> {
  const proc = Bun.spawn(['bun', HARNESS, mode, String(deadlineMs), String(graceMs)], {
    stdout: 'pipe',
    stderr: stderrFd ?? 'pipe',
  });
  const start = Date.now();
  let killedByTest = false;
  const cap = setTimeout(() => { killedByTest = true; proc.kill('SIGKILL'); }, hardCapMs);
  await proc.exited;
  clearTimeout(cap);
  const elapsedMs = Date.now() - start;
  const stdout = await new Response(proc.stdout).text();
  const stderr = typeof proc.stderr === 'number' ? '' : await new Response(proc.stderr).text();
  // Bun surfaces signal death via exitCode === null + signalCode, or a negative
  // exitCode on some platforms. Treat "not a clean 0" as signalled for our purpose.
  const signalled = proc.exitCode !== 0;
  return { exitCode: proc.exitCode, signalCode: proc.signalCode, signalled, elapsedMs, stdout, stderr, killedByTest };
}

describe('watchdog signaling with a stalled stderr consumer', () => {
  for (const mode of ['starve-stderr-blocked', 'stall-stderr-blocked']) {
    test.skipIf(process.platform === 'win32')(`${mode}: a full FIFO cannot delay SIGKILL`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-watchdog-fifo-'));
      let fd: number | undefined;
      try {
        const fifo = join(dir, 'stderr');
        expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
        // O_RDWR opens the FIFO without waiting for another reader. Never
        // read it: Bun's usual stderr:'pipe' eagerly drains and masks this bug.
        fd = openSync(fifo, 'r+');
        const r = await runHarness(mode, 300, 250, 3000, fd);
        expect(r.stdout).toContain('FILLING_STDERR');
        expect(r.stdout).not.toContain('STDERR_WRITE_RETURNED');
        expect(r.killedByTest).toBe(false);
        expect(r.signalCode).toBe('SIGKILL');
        expect(r.elapsedMs).toBeGreaterThanOrEqual(500);
        expect(r.elapsedMs).toBeLessThan(2000);
      } finally {
        if (fd !== undefined) closeSync(fd);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);
  }
});

describe('process-watchdog integration (Bun-pinned)', () => {
  test('starved process IS killed by the watchdog around deadline+grace', async () => {
    // deadline 300 + grace 200 = ~500ms expected death. Hard cap 4s: if the
    // watchdog failed, the test's own SIGKILL fires and the assertion catches it.
    const r = await runHarness('starve-with', 300, 200, 4000);
    expect(r.stdout).not.toContain('SURVIVED'); // the bug symptom
    expect(r.killedByTest).toBe(false);          // watchdog, not the test, killed it
    expect(r.signalled).toBe(true);
    // Died well before the harness's 8s self-exit safety net, near deadline+grace.
    expect(r.elapsedMs).toBeLessThan(3000);
    // Even the first signal's diagnostic must reach the parent pipe before
    // the default SIGTERM disposition exits this loop-starved process.
    expect(r.stderr).toContain('[test-wd] deadline reached');
  }, 15000);

  test('control: a starved process WITHOUT the watchdog does not self-exit', async () => {
    // Proves the busy loop genuinely starves (so the death above is the watchdog).
    // No watchdog installed; the test's hard cap (1.2s) is what kills it.
    const r = await runHarness('starve-without', 300, 200, 1200);
    expect(r.killedByTest).toBe(true);   // only the test's SIGKILL stopped it
    expect(r.stdout).not.toContain('SURVIVED');
  }, 15000);

  test('clean dispose: a disposed watchdog never kills the process', async () => {
    // Long deadline, disposed immediately, process exits 0 fast and prints DISPOSED.
    const r = await runHarness('clean-dispose', 60000, 60000, 5000);
    expect(r.exitCode).toBe(0);
    expect(r.killedByTest).toBe(false);
    expect(r.stdout).toContain('DISPOSED');
    expect(r.elapsedMs).toBeLessThan(4000);
  }, 15000);
});

describe('loop-stall watchdog integration (Bun-pinned, #4281)', () => {
  test('starved loop with a SIGTERM listener is SIGTERMed then SIGKILLed around stall+grace', async () => {
    // stall 300 + grace 250 = ~550ms expected death (plus worker boot). The
    // harness registers a SIGTERM listener, so only the SIGKILL escalation can
    // actually kill it — exactly the serve-http shape (process-cleanup's
    // handler can't run on a starved loop).
    const r = await runHarness('stall-with', 300, 250, 5000);
    expect(r.stdout).not.toContain('SURVIVED'); // the bug symptom
    expect(r.killedByTest).toBe(false);          // watchdog, not the test, killed it
    expect(r.signalled).toBe(true);
    expect(r.elapsedMs).toBeLessThan(3500);
    // The worker latched SIGTERM first, then escalated — both visible in its log.
    expect(r.stderr).toContain('SIGTERM');
    expect(r.stderr).toContain('SIGKILL');
    expect(r.stderr.indexOf('SIGTERM')).toBeLessThan(r.stderr.indexOf('SIGKILL'));
  }, 15000);

  test('healthy petting loop is NEVER killed across multiple stall windows', async () => {
    // The false-positive pin: the harness idles (pets flowing) for well past
    // stall+grace. Any signal is a watchdog bug — a false SIGTERM prints
    // TERMED and exits 1; a false SIGKILL shows as non-zero exit.
    const r = await runHarness('stall-healthy', 300, 200, 6000);
    expect(r.killedByTest).toBe(false);
    expect(r.stdout).not.toContain('TERMED');
    expect(r.stdout).toContain('HEALTHY');
    expect(r.exitCode).toBe(0);
  }, 15000);

  test('disposed stall watchdog never kills, even under genuine starvation', async () => {
    // Disposed immediately, then the harness truly starves past stall+grace.
    const r = await runHarness('stall-dispose', 300, 200, 6000);
    expect(r.killedByTest).toBe(false);
    expect(r.stdout).toContain('DISPOSED');
    expect(r.exitCode).toBe(0);
  }, 15000);
});
