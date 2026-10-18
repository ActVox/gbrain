/**
 * Quote-grounding isolation for the patterns phase (GBRA-130 A-23).
 *
 * After a completed (paid) patterns child, quote grounding rewrites every
 * pattern page the child wrote and every leftover page a crashed run left
 * without \`quote_verified_at\`. One page whose write-back fails is recorded
 * here and the rest still ground; the evidence watermark is stamped as usual,
 * so the failure never buys another child for the same evidence. Run-scoped
 * errors and a systemic run (item-failure.ts \`ItemRun\`) still fail the phase
 * and record nothing.
 *
 * Holds: a leftover page refused with a content-class error on 3 consecutive
 * runs at the same \`content_hash\` and the same producer (the gbrain version,
 * which carries the verifier and the writer) is held out of the leftover
 * query. A held page is never reported as grounded: \`grounding_held\` lists it
 * with the command that retries it. Editing the page or upgrading gbrain
 * releases it on the next run; \`gbrain config unset <key>\` releases every
 * hold of the source at once. Transient failures are never held and reset the
 * count. Timeline-append failures are reported, never held: those entries are
 * this run's only, so no later run retries them.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { ItemFailure } from '../item-failure.ts';
import { VERSION } from '../../version.ts';

export const GROUNDING_HOLDS_KEY = 'dream.patterns.grounding_holds';
export const GROUNDING_HOLD_RUNS = 3;

export interface GroundingHold {
  content_hash: string | null;
  producer: string;
  code: string;
  message: string;
  attempts: number;
  held_at: string | null;
  last_failed_at: string;
}

/** One run's grounding: the holds it began with, the pages that failed and the pages that grounded. */
export interface GroundingRun {
  sourceId: string;
  holds: Record<string, GroundingHold>;
  failed: Array<ItemFailure & { content_hash: string | null; timeline: boolean }>;
  grounded: Set<string>;
}

export interface GroundingReport {
  failedSlugs: Set<string>;
  details: { grounding_failed: Array<{ slug: string; code: string; message: string; held: boolean; fix: string }>;
    grounding_held: Array<{ slug: string; code: string; content_hash: string | null; held_at: string; fix: string }> };
}

const holdsKey = (sourceId: string) => `${GROUNDING_HOLDS_KEY}.${sourceId}`;

export async function beginGroundingRun(engine: BrainEngine, sourceId: string): Promise<GroundingRun> {
  let holds: Record<string, GroundingHold> = {};
  try {
    const stored = JSON.parse((await engine.getConfig(holdsKey(sourceId))) ?? '{}') as { version?: number; items?: Record<string, GroundingHold> };
    if (stored.version === 1 && stored.items && typeof stored.items === 'object') holds = stored.items;
  } catch { /* an unreadable record holds nothing */ }
  return { sourceId, holds, failed: [], grounded: new Set() };
}

/** A leftover page held at its current content and this producer is skipped; any change releases it. */
export function groundingHeld(run: GroundingRun, slug: string, contentHash: string | null): boolean {
  const hold = run.holds[slug];
  return !!hold?.held_at && hold.content_hash === contentHash && hold.producer === VERSION;
}

/** Merges this run into the stored holds (only when it finished: a systemic or run-scoped stop never reaches here) and reports both. */
export async function finishGroundingRun(engine: BrainEngine, run: GroundingRun): Promise<GroundingReport> {
  const now = new Date().toISOString();
  const holds = { ...run.holds };
  for (const slug of run.grounded) delete holds[slug];
  for (const f of run.failed) {
    if (f.timeline) continue;
    if (f.class !== 'content') { delete holds[f.key]; continue; }
    const prior = holds[f.key];
    const attempts = prior && prior.content_hash === f.content_hash && prior.producer === VERSION && prior.code === f.code ? prior.attempts + 1 : 1;
    holds[f.key] = { content_hash: f.content_hash, producer: VERSION, code: f.code, message: f.message.slice(0, 300), attempts,
      held_at: attempts >= GROUNDING_HOLD_RUNS ? prior?.held_at ?? now : null, last_failed_at: now };
  }
  const changed = JSON.stringify(holds) !== JSON.stringify(run.holds);
  if (changed) await engine.setConfig(holdsKey(run.sourceId), JSON.stringify({ version: 1, items: holds }));
  const release = `gbrain config unset ${holdsKey(run.sourceId)} && gbrain dream --phase patterns --once --source ${run.sourceId}`;
  const retry = `gbrain dream --phase patterns --once --source ${run.sourceId}`;
  return {
    failedSlugs: new Set(run.failed.map(f => f.key)),
    details: {
      grounding_failed: run.failed.map(f => ({ slug: f.key, code: f.code, message: f.message.slice(0, 300), held: !f.timeline && !!holds[f.key]?.held_at,
        fix: f.timeline ? `gbrain get --source ${run.sourceId} -- ${f.key}` : holds[f.key]?.held_at ? release : retry })),
      grounding_held: Object.entries(holds).filter(([, h]) => h.held_at && h.producer === VERSION)
        .map(([slug, h]) => ({ slug, code: h.code, content_hash: h.content_hash, held_at: h.held_at!, fix: release })),
    },
  };
}

/** A run that failed or held a page warns, even after a clean child: a held page is not a grounded one. */
export function withGroundingStatus(result: PhaseResult, report: GroundingReport): PhaseResult {
  const failed = report.details.grounding_failed.length;
  const held = report.details.grounding_held.length;
  if (!failed && !held) return result;
  return { ...result, status: result.status === 'ok' ? 'warn' : result.status,
    summary: `${result.summary}; quote grounding: ${failed} page(s) failed, ${held} held (details.grounding_failed, details.grounding_held)` };
}
