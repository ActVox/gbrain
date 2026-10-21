/**
 * #7172: planMoveWaves renumbers kept chunk rows without breaking the (page_id, chunk_index) unique index, within a
 * row-write budget.
 *
 * 1. Protects: every planned wave moves rows only onto free indexes (or parks one row of a cycle at a negative index),
 *    applying the waves in order reaches every target, the number of row updates never passes the budget, and a plan
 *    cut by the budget says so (`done: false`).
 * 2. Fails when: a wave lands a row on an index another row still holds, a cycle never resolves, or a plan spends more
 *    updates than its budget.
 * 3. Pure; no engine.
 */
import { describe, expect, test } from 'bun:test';
import { planMoveWaves, type ChunkMove } from '../src/core/page-state/chunk-moves.ts';

/** Applies the waves to `at` (index -> id), checking each wave lands only on free indexes. */
function replay(at: Map<number, number>, waves: ChunkMove[][]): Map<number, number> {
  const state = new Map(at);
  for (const wave of waves) {
    for (const move of wave) state.delete([...state].find(([, id]) => id === move.id)![0]);
    for (const move of wave) {
      expect(state.has(move.to)).toBe(false);
      state.set(move.to, move.id);
    }
  }
  return state;
}

const move = (id: number, from: number, to: number): ChunkMove => ({ id, from, to });

describe('planMoveWaves', () => {
  test('a shift down by one (an entry above) lands in waves from the free end', () => {
    const at = new Map([[0, 10], [1, 11], [2, 12]]);
    const moves = [move(10, 0, 1), move(11, 1, 2), move(12, 2, 3)];
    const plan = planMoveWaves(moves, at, 10);
    expect(plan.done).toBe(true);
    expect(plan.updates).toBe(3);
    expect([...replay(at, plan.waves)].sort((a, b) => a[0] - b[0])).toEqual([[1, 10], [2, 11], [3, 12]]);
  });

  test('a swap parks one row at a negative index and resolves', () => {
    const at = new Map([[0, 10], [1, 11]]);
    const plan = planMoveWaves([move(10, 0, 1), move(11, 1, 0)], at, 10);
    expect(plan.done).toBe(true);
    expect(plan.waves[0]).toEqual([{ id: 10, from: 0, to: -2 }]);
    expect(plan.updates).toBe(3);
    expect([...replay(at, plan.waves)].sort((a, b) => a[0] - b[0])).toEqual([[0, 11], [1, 10]]);
  });

  test('a budget cuts the plan and never spends past it', () => {
    const at = new Map(Array.from({ length: 20 }, (_, i) => [i, 100 + i] as [number, number]));
    const moves = Array.from({ length: 20 }, (_, i) => move(100 + i, i, i + 1));
    for (const budget of [0, 1, 5, 19]) {
      const plan = planMoveWaves(moves, at, budget);
      expect(plan.updates).toBeLessThanOrEqual(budget);
      expect(plan.done).toBe(false);
      replay(at, plan.waves);
    }
    expect(planMoveWaves(moves, at, 20).done).toBe(true);
  });
});
