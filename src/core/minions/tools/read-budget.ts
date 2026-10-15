/**
 * #6297: a per-job byte budget on a subagent's `get_page` results. Each turn
 * of a CLI-backed model replays the whole transcript, and a dream patterns
 * child that read every existing pattern page in full filled half the model
 * window. Bytes already returned are counted from the job's own
 * tool-execution ledger (so a crash replay keeps its spent budget); a read
 * that would pass the budget comes back as a short summary instead.
 */
import type { BrainEngine } from '../../engine.ts';

/** Characters of body text a summary keeps, at most (less when the budget has less left). */
export const READ_BUDGET_EXCERPT_CHARS = 400;

/** Bytes of `get_page` output this job has already been given. */
async function spentReadBytes(engine: BrainEngine, jobId: number): Promise<number> {
  const [row] = await engine.executeRaw<{ used: number | string | null }>(
    `SELECT COALESCE(sum(octet_length(output::text)), 0) AS used FROM subagent_tool_executions
      WHERE job_id = $1 AND tool_name = 'brain_get_page' AND status = 'complete'`, [jobId]);
  return Number(row?.used ?? 0);
}

/** The read as returned when it fits the budget, else a summary naming the page, the budget and what to do next. */
export async function budgetedPageRead(engine: BrainEngine, jobId: number, budgetBytes: number, slug: unknown, output: unknown): Promise<unknown> {
  const used = await spentReadBytes(engine, jobId);
  const pageBytes = Buffer.byteLength(JSON.stringify(output) ?? '', 'utf8');
  if (used + pageBytes <= budgetBytes) return output;
  const page = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>;
  const body = typeof page.compiled_truth === 'string' ? page.compiled_truth : typeof page.content === 'string' ? page.content : '';
  const room = Math.max(0, Math.min(READ_BUDGET_EXCERPT_CHARS, budgetBytes - used));
  return {
    slug: typeof page.slug === 'string' ? page.slug : slug,
    ...(typeof page.title === 'string' ? { title: page.title } : {}),
    ...(typeof page.type === 'string' ? { type: page.type } : {}),
    truncated: true,
    code: 'read_budget_exhausted',
    read_budget: { limit_bytes: budgetBytes, used_bytes: used, page_bytes: pageBytes },
    ...(room > 0 && body ? { excerpt: body.slice(0, room) } : {}),
    note: 'This job has used its get_page read budget, so the page is summarized. Work from the pages already read; writes still work. To update this page, append with add_timeline_entry instead of rewriting it.',
  };
}
