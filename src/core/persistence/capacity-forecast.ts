/**
 * #6696 (A3): days until a cumulative managed-write cap refuses admission,
 * from a full 7-day aggregate of `persistence_requests` (and lifecycle
 * receipts) on the `sequence` index, per scope (`brain`, each principal) and
 * resource (`lifetime_ids`, `terminal_bytes`).
 *
 * Receipt bytes are reported gross (what the window's receipts reserve now)
 * and net (what they keep once compacted). The counter grows by the gross
 * rate until the oldest uncompacted receipt passes the retention window, and
 * by the net rate after that, so `days_to_exhaustion` for terminal bytes uses
 * net and `basis` says so. Rates are the larger of the window mean and the
 * last 24 hours.
 */
import type { SqlEngine } from './model.ts';
import { DEFAULT_JOURNAL_LIMITS, type JournalLimits } from './model.ts';
import { DEFAULT_RECEIPT_RETENTION_DAYS, journalLimitKey, readJournalLimits, readReceiptRetentionDays, recommendedLimit } from './limits.ts';
import { COMPACTED_HEADROOM_BYTES } from './receipt-bytes.ts';

export const CAPACITY_WARN_DAYS_KEY = 'persistence.capacity.warn_days';
export const CAPACITY_FAIL_DAYS_KEY = 'persistence.capacity.fail_days';
export const DEFAULT_CAPACITY_WARN_DAYS = 30;
export const DEFAULT_CAPACITY_FAIL_DAYS = 7;
export const CAPACITY_WARN_PCT = 80;
export const CAPACITY_FAIL_PCT = 95;
const WINDOW_DAYS = 7;
const HORIZON_DAYS = 3650;
const SPIKE_FACTOR = 3;

export type { CapacityResource } from './limits.ts';
import type { CapacityResource } from './limits.ts';
export interface CapacityForecastRow {
  scope: string; resource: CapacityResource; used: number; limit: number; pct: number; config_key: string;
  /** Window days actually observed (under 7 when the history is younger). */
  window_days: number;
  /** Ids admitted, or gross receipt bytes reserved, per day over the window. */
  per_day_7d: number;
  /** Terminal bytes only: the same receipts at their compacted size. */
  net_per_day_7d?: number;
  max_day_7d: number;
  /** A single day over 3x the window mean (bulk sync, reclone). */
  spike_day: string | null;
  days_to_exhaustion: number | null;
  exhaustion_date: string | null;
  /** Terminal bytes only: slack a true-up or compaction would free now. */
  reclaimable_bytes?: number;
  basis: string;
  /** A cap that covers one more year at this rate (never below double the current cap). */
  recommended_limit: number;
  status: 'ok' | 'warn' | 'fail';
}
export interface CapacityForecast {
  rows: CapacityForecastRow[];
  thresholds: { warn_days: number; fail_days: number; warn_pct: number; fail_pct: number };
  retention_days: number;
  table_bytes: number | null;
  window_days: number;
}

interface Day { scope: string; day: string; ids: number; gross: number; net: number; recent_ids: number; recent_gross: number; recent_net: number }

async function readDays(engine: SqlEngine, key: string, fallback: number): Promise<number> {
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [key]);
  const value = row ? Number(row.value) : fallback;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** First `sequence` inside the window: a binary search over the unique `sequence` index, never a scan of `created_at`. */
async function windowStart(engine: SqlEngine, days: number): Promise<string | null> {
  const [bounds] = await engine.executeRaw<{ lo: string | null; hi: string | null }>('SELECT min(sequence)::text AS lo,max(sequence)::text AS hi FROM persistence_requests');
  if (!bounds?.lo || !bounds.hi) return null;
  let lo = BigInt(bounds.lo), hi = BigInt(bounds.hi) + 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const [next] = await engine.executeRaw<{ sequence: string; inside: boolean }>(`SELECT sequence::text,created_at>now()-($2::double precision*interval '1 day') AS inside
      FROM persistence_requests WHERE sequence>=$1::bigint ORDER BY sequence LIMIT 1`, [mid.toString(), days]);
    if (!next || next.inside) hi = mid; else lo = BigInt(next.sequence) + 1n;
  }
  return lo.toString();
}

const NET_SQL = (r: string, e: string) => `LEAST(${r}.terminal_reservation,octet_length(${r}.authority::text)+COALESCE(octet_length(${r}.outcome::text),0)
  +COALESCE(octet_length(${r}.error_detail::text),0)+COALESCE(octet_length(${r}.client_request_id),0)+COALESCE(${e}.bytes,0)+${COMPACTED_HEADROOM_BYTES})`;

