/**
 * #6828 known-bad recovery. Before the fix, a swap that installed nothing
 * (`bun update` on a moving tag whose head was already installed) still
 * reported "swapped", the supervisor relaunched the SAME version, and the
 * boot reconcile recorded the attempted, never-installed version in
 * `self_upgrade.failed_versions`, so the auto channel skipped that release
 * forever. This module finds the entries the audit proves were never
 * installed. Clearing them is the operator step
 * `gbrain self-upgrade --clear-never-installed [--apply]`; doctor's
 * `self_upgrade_health` names its preview as the fix. File plane only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { readAllSelfUpgrades } from './audit/self-upgrade-audit.ts';
import { CRASH_ON_LAUNCH_REASON_PREFIX, SWAPPED_REASON } from './self-upgrade.ts';

/** The preview and apply commands of the recovery. */
export const CLEAR_NEVER_INSTALLED_PREVIEW = ['gbrain', 'self-upgrade', '--clear-never-installed'];
export const CLEAR_NEVER_INSTALLED_APPLY = [...CLEAR_NEVER_INSTALLED_PREVIEW, '--apply'];

export interface NeverInstalledEntry {
  version: string;
  /** The version that ran both before the swap and after the relaunch. */
  running: string;
  /** When the swap reported "swapped" and when the relaunch recorded the entry. */
  swapped_at: string;
  recorded_at: string;
}

/**
 * The `failed_versions` entries the audit proves were never installed. The
 * proof is the pair the pre-fix channel left: the swap row and the relaunch's
 * crash-on-launch row ran the same version, so the attempted one was never on
 * disk. An entry qualifies only when every failure the audit records for it
 * is such a pair, at least one exists, no audit row ever ran it, and the last
 * recorded upgrade did not install it. Anything unproven stays known-bad.
 * Pure; `events` in ts order.
 */
export function neverInstalledFailedVersions(
  failedVersions: readonly string[],
  events: readonly { ts: string; channel: string; action: string; current: string; latest?: string | null; outcome?: string; reason?: string }[],
  lastUpgradeTo: string | null,
): NeverInstalledEntry[] {
  const out: NeverInstalledEntry[] = [];
  for (const version of failedVersions) {
    if (version === lastUpgradeTo) continue;
    if (events.some((e) => e.current === version)) continue;
    const failures = events.flatMap((e, i) => (e.outcome === 'failed' && e.latest === version ? [i] : []));
    if (failures.length === 0) continue;
    let proof: NeverInstalledEntry | null = null;
    const allNoOp = failures.every((i) => {
      const recorded = events[i];
      if (!recorded.reason?.startsWith(CRASH_ON_LAUNCH_REASON_PREFIX)) return false;
      const swap = events.slice(0, i).findLast((e) =>
        e.channel === 'autopilot' && e.latest === version && e.outcome !== undefined);
      if (!swap || swap.outcome !== 'applied' || swap.reason !== SWAPPED_REASON || swap.current !== recorded.current) return false;
      proof ??= { version, running: recorded.current, swapped_at: swap.ts, recorded_at: recorded.ts };
      return true;
    });
    if (allNoOp && proof) out.push(proof);
  }
  return out;
}

/** The version the last real swap installed (`~/.gbrain/upgrade-state.json`), or null. */
function lastUpgradeTo(): string | null {
  try {
    const path = join(process.env.HOME || '', '.gbrain', 'upgrade-state.json');
    if (!existsSync(path)) return null;
    const to = (JSON.parse(readFileSync(path, 'utf8')) as { last_upgrade?: { to?: unknown } }).last_upgrade?.to;
    return typeof to === 'string' ? to : null;
  } catch {
    return null;
  }
}

/** The known-bad entries the audit proves were never installed, with the current list. */
export function findNeverInstalledFailures(): { failed: string[]; clearable: NeverInstalledEntry[] } {
  const failed = loadConfig()?.self_upgrade?.failed_versions ?? [];
  if (failed.length === 0) return { failed, clearable: [] };
  return { failed, clearable: neverInstalledFailedVersions(failed, readAllSelfUpgrades(), lastUpgradeTo()) };
}

