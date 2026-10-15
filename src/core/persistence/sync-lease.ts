/**
 * #6712 PR 1: the drain lease. One managed drainer per source at a time, whatever started it: the CLI (single
 * source and `--all`), a serve-delegated run, a sync job, the cycle phase, `sync_brain`, a staged catch-up, an owner
 * RPC slice or a refresh. The lease is the existing per-source sync lock (`gbrain_cycle_locks` row
 * `gbrain-sync:<source>`, the row `--break-lock` inspects and breaks), taken by `withRefreshingLock`; its
 * `acquisition_token` is the fencing token.
 *
 * - **Renewal.** TTL `DRAIN_LEASE_TTL_MINUTES`, renewed every `DRAIN_LEASE_REFRESH_MS` by `withRefreshingLock`; a
 *   renewal that matches no row, or the TTL passing unconfirmed (an event loop blocked past it, a machine asleep),
 *   aborts the pass's signal with `LockStolenError`.
 * - **Takeover.** `tryAcquireDbLock`'s rules, the same as `--break-lock`'s safe path: a TTL that expired with no
 *   heartbeat inside the steal grace, or a same-host holder whose pid is provably dead and whose lease is older than
 *   `HOLDER_TAKEOVER_GRACE_MS`.
 * - **Fencing.** `assertDrainLease` reads the lock row with this pass's token `FOR SHARE` inside every transaction
 *   that admits sync work or swaps the cursor, so a pass that lost the lease admits nothing and advances no
 *   checkpoint: the row is gone or carries another token, and a takeover waits for the share lock.
 * - **Cancellation.** The caller's signal aborts the pass; the lease is released in `withRefreshingLock`'s finally.
 * - **Reentrancy.** A pass inside a lease (the drain's passes, staged stages, a company catch-up) runs under it.
 *
 * A caller that may follow (`gbrain sync`, a CLI run delegated to a serve) waits for a live holder within its own
 * budget, counting the holder's cursor movement as this process's forward progress, and takes the lease when the
 * holder releases it. Out of budget, or when the lease moved away mid-pass, the run returns `resumable` with
 * `sync_drain_lease_held`; every other caller gets `SyncLockBusyError` (jobs and the cycle skip on it).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import type { SyncResult } from '../../commands/sync.ts';
import type { Action } from '../agent-output.ts';
import { inspectLock, LockStolenError, LockUnavailableError, syncLockId, withRefreshingLock } from '../db-lock.ts';
import { currentRunDeadline, lastForwardProgressAt, noteForwardProgress } from '../forward-progress.ts';
import { faultPoint } from './fault-points.ts';

export const DRAIN_LEASE_TTL_MINUTES = 2;
export const DRAIN_LEASE_REFRESH_MS = 20_000;
/** How long a follower waits between looks at the holder, and the retry delay `sync_drain_lease_held` prints. */
export const FOLLOW_POLL_MS = 2_000;
export const LEASE_RETRY_AFTER_MS = 60_000;
/** A follower stops this long before its watchdog would (or half its window, when the window is shorter). */
const FOLLOW_MARGIN_MS = 30_000;
const LEASE_OP = 'managed-sync-lease';
export const SYNC_DRAIN_LEASE_HELD = 'sync_drain_lease_held';

export type DrainHolderKind = 'cli' | 'serve' | 'job' | 'cycle' | 'mcp' | 'owner_slice' | 'refresh';
export interface DrainHolderRef { kind: DrainHolderKind; id?: string | null }
export interface DrainHolder { kind: DrainHolderKind | 'unknown'; id: string | null; host: string | null; pid: number | null; started_at: string | null; last_heartbeat_at: string | null }
export interface DrainLeaseHeld { code: typeof SYNC_DRAIN_LEASE_HELD; holder: DrainHolder | null; retry_after_ms: number; lost?: true; fix: Action }
interface DrainLease { lockId: string; sourceId: string; token: string }

const leases = new AsyncLocalStorage<ReadonlyMap<string, DrainLease>>();

export function currentDrainLease(sourceId: string): DrainLease | null {
  return leases.getStore()?.get(syncLockId(sourceId)) ?? null;
}

