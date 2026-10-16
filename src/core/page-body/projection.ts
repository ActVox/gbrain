/**
 * Segmented page projection (Wave B, lane 1d): chunk every live manifest
 * occurrence that has no chunk rows at the page's live body generation, stage
 * them, retire rows of occurrences no longer live, and seal the text
 * projection when the page is still at `expectedRevision` (or its current
 * revision). Reads one segment batch at a time. Used after a segmented create
 * (whose chunks cannot be staged before the page row exists), by the
 * projection job for a page left unsealed (crash, deferred retirement), and by
 * rebuilds.
 *
 * One process builds a page's projection at a time: it claims the page's
 * queue row (`SEGMENTED_PROJECTION_CLAIM`, renewed with each chunk batch), so
 * a write's post-commit build and the resident's queue route do not both
 * chunk the whole body; a claim left by a dead process lapses after
 * SEGMENTED_PROJECTION_LEASE_SECONDS, and a build that throws releases it
 * at once (the resident's queue route then marks its own failures
 * `rebuild_failed`).
 *
 * Retirement runs in bounded statements and deletes, as the flip does: rows of
 * occurrences outside the live generation, inline rows a promotion deferred,
 * and older duplicates of a live occurrence (a projection that raced a flip).
 * GC would delete a marked row at once, and a delete leaves the HNSW index
 * alone where marking rewrote each row's entry.
 */
import type { BrainEngine } from '../engine.ts';
import { isQuarantined } from '../quarantine.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import { sealSegmentedPage } from '../persistence/segmented-apply.ts';
import { PROJECTION_RETRY_READY_SQL, SEGMENTED_JOB_PROBES, SEGMENTED_PROJECTION_CLAIM, SEGMENTED_PROJECTION_CLAIMED_SQL, SEGMENTED_PROJECTION_LEASE_SECONDS,
  type ProjectionRebuildFailure } from '../page-state/projections.ts';
import { occurrencesWithoutChunks, stageOccurrenceChunks } from './ingest.ts';
import { DEFAULT_FLIP_RETIRE_MAX_ROWS } from './limits.ts';
import type { JsonObject } from './types.ts';
import { assertGenerationTiles } from './body-tiling.ts';

export interface SegmentedProjectionResult { chunks: number; retired: number; sealed: boolean }

interface ProjectionPage {
  id: number; body_generation: number | string; knowledge_revision: string; text_projection_revision: string | null;
  title: string; frontmatter: JsonObject | null; body_flags: JsonObject | null; timeline_lead: string | null;
}

async function readProjectionPage(engine: Pick<BrainEngine, 'executeRaw'>, ref: { sourceId: string; slug: string }): Promise<ProjectionPage | null> {
  const [page] = await engine.executeRaw<ProjectionPage>(`SELECT id, body_generation, knowledge_revision::text AS knowledge_revision,
      text_projection_revision::text AS text_projection_revision, title, frontmatter, body_flags, timeline_lead
    FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND body_storage='segmented'`, [ref.sourceId, ref.slug]);
  return page ?? null;
}

/** Chunk rows of page $1 that generation $2 (live occurrences $3) does not hold: other occurrences, inline rows, older duplicates. */
const STALE_CHUNKS_SQL = `SELECT s.id FROM content_chunks s -- chunk-visibility-ok: retirement selects the rows the live generation does not hold
  WHERE s.page_id=$1
  AND (s.body_generation IS NULL
    OR (s.body_generation<=$2 AND NOT (s.occurrence_id=ANY($3::bigint[])))
    OR (s.body_generation<=$2 AND EXISTS (SELECT 1 FROM content_chunks n WHERE n.page_id=s.page_id AND n.occurrence_id=s.occurrence_id
      AND n.body_generation>s.body_generation AND n.body_generation<=$2)))`;

/** The page still stores a chunk row its live generation does not hold (a deferred retirement): sealing it would show the row. */
export async function hasStaleChunks(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, generation: number, live: readonly number[]): Promise<boolean> {
  return (await engine.executeRaw(`${STALE_CHUNKS_SQL} LIMIT 1`, [pageId, generation, live])).length > 0;
}

