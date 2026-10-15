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
 * CPU-time scaling ratio `large / small` for a linearity bound: after one warm-up run of each, `rounds` independent
 * ratios, each the best of `runs` samples at the large size over the best of `runs` at the small size, and their
 * median. A sample repeats its call until the window holds at least `minWindowMs` of thread CPU and takes the mean
 * per call: thread CPU advances in about 4 ms steps on Linux, so a single 28 ms call reads anywhere from 24 to 32 ms
 * and a best-of-three small side alone moved a linear 2.2x to 2.66x. Small and large samples alternate, so a slow
 * spell on a shared core has to cover both sizes to move a ratio. A collection landing in one sample skews one
 * round's best at most, and the median drops that round; collecting before each call made it worse, because every
 * measured call then regrew the heap (allocation-heavy shapes went from a 2.30x to a 2.98x worst case in 36 runs).
 */
export function cpuScalingRatio(
  small: () => unknown,
  large: () => unknown,
  opts: { rounds?: number; runs?: number; minWindowMs?: number } = {},
): number {
  const rounds = opts.rounds ?? 3;
  const runs = opts.runs ?? 3;
  const minWindowMs = opts.minWindowMs ?? 200;
  small();
  large();
  const sample = (fn: () => unknown) => {
    const start = process.threadCpuUsage();
    let calls = 0;
    let ms = 0;
    do {
      fn();
      calls++;
      const used = process.threadCpuUsage(start);
      ms = (used.user + used.system) / 1000;
    } while (ms < minWindowMs);
    return ms / calls;
  };
  const ratios: number[] = [];
  for (let round = 0; round < rounds; round++) {
    let s = Infinity;
    let l = Infinity;
    for (let k = 0; k < runs; k++) {
      s = Math.min(s, sample(small));
      l = Math.min(l, sample(large));
    }
    ratios.push(l / s);
  }
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(rounds / 2)]!;
}

/**
 * cpuMs for an async span: thread CPU from the call until it settles. It counts everything the thread runs in
 * between (PGLite's WASM engine runs on the calling thread) and nothing the span waits for (I/O on other threads,
 * timers, subprocesses). Use it only where nothing else runs in the process during the span and the span does
 * not wait on I/O, a timer or another process.
 */
export async function cpuMsAsync(fn: () => Promise<unknown>): Promise<number> {
  const start = process.threadCpuUsage();
  await fn();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}
