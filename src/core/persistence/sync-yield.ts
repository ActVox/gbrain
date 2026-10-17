/**
 * #6712 PR 4b (design v3 "Bounded memory": CPU loops yield): the cooperative yield of a large level's synchronous loops.
 * A 600k-path round classifies, maps and sorts for seconds; without a turn of the event loop between stretches the
 * persistence consumer's idle probe, lease renewals and every timer starve for that long. A loop asks `due()` once per
 * entry (a counter, then the clock every 64 entries: a probe's entry reads a file) and awaits `pause()` when its stretch has run
 * `LOOP_BUDGET_MS`: one macrotask (`setImmediate`), so expired timers and I/O run before it continues.
 */

/** A stretch of synchronous work longer than this yields (the ruling bounds a stretch at about 100 ms; the rest is room for the entry that crosses it and for work outside these loops). */
export const LOOP_BUDGET_MS = 30;
const CHECK_EVERY = 64;

export interface LoopYield {
  /** Whether the current stretch has run its budget; cheap enough to ask per entry (`entries`: how many this call stands for). */
  due(entries?: number): boolean;
  /** One macrotask turn; the next stretch starts after it. */
  pause(): Promise<void>;
}

export function loopYield(): LoopYield {
  let since = performance.now(), n = 0;
  return {
    due: (entries = 1) => { n += entries; if (n < CHECK_EVERY) return false; n = 0; return performance.now() - since >= LOOP_BUDGET_MS; },
    pause: async () => { await new Promise<void>(resolve => setImmediate(resolve)); since = performance.now(); },
  };
}

/** `items.sort()` (code-unit order, as the default comparator) in runs merged with yields between stretches. */
export async function sortYielding(items: string[], step: LoopYield): Promise<string[]> {
  const RUN = 16_384;
  let runs: string[][] = [];
  for (let i = 0; i < items.length; i += RUN) {
    runs.push(items.slice(i, i + RUN).sort());
    if (step.due(RUN)) await step.pause();
  }
  while (runs.length > 1) {
    const next: string[][] = [];
    for (let r = 0; r < runs.length; r += 2) {
      const a = runs[r]!, b = runs[r + 1];
      if (!b) { next.push(a); continue; }
      const out = new Array<string>(a.length + b.length);
      let i = 0, j = 0, k = 0;
      while (i < a.length && j < b.length) {
        out[k++] = b[j]! < a[i]! ? b[j++]! : a[i++]!;
        if (step.due()) await step.pause();
      }
      while (i < a.length) out[k++] = a[i++]!;
      while (j < b.length) out[k++] = b[j++]!;
      next.push(out);
    }
    runs = next;
  }
  return runs[0] ?? [];
}
