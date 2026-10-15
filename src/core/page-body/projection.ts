/**
 * Segmented page projection (Wave B, lane 1d): chunk every live manifest
 * occurrence that has no chunk rows at the page's live body generation, stage
 * them, retire rows of occurrences no longer live, and seal the text
 * projection when the page is still at `expectedRevision` (or its current
 * revision). Reads one segment at a time. Used after a segmented create (whose
 * chunks cannot be staged before the page row exists), by the projection job
 * for a page left unsealed (crash, deferred retirement), and by rebuilds.
 */
import type { BrainEngine } from '../engine.ts';

export interface SegmentedProjectionResult { chunks: number; retired: number; sealed: boolean }

export async function buildSegmentedProjection(_engine: BrainEngine, _ref: { sourceId: string; slug: string },
  _opts?: { expectedRevision?: string }): Promise<SegmentedProjectionResult> {
  throw new Error('buildSegmentedProjection: implemented by Wave B lane 1d');
}
