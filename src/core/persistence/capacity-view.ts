/**
 * #6696 B1/B2: the one read of managed write capacity that doctor's ops tier,
 * the read-scope `get_brain_health` operation and `/admin/api/ops` share.
 *
 * Today it carries the counter diagnostics (`capacityDiagnostics`: used and
 * limit per scope and resource) and the last receipt compaction the consumer
 * recorded (`persistence.maintenance.last_compaction`). `forecast` is the seam
 * for the 7-day forecast (days to exhaustion per scope and resource): null
 * until a build provides it, and every consumer here treats null as "days
 * unknown", never as "plenty".
 *
 * Bounded: one indexed read of the counter rows (brain plus each principal),
 * the journal limits and one config key.
 */
import type { BrainEngine } from '../engine.ts';
import { capacityDiagnostics } from './diagnostics.ts';
import { readJournalLimits } from './limits.ts';

export type CapacityRow = ReturnType<typeof capacityDiagnostics>[number];

/** Days to exhaustion of one scope and resource at the recent admission rate (the forecast's per-row answer). */
export interface CapacityForecastRow {
  scope: string;
  resource: string;
  days_to_exhaustion: number | null;
  /** How the days were derived (for example `net_after_compaction`). */
  basis: string;
}

export interface CapacityForecast {
  per_day_7d: number | null;
  max_day_7d: number | null;
  spike: boolean;
  rows: CapacityForecastRow[];
}

/** The consumer's last receipt compaction, as recorded under `LAST_COMPACTION_KEY`. */
export interface LastCompaction {
  at: string;
  host?: string;
  compacted?: number;
  freed_bytes?: number;
}

export interface CapacityView {
  rows: CapacityRow[];
  counters_read: number;
  forecast: CapacityForecast | null;
  last_compaction: LastCompaction | null;
}

export const LAST_COMPACTION_KEY = 'persistence.maintenance.last_compaction';
/** Resources that never drain on their own (transient caps refill as requests finish). */
export const CUMULATIVE_RESOURCES: ReadonlySet<string> = new Set(['lifetime_ids', 'terminal_bytes']);

export type CounterRow = { key: string; outstanding_count: string; intent_bytes: string; lifetime_ids: string; terminal_bytes: string; recovery_bytes: string };

/** The brain and principal counter rows (the input `capacityDiagnostics` reads). */
export async function readCapacityCounters(engine: BrainEngine): Promise<CounterRow[]> {
  return engine.executeRaw<CounterRow>(`SELECT key,outstanding_count::text,intent_bytes::text,lifetime_ids::text,
    terminal_bytes::text,recovery_bytes::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%' ORDER BY key`);
}

export async function readCapacityView(engine: BrainEngine): Promise<CapacityView> {
  const counters = await readCapacityCounters(engine);
  const rows = capacityDiagnostics(counters, await readJournalLimits(engine));
  const [compaction] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [LAST_COMPACTION_KEY]);
  return { rows, counters_read: counters.length, forecast: null, last_compaction: parseLastCompaction(compaction?.value ?? null) };
}

function parseLastCompaction(raw: string | null): LastCompaction | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LastCompaction>;
    return typeof value?.at === 'string' && !Number.isNaN(Date.parse(value.at)) ? value as LastCompaction : null;
  } catch {
    return null;
  }
}

/**
 * The read-only verification of every capacity fix: doctor on the brain host, and
 * the read-scope `get_brain_health` operation where it is callable (remote agents
 * without admin scope see the band clear).
 */
export function capacityVerify(): { argv: string[]; mcp: { tool: string; arguments: Record<string, unknown> } } {
  return { argv: ['gbrain', 'doctor', '--only', 'persistence_capacity', '--json'], mcp: { tool: 'get_brain_health', arguments: {} } };
}

export type CapacityBand = 'ok' | 'low' | 'critical';
export type DaysBand = 'under_7' | '7_to_30' | '30_to_90' | '90_to_365' | 'over_365' | 'unknown';

/** Remote-safe banding: no scope identities, no exact counters. Thresholds match doctor `persistence_capacity` (80% warns). */
export function capacityBands(view: CapacityView): { capacity: CapacityBand; days: DaysBand; max_pct_band: '<80' | '80-95' | '>=95' } {
  const cumulative = view.rows.filter((r) => CUMULATIVE_RESOURCES.has(r.resource));
  const pct = cumulative.reduce((max, r) => Math.max(max, r.limit > 0 ? r.used / r.limit : r.used > 0 ? 1 : 0), 0);
  const known = (view.forecast?.rows ?? []).map((r) => r.days_to_exhaustion).filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
  const days = known.length ? Math.min(...known) : null;
  const daysBand: DaysBand = days === null ? 'unknown' : days < 7 ? 'under_7' : days < 30 ? '7_to_30' : days < 90 ? '30_to_90' : days < 365 ? '90_to_365' : 'over_365';
  const capacity: CapacityBand = pct >= 0.95 || (days !== null && days < 7) ? 'critical' : pct >= 0.8 || (days !== null && days < 30) ? 'low' : 'ok';
  return { capacity, days: daysBand, max_pct_band: pct >= 0.95 ? '>=95' : pct >= 0.8 ? '80-95' : '<80' };
}
