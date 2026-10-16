/**
 * #6712 PR 2 (L5): the tail of a managed sync whose checkpoint committed: projection statistics and link extraction for the
 * pages the run imported. It runs after the drain lease is released and outside the drain's in-pass governor, so a slow
 * tail never holds the source or reads as a stalled pass. The checkpoint's own transaction records the obligation
 * (`recordSyncTail`), so a process that dies between the checkpoint commit and the tail leaves it for the next tail on the
 * source; the tail is bounded, and work it leaves undone stays durable (the obligation, and every unextracted page stays
 * stale for `gbrain extract --stale`). A failed or truncated tail attaches one degraded notice with its fix; the run's
 * outcome stays synced.
 */
import type { BrainEngine } from '../engine.ts';
import type { Notice } from '../agent-output.ts';
import { refreshProjectionStatistics } from '../search/projection-statistics.ts';
import { extractManagedStaleLinks, type ManagedLinkExtraction } from './links-maintenance.ts';
import { faultPoint } from './fault-points.ts';
import { currentDrainLease } from './sync-lease.ts';
import { readSyncTail, SYNC_TAIL_OP, type TailObligation } from './sync-tail-record.ts';
import type { SyncResult } from '../../commands/sync.ts';

/** The tail's link-extraction budget (it was the governed pass's `FINISH_BUDGET_MS`); a caller deadline shortens it. */
export const SYNC_TAIL_BUDGET_MS = 5 * 60_000;
/** Link extraction per tail, as before the move. */
const SYNC_TAIL_MAX_PAGES = 1000;

export interface SyncTailReport {
  /**
   * `done`: every step ran to the end; `truncated`: links stopped at the budget (the rest stay stale); `degraded`: the planner
   * statistics could not be refreshed (doctor's check owns it); `deferred`: the caller's deadline left no budget, and `failed`:
   * a step threw (both keep the obligation for the next tail).
   */
  status: 'done' | 'truncated' | 'degraded' | 'deferred' | 'failed';
  runs: number;
  statistics: 'refreshed' | 'not_needed' | 'failed';
  links?: ManagedLinkExtraction;
  notice?: Notice;
}

/**
 * Runs the source's owed tail, bounded by `budgetMs` and the caller's deadline. Never throws: a failure is the report's
 * `failed` status and its notice. The obligation is cleared (compare-and-swap) only when every step ran; a checkpoint
 * that committed meanwhile keeps its own.
 */
export async function runSyncTail(engine: BrainEngine, sourceId: string, opts: { signal?: AbortSignal; deadlineAtMs?: number; budgetMs?: number } = {}): Promise<SyncTailReport | null> {
  let owed: TailObligation[] | null;
  try { owed = await readSyncTail(engine, sourceId); } catch { return null; }
  if (!owed) return null;
  const budgetMs = Math.max(0, Math.min(opts.budgetMs ?? SYNC_TAIL_BUDGET_MS, opts.deadlineAtMs === undefined ? Infinity : opts.deadlineAtMs - Date.now()));
  const changed = owed.reduce((sum, item) => sum + (Number(item.changed) || 0), 0);
  const extract = owed.some(item => item.extract);
  let statistics: SyncTailReport['statistics'] = 'not_needed', links: ManagedLinkExtraction | undefined, failure: string | null = null, linksStarted = 0;
  try {
    await faultPoint('sync:tail_started', { sourceId });
    if (changed > 0) statistics = await refreshProjectionStatistics(engine, changed) ? 'refreshed' : 'failed';
    if (extract && budgetMs > 0) {
      const slugs = (await engine.executeRaw<{ slug: string }>(`SELECT DISTINCT e->>'slug' AS slug FROM op_checkpoints m, jsonb_array_elements(m.completed_keys) e
        WHERE m.op='managed-sync-manifest' AND m.fingerprint=ANY($1::text[]) AND e->>'action'='import' AND e->>'slug' IS NOT NULL`, [owed.map(item => item.run_id)])).map(row => row.slug);
      linksStarted = Date.now();
      links = await extractManagedStaleLinks(engine, { sourceId, maxPages: SYNC_TAIL_MAX_PAGES, timeBudgetMs: budgetMs, signal: opts.signal, mentions: false, slugs });
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const ran = failure === null && (!extract || links !== undefined);
  if (ran) await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [SYNC_TAIL_OP, sourceId, JSON.stringify(owed)]).catch(() => undefined);
  const status: SyncTailReport['status'] = failure !== null ? 'failed' : !ran ? 'deferred' : links && links.remaining > 0 && (Date.now() - linksStarted >= budgetMs || links.pages + links.skipped >= SYNC_TAIL_MAX_PAGES) ? 'truncated' : statistics === 'failed' ? 'degraded' : 'done';
  return { status, runs: owed.length, statistics, ...(links ? { links } : {}), ...(status === 'done' ? {} : { notice: tailNotice(sourceId, status, { statistics, links, failure }) }) };
}

function tailNotice(sourceId: string, status: Exclude<SyncTailReport['status'], 'done'>, d: { statistics: SyncTailReport['statistics']; links?: ManagedLinkExtraction; failure: string | null }): Notice {
  const extract = { argv: ['gbrain', 'extract', '--stale', '--source', sourceId], consent: [], actor: 'agent' as const, requires_exclusive: false,
    why: 'Derives links for the pages this sync imported that are still stale; it changes no page content.',
    verify: { argv: ['gbrain', 'extract', '--stale', '--source', sourceId, '--dry-run'] } };
  if (status === 'truncated') {
    return { code: 'sync_tail_degraded', kind: 'degraded', fix: extract,
      why: `The sync of source ${sourceId} is synced, but link extraction stopped at its budget with ${d.links!.remaining} page(s) still stale; their links and backlinks are missing until they are extracted.` };
  }
  if (status === 'degraded') {
    return { code: 'sync_tail_degraded', kind: 'degraded',
      fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Names the planner-statistics check and the database-owner step that fixes it; changes nothing.' },
      why: `The sync of source ${sourceId} is synced, but the search planner statistics could not be refreshed (database-owner maintenance is required), so searches may plan slowly.` };
  }
  const what = status === 'deferred' ? 'link extraction did not start (the run\'s deadline had passed)' : `the post-sync step failed (${d.failure ?? 'unknown error'})`;
  return { code: 'sync_tail_degraded', kind: 'degraded', fix: extract,
    why: `The sync of source ${sourceId} is synced, but ${what}; the step stays scheduled, the next sync of this source runs it again, and the fix runs the links now.` };
}

/**
 * After the drain lease is released: runs the source's owed tail and folds it into the result (`tail`, and `links` when
 * links ran). A dry run, a run that never held the lease (a follower) and a call still inside a lease (its holder runs
 * the tail) run none.
 */
export async function withSyncTail(engine: BrainEngine, sourceId: string, result: SyncResult, opts: { signal?: AbortSignal; deadlineAtMs?: number } = {}): Promise<SyncResult> {
  if (result.status === 'dry_run' || result.leaseHeld || currentDrainLease(sourceId)) return result;
  const tail = await runSyncTail(engine, sourceId, opts);
  if (!tail) return result;
  const { links, ...report } = tail;
  return { ...result, tail: report, ...(links ? { links } : {}) };
}