/**
 * Delete, in bounded batches, chunk rows the live generation does not hold: other occurrences, inline rows, older
 * duplicates. Each batch re-reads the page under its page lock and deletes only while the page is still segmented at
 * `generation` (a demotion's inline rows are the page's live chunks); `moved` when it was not.
 */
async function retireStaleChunks(engine: BrainEngine, ref: { sourceId: string; slug: string }, pageId: number, generation: number,
  live: readonly number[]): Promise<{ retired: number; moved: boolean }> {
  let retired = 0;
  for (;;) {
    const deleted = await engine.transaction(async tx => {
      await tx.lockPageKeys([ref]);
      const [page] = await tx.executeRaw<{ body_generation: number | string; body_storage: string }>('SELECT body_generation, body_storage FROM pages WHERE id=$1', [pageId]);
      if (page?.body_storage !== 'segmented' || Number(page.body_generation) !== generation) return null;
      return (await tx.executeRaw<{ id: number }>(`DELETE FROM content_chunks c WHERE c.id IN (${STALE_CHUNKS_SQL} LIMIT $4) RETURNING c.id`,
        [pageId, generation, live, DEFAULT_FLIP_RETIRE_MAX_ROWS])).length;
    });
    if (deleted === null) return { retired, moved: true };
    retired += deleted;
    if (deleted < DEFAULT_FLIP_RETIRE_MAX_ROWS) return { retired, moved: false };
    if (engine.kind === 'pglite') await new Promise(resolve => setImmediate(resolve));
  }
}

const JOB_OF_PAGE = 'source_incarnation=(SELECT incarnation FROM sources WHERE id=$1) AND slug=$2';

/** Claim the page's queue row; false when another process holds it. A page with no queued row is built unclaimed. */
async function claimProjection(engine: Pick<BrainEngine, 'executeRaw'>, ref: { sourceId: string; slug: string }): Promise<boolean> {
  const [job] = await engine.executeRaw<{ claimed: boolean }>(`WITH claimed AS (UPDATE page_projection_jobs SET reason='${SEGMENTED_PROJECTION_CLAIM}', updated_at=now()
      WHERE ${JOB_OF_PAGE} AND NOT (reason='${SEGMENTED_PROJECTION_CLAIM}' AND updated_at>=now()-interval '${SEGMENTED_PROJECTION_LEASE_SECONDS} seconds') RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM claimed) AS claimed WHERE EXISTS (SELECT 1 FROM claimed) OR EXISTS (SELECT 1 FROM page_projection_jobs WHERE ${JOB_OF_PAGE})`,
  [ref.sourceId, ref.slug]);
  return !job || job.claimed;
}

export async function buildSegmentedProjection(engine: BrainEngine, ref: { sourceId: string; slug: string },
  opts: { expectedRevision?: string } = {}): Promise<SegmentedProjectionResult> {
  const page = await readProjectionPage(engine, ref);
  if (!page || (opts.expectedRevision !== undefined && page.knowledge_revision !== opts.expectedRevision)) return { chunks: 0, retired: 0, sealed: false };
  if (page.text_projection_revision !== page.knowledge_revision && !await claimProjection(engine, ref)) return { chunks: 0, retired: 0, sealed: false };
  try {
    return await buildClaimedProjection(engine, ref, page);
  } catch (error) {
    await engine.executeRaw(`UPDATE page_projection_jobs SET reason='canonical_change', updated_at=now() WHERE ${JOB_OF_PAGE} AND reason='${SEGMENTED_PROJECTION_CLAIM}'`,
      [ref.sourceId, ref.slug]).catch(() => undefined);
    throw error;
  }
}