/**
 * The fence: inside a transaction that admits work or swaps the cursor, the lock row must still carry this pass's
 * token. Throws `LockStolenError` when it does not (the pass ends `resumable` with `sync_drain_lease_held`). A caller
 * outside any lease (none in production: `performManagedSync` takes one) is not fenced.
 */
export async function assertDrainLease(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<void> {
  const lease = currentDrainLease(sourceId);
  if (!lease) return;
  const rows = await tx.executeRaw('SELECT 1 FROM gbrain_cycle_locks WHERE id=$1 AND acquisition_token=$2::uuid FOR SHARE', [lease.lockId, lease.token]);
  if (!rows.length) throw new LockStolenError(lease.lockId, `the drain lease of source ${sourceId} is no longer held by this pass`);
}

const iso = (value: Date | null | undefined) => value ? value.toISOString() : null;

/** The live holder of a source's drain lease (kind and id from the row this module writes beside the lock), or null. */
export async function readDrainHolder(engine: BrainEngine, sourceId: string): Promise<DrainHolder | null> {
  const snap = await inspectLock(engine, syncLockId(sourceId));
  if (!snap) return null;
  const [row] = await engine.executeRaw<{ meta: { token?: string; kind?: DrainHolderKind; id?: string | null } | string | null }>(
    'SELECT completed_keys->0 AS meta FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [LEASE_OP, sourceId]).catch(() => []);
  const raw = typeof row?.meta === 'string' ? JSON.parse(row.meta) : row?.meta;
  const meta = raw?.token === snap.acquisition_token ? raw : null;
  return { kind: meta?.kind ?? 'unknown', id: meta?.id ?? null, host: snap.holder_host, pid: snap.holder_pid,
    started_at: iso(snap.acquired_at), last_heartbeat_at: iso(snap.last_refreshed_at) };
}

/** What a remote caller may see of a holder: its kind and times, never its host, pid or job id. */
const redacted = (holder: DrainHolder | null): DrainHolder | null => holder && { ...holder, id: null, host: null, pid: null };

/** The `resumable` result of a run that did not get (or lost) the lease. Nothing was admitted by it; the cursor stands. */
export function leaseHeldResult(sourceId: string, holder: DrainHolder | null, opts: { lost?: boolean; remote?: boolean; resumeArgv?: string[] } = {}): SyncResult {
  const shown = opts.remote ? redacted(holder) : holder;
  const who = shown ? `a ${shown.kind} drainer${shown.pid ? ` (pid ${shown.pid}${shown.host ? ` on ${shown.host}` : ''})` : ''}` : 'another drainer';
  const argv = opts.resumeArgv ?? ['gbrain', 'sync', '--no-pull', '--source', sourceId];
  const why = `${opts.lost ? `This run lost the drain lease of source ${sourceId} to ${who}` : `Source ${sourceId} is being drained by ${who}`}${shown?.last_heartbeat_at ? `, last heartbeat ${shown.last_heartbeat_at}` : ''}; `
    + `one drainer runs per source and it resumes the same cursor, so nothing is lost. Rerun after ${Math.round(LEASE_RETRY_AFTER_MS / 1000)}s: it follows the holder and takes the lease when the holder finishes.`;
  const fix: Action = { argv, consent: [], actor: 'provider', requires_exclusive: false, why,
    verify: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] } };
  return { status: 'partial', reason: 'drain_lease_held', fromCommit: null, toCommit: '', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [],
    filesImported: 0, bankedFiles: 0,
    leaseHeld: { code: SYNC_DRAIN_LEASE_HELD, holder: shown, retry_after_ms: LEASE_RETRY_AFTER_MS, ...(opts.lost ? { lost: true as const } : {}), fix },
    drain: { outcome: 'resumable', stop_reason: 'drain_lease_held', passes: 0, processed: 0, written: 0, waived: 0, remaining: null, rate_pages_per_min: null, eta_seconds: null,
      retry_after_ms: LEASE_RETRY_AFTER_MS } };
}

