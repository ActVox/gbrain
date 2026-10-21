import type { BrainEngine } from '../engine.ts';
import type { ChunkInput } from '../types.ts';

/**
 * #7172: the most row writes one page's chunk replacement makes in one transaction.
 *
 * A row write here is a new row version of content_chunks: an inserted passage, and an UPDATE of `chunk_index` or of
 * the vector too, because each changes an indexed column, so the update is not HOT and Postgres adds an entry for the
 * new version to every index of the table: the GIN index of the passage's search vector (one entry per lexeme), the
 * HNSW index when the vector is not NULL, and the b-trees (measured on pgvector: renumbering 2,000 rows cost what
 * inserting 2,000 did). A delete adds no index entry, so it is not counted. On a large table these entries land on
 * index pages that are not cached; the slowest passage inserts reported on a large production index ran at about
 * 0.5 s per row, so the bound charges 0.5 s per row write with nothing amortized. A publication's statements each run
 * under a transaction-local 5 s `statement_timeout` (protocol.ts `declareDurablePersistence`), and half of it is left
 * for the work every write does besides (lock waits, the page row, a GIN pending-list flush):
 * floor(2.5 s / 0.5 s) = 5. A replacement that needs more commits its page with the projection pending and finishes
 * in post-commit transactions of at most this many row writes each (`continueDeferredProjection`).
 */
export const CHUNK_ROW_WRITE_BUDGET = 5;

/** A stored chunk row that keeps its id and vector and changes index (`to`), with the span its new chunk records. */
export interface ChunkMove { id: number; from: number; to: number; projected_byte_start?: number | null; projected_byte_end?: number | null }

/**
 * The UPDATE statements (waves) that move `moves` without breaking the (page_id, chunk_index) unique index, using at
 * most `budget` row updates. `occupied` maps each index a remaining row holds to its id. A wave moves rows whose
 * target is free; when none is (a cycle), one row parks at the negative index `-1 - to` and lands later. `done` says
 * every move fits; `pending` and `at` are the moves left and the occupied indexes once the waves ran.
 */
export function planMoveWaves(moves: readonly ChunkMove[], occupied: ReadonlyMap<number, number>, budget: number):
  { waves: ChunkMove[][]; updates: number; done: boolean; pending: ChunkMove[]; at: Map<number, number> } {
  const at = new Map(occupied);
  let pending = moves.map(move => ({ ...move }));
  const waves: ChunkMove[][] = [];
  let updates = 0;
  while (pending.length && updates < budget) {
    const free = pending.filter(move => !at.has(move.to)).slice(0, budget - updates);
    const wave = free.length ? free : [{ ...pending[0]!, to: -1 - pending[0]!.to }];
    for (const move of wave) { at.delete(move.from); at.set(move.to, move.id); }
    waves.push(wave);
    updates += wave.length;
    if (free.length) pending = pending.filter(move => !free.includes(move));
    else pending[0]!.from = wave[0]!.to;
  }
  return { waves, updates, done: pending.length === 0, pending, at };
}

/**
 * #7172: an import's chunk row writes. `kept` maps a new chunk's position in `fresh` to the stored row it keeps; a kept
 * row whose chunk sits at another index moves there (`waves`). With `bounded` (a managed publication), `defer` says the
 * moves and inserts pass CHUNK_ROW_WRITE_BUDGET, so the publication leaves them to `continueDeferredProjection`.
 */
export function planImportChunkWrites(fresh: readonly ChunkInput[], kept: ReadonlyMap<number, { id: number; chunk_index: number }>, bounded: boolean):
  { waves: ChunkMove[][]; defer: boolean } {
  const moves = [...kept].filter(([i, row]) => row.chunk_index !== fresh[i]!.chunk_index).map(([i, row]) => ({ id: row.id, from: row.chunk_index,
    to: fresh[i]!.chunk_index, projected_byte_start: fresh[i]!.projected_byte_start ?? null, projected_byte_end: fresh[i]!.projected_byte_end ?? null }));
  const inserts = fresh.length - kept.size;
  const plan = planMoveWaves(moves, new Map([...kept.values()].map(row => [row.chunk_index, row.id])),
    bounded ? Math.max(0, CHUNK_ROW_WRITE_BUDGET - inserts) : Number.POSITIVE_INFINITY);
  return { waves: plan.waves, defer: bounded && fresh.length > 0 && (!plan.done || inserts > CHUNK_ROW_WRITE_BUDGET) };
}

/** One UPDATE per wave; a landed row takes its new chunk's span, a parked row keeps its own until it lands. */
export async function applyMoveWaves(tx: Pick<BrainEngine, 'executeRaw'>, pageId: number, waves: readonly ChunkMove[][]): Promise<void> {
  for (const wave of waves) {
    await tx.executeRaw(`UPDATE content_chunks c SET chunk_index = m.target,
        projected_byte_start = CASE WHEN m.target < 0 THEN c.projected_byte_start ELSE m.byte_start END,
        projected_byte_end = CASE WHEN m.target < 0 THEN c.projected_byte_end ELSE m.byte_end END
      FROM unnest($2::int[], $3::int[], $4::bigint[], $5::bigint[]) AS m(id, target, byte_start, byte_end)
      WHERE c.page_id = $1 AND c.id = m.id`,
    [pageId, wave.map(move => move.id), wave.map(move => move.to),
      wave.map(move => move.projected_byte_start ?? null), wave.map(move => move.projected_byte_end ?? null)]);
  }
}
