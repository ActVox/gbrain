/**
 * spec/tla/drain-lease models the drain lease with the code's timing. This test keeps the model's configs and the code in
 * step: a changed lease constant fails here, naming the constant and the config to revisit, before the model silently
 * checks a protocol the code no longer runs. Read spec/tla/README.md ("Timing") before changing either side.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRAIN_LEASE_REFRESH_MS, DRAIN_LEASE_TTL_MINUTES, FENCED_SLICE_MS } from '../src/core/persistence/sync-lease.ts';
import { HOLDER_TAKEOVER_GRACE_MS, resolveStealGraceSeconds } from '../src/core/db-lock.ts';
import { withEnv } from './helpers/with-env.ts';

const ROOT = join(import.meta.dir, '..');
const SPEC = join(ROOT, 'spec/tla/drain-lease');
const CONFIGS = ['DrainLease.cfg', 'DrainLeaseSafety.cfg'];

function constants(cfg: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(SPEC, cfg), 'utf8').split('\n')) {
    const m = line.match(/^\s+(\w+)\s*=\s*(\S+)\s*$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** withRefreshingLock's renewal deadline: min(heartbeatTimeoutMs ?? default, ttl / 3). The default is read from the source. */
function renewalTimeoutMs(ttlMs: number): number {
  const source = readFileSync(join(ROOT, 'src/core/db-lock.ts'), 'utf8');
  const m = source.match(/const heartbeatTimeoutMs = Math\.min\(opts\.heartbeatTimeoutMs \?\? ([\d_]+), ttlMs \/ 3\);/);
  expect(m, 'withRefreshingLock no longer computes its renewal timeout as min(opts.heartbeatTimeoutMs ?? <default>, ttlMs / 3); update this test and RenewTimeoutMs in spec/tla/drain-lease/*.cfg to the new rule').not.toBeNull();
  return Math.min(Number(m![1]!.replace(/_/g, '')), ttlMs / 3);
}

const TTL_MS = DRAIN_LEASE_TTL_MINUTES * 60_000;
const code = () => withEnv({ GBRAIN_LOCK_STEAL_GRACE_SECONDS: undefined }, () => ({
  TtlMs: TTL_MS,
  RefreshMs: DRAIN_LEASE_REFRESH_MS,
  RenewTimeoutMs: renewalTimeoutMs(TTL_MS),
  StealGraceMs: resolveStealGraceSeconds(DRAIN_LEASE_TTL_MINUTES) * 1000,
  TakeoverGraceMs: HOLDER_TAKEOVER_GRACE_MS,
}));
const SOURCES: Record<string, string> = {
  TtlMs: 'DRAIN_LEASE_TTL_MINUTES (src/core/persistence/sync-lease.ts)',
  RefreshMs: 'DRAIN_LEASE_REFRESH_MS (src/core/persistence/sync-lease.ts)',
  RenewTimeoutMs: 'withRefreshingLock heartbeatTimeoutMs (src/core/db-lock.ts)',
  StealGraceMs: 'resolveStealGraceSeconds(DRAIN_LEASE_TTL_MINUTES) (src/core/db-lock.ts)',
  TakeoverGraceMs: 'HOLDER_TAKEOVER_GRACE_MS (src/core/db-lock.ts)',
};

describe('spec/tla/drain-lease configs match the code', () => {
  for (const cfg of CONFIGS) {
    test(`${cfg}: the lease timing is the code's`, async () => {
      const want = await code();
      const have = constants(cfg);
      for (const [name, value] of Object.entries(want)) {
        expect(Number(have[name]), `${name} in spec/tla/drain-lease/${cfg} is ${have[name]}, but ${SOURCES[name]} gives ${value} ms. Set it to ${value}, run bun run test:tla, and read any new counterexample before accepting it.`).toBe(value);
      }
    });
  }

  test('DrainLease.cfg assumes a fenced-transaction bound the code keeps under the renewal timeout', async () => {
    const { RenewTimeoutMs, RefreshMs, TtlMs } = await code();
    const maxTx = Number(constants('DrainLease.cfg').MaxTxMs);
    expect(FENCED_SLICE_MS, `FENCED_SLICE_MS (${FENCED_SLICE_MS}) must stay below MaxTxMs (${maxTx}) in DrainLease.cfg: a slice plus the item that crosses it is what the model assumes`).toBeLessThan(maxTx);
    expect(maxTx, `MaxTxMs (${maxTx}) must stay below the renewal timeout (${RenewTimeoutMs}): TLC finds a live holder losing its lease once fenced transactions outlive it (mutant fenced-transaction-outlives-renewal-timeout)`).toBeLessThan(RenewTimeoutMs);
    expect(RefreshMs + RenewTimeoutMs, 'a renewal and its timeout must fit inside the TTL').toBeLessThan(TtlMs);
  });

  test('DrainLeaseSafety.cfg keeps every adverse assumption on', () => {
    const c = constants('DrainLeaseSafety.cfg');
    expect({ UnsafeSteals: c.UnsafeSteals, RenewalWinsGap: c.RenewalWinsGap }).toEqual({ UnsafeSteals: 'TRUE', RenewalWinsGap: 'FALSE' });
    expect(Number(c.MaxTxMs)).toBeGreaterThanOrEqual(Number(c.RenewTimeoutMs));
  });
});
