/**
 * CPU time of a synchronous call on the calling thread, in milliseconds. A bound or scaling ratio over CPU time
 * measures the work rather than how long the scheduler made it wait, so load on a shared CI VM does not move it.
 * `process.threadCpuUsage` (as in test/entity-card-perf.slow.test.ts and src/core/progress.ts) leaves out the
 * engine's GC and JIT threads and any other concurrent work in the process. It does not see time spent waiting on
 * I/O, a subprocess, a timer or another thread: a test that bounds those keeps the wall clock.
 */
export function cpuMs(fn: () => unknown): number {
  const start = process.threadCpuUsage();
  fn();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}

/**
 * CPU-time scaling ratio `large / small` for a linearity bound: after one warm-up run of each, `runs` interleaved pairs,
 * each call on a freshly collected heap, and the best of each side. Collecting first keeps the previous call's garbage
 * out of the measured call (thread CPU time counts collection work done on the calling thread), and interleaving keeps
 * a slow stretch of a loaded VM from landing on one side only.
 */
export function cpuScalingRatio(small: () => unknown, large: () => unknown, runs = 5): number {
  small();
  large();
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  for (let k = 0; k < runs; k++) {
    Bun.gc(true);
    bestSmall = Math.min(bestSmall, cpuMs(small));
    Bun.gc(true);
    bestLarge = Math.min(bestLarge, cpuMs(large));
  }
  return bestLarge / bestSmall;
}