/** The configured days-to-exhaustion thresholds every capacity finding uses. */
export async function readCapacityThresholds(engine: SqlEngine): Promise<{ warnDays: number; failDays: number }> {
  const [warnDays, failDays] = await Promise.all([readDays(engine, CAPACITY_WARN_DAYS_KEY, DEFAULT_CAPACITY_WARN_DAYS), readDays(engine, CAPACITY_FAIL_DAYS_KEY, DEFAULT_CAPACITY_FAIL_DAYS)]);
  return { warnDays, failDays };
}

export async function readCapacityForecast(engine: SqlEngine & { kind?: string }, opts: { limits?: JournalLimits } = {}): Promise<CapacityForecast> {
  const limits = opts.limits ?? await readJournalLimits(engine);
  const [{ warnDays, failDays }, retention] = await Promise.all([readCapacityThresholds(engine),
    readReceiptRetentionDays(engine).catch(() => DEFAULT_RECEIPT_RETENTION_DAYS)]);
  const counters = await engine.executeRaw<{ key: string; lifetime_ids: string; terminal_bytes: string }>(
    "SELECT key,lifetime_ids::text,terminal_bytes::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%' ORDER BY key");
  const start = await windowStart(engine, WINDOW_DAYS);
  const days: Day[] = [];
  if (start !== null) {
    days.push(...(await engine.executeRaw<Record<string, string>>(`WITH w AS (SELECT * FROM persistence_requests
        WHERE sequence>=$1::bigint AND created_at>now()-($2::double precision*interval '1 day')),
      e AS (SELECT request_id,SUM(octet_length(data::text)+octet_length(kind)+1024) AS bytes FROM persistence_effects WHERE request_id IN (SELECT id FROM w) GROUP BY request_id)
      SELECT 'principal:'||w.principal_kind||':'||w.principal_id AS scope,to_char(w.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
        count(*)::text AS ids,COALESCE(SUM(w.terminal_reservation),0)::text AS gross,COALESCE(SUM(${NET_SQL('w', 'e')}),0)::text AS net,
        count(*) FILTER (WHERE w.created_at>now()-interval '1 day')::text AS recent_ids,
        COALESCE(SUM(w.terminal_reservation) FILTER (WHERE w.created_at>now()-interval '1 day'),0)::text AS recent_gross,
        COALESCE(SUM(${NET_SQL('w', 'e')}) FILTER (WHERE w.created_at>now()-interval '1 day'),0)::text AS recent_net
      FROM w LEFT JOIN e ON e.request_id=w.id GROUP BY 1,2`, [start, WINDOW_DAYS])).map(toDay));
  }
  days.push(...(await engine.executeRaw<Record<string, string>>(`SELECT 'principal:local_cli:'||principal_id::text AS scope,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
      count(*)::text AS ids,COALESCE(SUM(terminal_bytes),0)::text AS gross,COALESCE(SUM(terminal_bytes),0)::text AS net,
      count(*) FILTER (WHERE created_at>now()-interval '1 day')::text AS recent_ids,
      COALESCE(SUM(terminal_bytes) FILTER (WHERE created_at>now()-interval '1 day'),0)::text AS recent_gross,
      COALESCE(SUM(terminal_bytes) FILTER (WHERE created_at>now()-interval '1 day'),0)::text AS recent_net
    FROM persistence_topology_changes WHERE created_at>now()-($1::double precision*interval '1 day') GROUP BY 1,2`, [WINDOW_DAYS])).map(toDay));
  const [history] = await engine.executeRaw<{ age_days: number | null; compaction_age_days: number | null }>(`SELECT
      (SELECT EXTRACT(EPOCH FROM now()-created_at)/86400 FROM persistence_requests ORDER BY sequence LIMIT 1)::float8 AS age_days,
      (SELECT EXTRACT(EPOCH FROM now()-min(completed_at))/86400 FROM persistence_requests
        WHERE recovery IS NULL AND NOT compacted AND state IN ('committed','conflict','failed','cancelled'))::float8 AS compaction_age_days`);
  const windowDays = Math.min(WINDOW_DAYS, Math.max(1, Number(history?.age_days ?? WINDOW_DAYS)));
  // Days until the oldest uncompacted receipt is compactable: until then every receipt keeps its gross reservation.
  const untilCompaction = Math.max(0, retention - Number(history?.compaction_age_days ?? 0));
  const reclaim = await engine.executeRaw<{ scope: string; bytes: string }>(`WITH e AS (SELECT request_id,SUM(octet_length(data::text)+octet_length(kind)+1024) AS bytes,
      bool_or(state<>'committed') AS unfinished FROM persistence_effects GROUP BY request_id)
    SELECT 'principal:'||r.principal_kind||':'||r.principal_id AS scope,COALESCE(SUM(r.terminal_reservation-${NET_SQL('r', 'e')}),0)::text AS bytes
    FROM persistence_requests r LEFT JOIN e ON e.request_id=r.id
    WHERE r.state IN ('committed','conflict','failed','cancelled') AND r.recovery IS NULL AND NOT COALESCE(e.unfinished,false) GROUP BY 1`);
  const tableBytes = await engine.executeRaw<{ bytes: string }>("SELECT pg_total_relation_size('persistence_requests')::text AS bytes").then(r => Number(r[0]?.bytes), () => null);
  const now = Date.now();
  const rows: CapacityForecastRow[] = [];
  for (const counter of counters) {
    const scopeDays = counter.key === 'brain' ? days : days.filter(day => day.scope === counter.key);
    const byDay = new Map<string, Day>();
    for (const day of scopeDays) {
      const sum = byDay.get(day.day) ?? { ...day, ids: 0, gross: 0, net: 0, recent_ids: 0, recent_gross: 0, recent_net: 0 };
      for (const field of ['ids', 'gross', 'net', 'recent_ids', 'recent_gross', 'recent_net'] as const) sum[field] += day[field];
      byDay.set(day.day, sum);
    }
    const total = (field: keyof Omit<Day, 'scope' | 'day'>) => [...byDay.values()].reduce((n, day) => n + day[field], 0);
    const prefix = counter.key === 'brain' ? 'brain' : 'principal';
    const reclaimable = counter.key === 'brain' ? reclaim.reduce((n, row) => n + Number(row.bytes), 0) : Number(reclaim.find(row => row.scope === counter.key)?.bytes ?? 0);
    for (const resource of ['lifetime_ids', 'terminal_bytes'] as const) {
      const setting = `${prefix}${resource === 'lifetime_ids' ? 'LifetimeIds' : 'TerminalBytes'}` as keyof JournalLimits;
      const limit = limits[setting] ?? DEFAULT_JOURNAL_LIMITS[setting];
      const used = Number(counter[resource]);
      const ids = resource === 'lifetime_ids';
      const perDay = Math.max(total(ids ? 'ids' : 'gross') / windowDays, total(ids ? 'recent_ids' : 'recent_gross'));
      const netPerDay = ids ? perDay : Math.max(total('net') / windowDays, total('recent_net'));
      const maxDay = Math.max(0, ...[...byDay.values()].map(day => ids ? day.ids : day.gross));
      const mean = total(ids ? 'ids' : 'gross') / windowDays;
      const spike = [...byDay.values()].find(day => mean > 0 && (ids ? day.ids : day.gross) > SPIKE_FACTOR * mean)?.day ?? null;
      const remaining = Math.max(0, limit - used);
      let daysLeft: number | null;
      let basis = `aggregate_${Number(windowDays.toFixed(2))}d${windowDays < WINDOW_DAYS ? '_short_history' : ''}`;
      if (ids) daysLeft = perDay > 0 ? remaining / perDay : null;
      else if (perDay <= 0) daysLeft = null;
      else if (remaining <= perDay * untilCompaction) { daysLeft = remaining / perDay; basis += ':gross_before_compaction'; }
      else { daysLeft = netPerDay > 0 ? untilCompaction + (remaining - perDay * untilCompaction) / netPerDay : null; basis += untilCompaction > 0 ? ':gross_then_net' : ':net_after_compaction'; }
      if (daysLeft !== null && daysLeft > HORIZON_DAYS) daysLeft = null;
      const pct = limit > 0 ? Math.round(used / limit * 1000) / 10 : used > 0 ? 100 : 0;
      const status = pct >= CAPACITY_FAIL_PCT || daysLeft !== null && daysLeft < failDays ? 'fail'
        : pct >= CAPACITY_WARN_PCT || daysLeft !== null && daysLeft < warnDays ? 'warn' : 'ok';
      rows.push({ scope: counter.key, resource, used, limit, pct, config_key: journalLimitKey(setting), window_days: Number(windowDays.toFixed(2)),
        per_day_7d: Math.round(perDay), ...(ids ? {} : { net_per_day_7d: Math.round(netPerDay), reclaimable_bytes: reclaimable }),
        max_day_7d: maxDay, spike_day: spike,
        days_to_exhaustion: daysLeft === null ? null : Math.floor(daysLeft),
        exhaustion_date: daysLeft === null ? null : new Date(now + daysLeft * 86_400_000).toISOString().slice(0, 10),
        basis, recommended_limit: recommendedLimit(resource, used, limit, { perDay, netPerDay }, retention), status });
    }
  }
  return { rows, thresholds: { warn_days: warnDays, fail_days: failDays, warn_pct: CAPACITY_WARN_PCT, fail_pct: CAPACITY_FAIL_PCT },
    retention_days: retention, table_bytes: Number.isFinite(tableBytes) ? tableBytes : null, window_days: Number(windowDays.toFixed(2)) };
}

function toDay(row: Record<string, string>): Day {
  return { scope: row.scope!, day: row.day!, ids: Number(row.ids), gross: Number(row.gross), net: Number(row.net),
    recent_ids: Number(row.recent_ids), recent_gross: Number(row.recent_gross), recent_net: Number(row.recent_net) };
}