/**
 * When a follower stops: the earliest of the caller's own deadline (`deadlineAtMs`, a job's) and the process watchdog
 * (`--hard-deadline` or the non-TTY window, which extends while progress keeps arriving), less a margin, so the
 * follower reports before the watchdog fires. `--timeout` arrives as the caller's signal.
 */
export function followStopAt(startedAt: number, deadlineAtMs?: number): number {
  let at = deadlineAtMs ?? Infinity;
  const run = currentRunDeadline();
  if (run) at = Math.min(at, run.progressWindowMs ? Math.max(run.atMs, lastForwardProgressAt() + run.progressWindowMs) : run.atMs);
  if (!Number.isFinite(at)) return at;
  return at - Math.min(FOLLOW_MARGIN_MS, Math.max(0, (at - startedAt) / 2));
}

/** A fingerprint of the source's cursor movement: a change between two looks is the holder's progress. */
async function holderProgress(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ at: string | null; n: string | number | null }>(`SELECT max(updated_at)::text AS at, count(*) AS n FROM op_checkpoints
    WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1`, [sourceId]).catch(() => []);
  return row ? `${row.at}|${row.n}` : null;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface DrainLeaseOptions {
  holder: DrainHolderRef;
  /** Follow a live holder within this budget; without it a busy lease throws `LockUnavailableError`. */
  follow?: { signal?: AbortSignal; deadlineAtMs?: number };
  remote?: boolean;
  resumeArgv?: string[];
  /** Called once, when this run starts following a live holder. */
  announce?: (holder: DrainHolder | null) => void;
}

/**
 * Runs `work` under the source's drain lease (`work`'s signal aborts when the lease is lost). Reentrant. A busy
 * lease throws `LockUnavailableError` unless `follow` is set; a lost lease, and a follow budget that ran out, return
 * `leaseHeldResult`.
 */
export async function withDrainLease(engine: BrainEngine, sourceId: string, opts: DrainLeaseOptions,
  work: (signal: AbortSignal | undefined) => Promise<SyncResult>): Promise<SyncResult> {
  const lockId = syncLockId(sourceId);
  if (leases.getStore()?.has(lockId)) return work(undefined);
  const startedAt = Date.now();
  let progress: string | null | undefined;
  for (;;) {
    try {
      return await withRefreshingLock(engine, lockId, async (signal, handle) => {
        const lease: DrainLease = { lockId, sourceId, token: handle.acquisitionToken };
        await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
          ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
          [LEASE_OP, sourceId, JSON.stringify([{ token: lease.token, kind: opts.holder.kind, id: opts.holder.id ?? null, started_at: new Date().toISOString() }])]);
        await faultPoint('sync:lease_acquired', { sourceId });
        const store = new Map(leases.getStore() ?? []);
        store.set(lockId, lease);
        return leases.run(store, () => work(signal));
      }, { ttlMinutes: DRAIN_LEASE_TTL_MINUTES, refreshIntervalMs: DRAIN_LEASE_REFRESH_MS });
    } catch (error) {
      if (error instanceof LockStolenError && error.lockId === lockId) {
        return leaseHeldResult(sourceId, await readDrainHolder(engine, sourceId).catch(() => null), { lost: true, remote: opts.remote, resumeArgv: opts.resumeArgv });
      }
      if (!(error instanceof LockUnavailableError) || error.lockId !== lockId || !opts.follow) throw error;
    }
    const follow = opts.follow;
    if (progress === undefined) opts.announce?.(await readDrainHolder(engine, sourceId).catch(() => null));
    const stopAt = followStopAt(startedAt, follow.deadlineAtMs);
    if (follow.signal?.aborted || Date.now() >= stopAt) {
      return leaseHeldResult(sourceId, await readDrainHolder(engine, sourceId).catch(() => null), { remote: opts.remote, resumeArgv: opts.resumeArgv });
    }
    const seen = await holderProgress(engine, sourceId);
    if (progress !== undefined && seen !== progress) noteForwardProgress();
    progress = seen;
    await pause(Math.min(FOLLOW_POLL_MS, stopAt - Date.now()), follow.signal);
  }
}
