/**
 * #6712 PR 4b flake: the loop-lag bounds (test/sync-pass-shared-budget-6712.test.ts, test/sync-pass-loop-lag-6712.test.ts)
 * read wall time between timer runs, so a loaded CI VM that kept the thread off the CPU counted as code holding the loop:
 * a forced 60 ms stretch read 133 ms against the 100 ms bound on a 4-vCPU shard. Pinned to one core with three CPU hogs,
 * the shared-budget test read 156-257 ms; per-gap schedstat showed the excess as run-queue wait plus sleeps behind a
 * spawned Git that had not reached exec, with the thread's own CPU at 61-69 ms. `watchLoopLag` reads the thread's CPU.
 *
 * Forced probe (deterministic): the thread blocks 150 ms with a timer due, as it does behind a spawned Git that has not
 * reached exec. The wall clock reads it as 150 ms of lag; the thread's CPU clock, read on both sides of the block, does
 * not move. The CPU clock still sees a stretch of work, and two stretches in one turn, the regression the bounds exist to
 * catch.
 *
 * The block is an Atomics.wait, not a synchronous child: a spawn's own setup runs on the thread (1-4 ms, about 20 ms for a
 * process's first spawn), and on a VM that charges host steal to the running thread those few ms read 30 ms once against
 * the 25 ms bound (#7231, full-suite). That is the spawn's work, not the off-CPU time this test is about.
 *
 * The block settles the engine's heap first. A wait hands the heap over, and JavaScriptCore runs collector work it owes
 * the thread at that handoff: the last marking phase of a collection in flight (the thread wakes the marker threads and
 * waits on them before it parks) and, on waking, the finalize phase that returns emptied blocks with madvise. A shard
 * process carries the heap of every earlier test file, so a collection can end just before the block: 37 ms read once
 * against the 25 ms bound (#7304, full-suite), and under strace one such block made 14,488 system calls after its
 * timeout, nearly all madvise. With a 6M-object heap and 1.5M objects dropped before each of 40 blocks, 3-6 blocks per run read 26-56 ms;
 * a full collection and a 1 ms block before the reading leave at most 2.6 ms (4 runs each).
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { threadCpuNow } from './helpers/cpu-time.ts';

/** The bound the loop-lag tests hold. */
const MAX_LAG_MS = 100;
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 20));
const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Blocks the thread off the CPU for `ms`; returns the thread CPU the block cost. */
const offCpu = (ms: number) => {
  Bun.gc(true);
  block(1);
  const start = threadCpuNow();
  expect(block(ms)).toBe('timed-out');
  return threadCpuNow() - start;
};

test('a thread kept off the CPU with a timer due is not lag; the wall clock reads it as lag', async () => {
  let last = performance.now(), wallLag = 0;
  const wall = setInterval(() => { const now = performance.now(); wallLag = Math.max(wallLag, now - last - 5); last = now; }, 5);
  await turn();
  const cpu = offCpu(150);
  await turn();
  clearInterval(wall);
  expect(Math.round(wallLag)).toBeGreaterThanOrEqual(MAX_LAG_MS + 40);
  // The 150 ms off the CPU cost none.
  expect(Math.round(cpu)).toBeLessThan(MAX_LAG_MS / 4);
});

test('a stretch of work is lag on the CPU clock, and two stretches in one turn add up', () => {
  // In a fresh process: the reading covers every task on the thread between two timer runs, and in a shared shard
  // process work an earlier test file left running lands there too (a 60 ms stretch read 106 ms on a GitHub shard).
  const helper = JSON.stringify(join(import.meta.dir, 'helpers', 'cpu-time.ts'));
  const probe = `import { spinCpuMs, watchLoopLag } from ${helper};
    const turn = () => new Promise(resolve => setTimeout(resolve, 20));
    const one = watchLoopLag();
    await turn(); spinCpuMs(60); await turn();
    const single = one.stop();
    const two = watchLoopLag();
    await turn(); spinCpuMs(60); spinCpuMs(60); await turn();
    console.log(JSON.stringify({ single, two: two.stop() }));`;
  const { single, two } = JSON.parse(execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim().split('\n').pop()!) as Record<'single' | 'two', { maxLag: number; ticks: number }>;
  expect(single.ticks).toBeGreaterThan(0);
  expect(Math.round(single.maxLag)).toBeGreaterThanOrEqual(60);
  expect(Math.round(single.maxLag)).toBeLessThan(MAX_LAG_MS);
  expect(Math.round(two.maxLag)).toBeGreaterThanOrEqual(120);
});
