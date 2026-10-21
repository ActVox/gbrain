/**
 * #7188: what a handler's returned result says about its job, read by the worker before it records the job's end.
 *
 * `failed`: the result reports a failure, as a top-level `status` of `failed` or `blocked_by_failures` (also on a nested
 * cycle `report`) or a phase of that report with status `fail` (the first such phase names the reason, with its code).
 * `partial`: unfinished work and no failure (`partial: true` or `status: 'partial'`: phases deferred to the next pass, a
 * drain that stopped at its deadline with a follow-up queued, a source another drainer holds). `clean`: everything else,
 * a deliberate skip included.
 *
 * The worker ends a `failed` result as a terminal `failed` job whose error names the reason, keeping the result;
 * a `partial` one completes with `job_outcome: 'partial'` on its result, since the queue has no partial status and
 * deferred work that resumes on its own is not a failure.
 */
export interface JobOutcome { outcome: 'clean' | 'partial' | 'failed'; reason?: string }

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const FAILED_STATUSES = new Set(['failed', 'blocked_by_failures']);

export function jobResultOutcome(result: unknown): JobOutcome {
  const top = rec(result);
  if (!top || top.skipped === true) return { outcome: 'clean' };
  const report = rec(top.report) ?? top;
  const phases = Array.isArray(report.phases) ? report.phases.map(rec).filter((p): p is Rec => p !== null) : [];
  const failedPhase = phases.find(p => p.status === 'fail');
  if (failedPhase) {
    const error = rec(failedPhase.error);
    const code = failedPhase.code ?? error?.code;
    const detail = error?.message ?? failedPhase.summary;
    return { outcome: 'failed', reason: `phase ${String(failedPhase.phase)} failed${code ? ` (${String(code)})` : ''}${detail ? `: ${String(detail)}` : ''}` };
  }
  const status = [top.status, report.status].find(s => typeof s === 'string' && FAILED_STATUSES.has(s));
  if (status) return { outcome: 'failed', reason: `result status ${String(status)}${typeof report.reason === 'string' ? ` (${report.reason})` : ''}` };
  if (top.partial === true || top.status === 'partial' || report.status === 'partial') return { outcome: 'partial' };
  return { outcome: 'clean' };
}
