/**
 * GBRA-156: one housekeeping turn per host for one-shot commands.
 *
 * A one-shot command (`gbrain put`, `gbrain remember`, any shared operation the CLI runs once and exits) starts a full
 * consumer to publish its own write. The consumer's housekeeping (recovery and expired-claim scans, dead-owner and topology
 * recovery, compaction and queue upkeep, the resident projection pass) is not what that write waits on, and it held the
 * process open after the reply on every command. Many brains have no resident process, so these commands are also the only
 * thing that runs it: it is rationed, not removed. After no caller in the process awaits a write, the consumer asks for the
 * host's turn; the turn is granted at most once per `GBRAIN_ONESHOT_HOUSEKEEPING_INTERVAL_MS` (default 5 minutes) across
 * this host's processes (an atomic claim on one op_checkpoints row, op `consumer-housekeeping`, fingerprint the host id),
 * and never while a resident full consumer on the host is live, because that one already runs the same scans. The scans a
 * waiting write may be blocked behind still run at once (consumer.ts `sweepAllowed`).
 */
import type { SqlEngine } from './model.ts';
import { CONSUMER_LIVE_MS, RESIDENT_CONSUMER_KINDS } from './consumer-heartbeat.ts';

export const HOUSEKEEPING_TURN_OP = 'consumer-housekeeping';
export const HOUSEKEEPING_INTERVAL_MS_DEFAULT = 300_000;

export function housekeepingIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GBRAIN_ONESHOT_HOUSEKEEPING_INTERVAL_MS;
  const value = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : HOUSEKEEPING_INTERVAL_MS_DEFAULT;
}

/** Claims the host's housekeeping turn: true when no turn was taken within `intervalMs` and no resident full consumer of the host is live. */
export async function claimHousekeepingTurn(engine: SqlEngine, hostId: string, intervalMs: number, signal?: AbortSignal): Promise<boolean> {
  const [row] = await engine.executeRaw<{ claimed: boolean }>(`WITH claim AS (
      INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
      SELECT $1::text, $2::text, '[]'::jsonb, now() WHERE NOT EXISTS (SELECT 1 FROM persistence_consumers WHERE host_id=$2::text::uuid
        AND kind=ANY($4::text[]) AND mode IN ('full','promoted') AND renewed_at > now() - ($5::integer * interval '1 millisecond'))
      ON CONFLICT (op, fingerprint) DO UPDATE SET updated_at=now()
      WHERE op_checkpoints.updated_at <= now() - ($3::bigint * interval '1 millisecond') RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM claim) AS claimed`, [HOUSEKEEPING_TURN_OP, hostId, intervalMs, [...RESIDENT_CONSUMER_KINDS], CONSUMER_LIVE_MS], { signal });
  return row?.claimed === true;
}