async function buildClaimedProjection(engine: BrainEngine, ref: { sourceId: string; slug: string }, page: ProjectionPage): Promise<SegmentedProjectionResult> {
  const generation = Number(page.body_generation);
  const pageId = Number(page.id);
  const liveRows = await engine.readManifest(pageId);
  await assertGenerationTiles(engine, pageId, generation, liveRows);
  const { retired, moved } = await retireStaleChunks(engine, ref, pageId, generation, liveRows.map(row => Number(row.occurrenceId)));
  if (moved) return { chunks: 0, retired, sealed: false };
  const frontmatter = page.frontmatter ?? {};
  const quarantined = isQuarantined(frontmatter);
  const unchunked = await occurrencesWithoutChunks(engine, pageId, generation, liveRows);
  const staged = await stageOccurrenceChunks(engine, { pageId, sourceId: ref.sourceId, slug: ref.slug, generation, occurrences: unchunked, title: page.title,
    frontmatter, flags: page.body_flags ?? {}, chunking: { quarantined, corpusGeneration: null, tier: 'none' }, retiredOccurrences: [], guarded: true,
    renew: tx => tx.executeRaw(`UPDATE page_projection_jobs SET updated_at=now() WHERE ${JOB_OF_PAGE} AND reason='${SEGMENTED_PROJECTION_CLAIM}'`, [ref.sourceId, ref.slug]) });
  await faultPoint('segmented:projection_staged', { sourceId: ref.sourceId });
  const sealed = await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: ref.sourceId, slug: ref.slug }]);
    const current = await readProjectionPage(tx, ref);
    if (!current || current.knowledge_revision !== page.knowledge_revision || Number(current.body_generation) !== generation) return false;
    if (current.text_projection_revision !== current.knowledge_revision) await sealSegmentedPage(tx, pageId, current.timeline_lead ?? '');
    return true;
  });
  return { chunks: staged.rows, retired, sealed };
}

/**
 * The projection queue's segmented route: the queued rows of live segmented
 * pages (failed rows after their retry window, unless `retryCooldown` is
 * false; never a row another process's live claim holds), rebuilt by
 * `buildSegmentedProjection` at the queued revision. A failure marks the row
 * `rebuild_failed` like the inline route; a page whose revision moved is
 * left to the row the trigger queued for its new revision. `listed` names
 * every row this call took (`<source_incarnation>/<slug>`), for a caller that
 * tries each row once (`exclude`: `gbrain projections drain`).
 */
export async function rebuildPendingSegmentedProjections(engine: BrainEngine, limit: number,
  opts: { deadlineMs?: number; now?: () => number; notAfter?: string; reasons?: readonly string[]; retryCooldown?: boolean; exclude?: readonly string[];
    onFailure?: (failure: ProjectionRebuildFailure) => void } = {}): Promise<{ rebuilt: number; failed: number; listed: string[] }> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const params: unknown[] = [Math.max(1, limit)];
  const filters = [opts.retryCooldown === false ? `NOT ${SEGMENTED_PROJECTION_CLAIMED_SQL}` : PROJECTION_RETRY_READY_SQL];
  if (opts.notAfter !== undefined) filters.push(`j.updated_at<=$${params.push(opts.notAfter)}::text::timestamptz`);
  if (opts.reasons) filters.push(`j.reason=ANY($${params.push(opts.reasons)}::text[])`);
  if (opts.exclude?.length) filters.push(`NOT (j.source_incarnation::text || '/' || j.slug)=ANY($${params.push(opts.exclude)}::text[])`);
  const jobs = await engine.executeRaw<{ source_id: string; source_incarnation: string; slug: string; revision: string }>(`SELECT s.id AS source_id,
      j.source_incarnation::text AS source_incarnation, j.slug, j.revision::text AS revision
    FROM page_projection_jobs j ${SEGMENTED_JOB_PROBES}
    WHERE ${filters.join(' AND ')} ORDER BY j.updated_at, j.slug LIMIT $1`, params);
  let rebuilt = 0, failed = 0;
  const listed: string[] = [];
  for (const [index, job] of jobs.entries()) {
    if (opts.deadlineMs !== undefined && index > 0 && now() - startedAt >= opts.deadlineMs) break;
    listed.push(`${job.source_incarnation}/${job.slug}`);
    try {
      if (!(await buildSegmentedProjection(engine, { sourceId: job.source_id, slug: job.slug }, { expectedRevision: job.revision })).sealed) continue;
      rebuilt++;
      await engine.executeRaw('DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid', [job.source_incarnation, job.slug, job.revision]);
    } catch (error) {
      failed++;
      await engine.executeRaw(`UPDATE page_projection_jobs SET reason='rebuild_failed', updated_at=now()
        WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, [job.source_incarnation, job.slug, job.revision]);
      opts.onFailure?.({ source_id: job.source_id, slug: job.slug, reason: (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300) });
    }
  }
  return { rebuilt, failed, listed };
}
