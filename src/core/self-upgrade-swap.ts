/**
 * The autopilot self-upgrade channel's swap settlement (v0.42; #5855, #6828):
 * what `gbrain upgrade --swap-only` (run by src/commands/autopilot.ts) did. Exit 0 alone cannot
 * tell a swap from a no-op (`bun update` on a tag whose head is already
 * installed exits 0 and changes nothing), so the swap writes a receipt naming
 * what it installed (`SWAP_RECEIPT_ENV`). Outcomes:
 *
 *   - the swap's own Bun floor re-check refused (exit 78): hold, never known-bad;
 *   - nothing newer was installed: clear the breadcrumb, record no known-bad,
 *     retry after AUTO_CHECK_INTERVAL_MS (`self_upgrade.last_check_ts`);
 *   - the swap failed: record known-bad the version that was installed and
 *     failed (the attempted one when no receipt says what was installed);
 *   - a newer version is on disk: point the breadcrumb at it, so the
 *     relaunch attributes a crash-on-launch to the version that crashed, and
 *     return `relaunch`.
 *
 * Every stay outcome is persisted and audited here. Never throws on the
 * swap's failure (the caller still guards the tick).
 */

import { unlinkSync } from 'node:fs';
import { gbrainPath, loadConfig, saveConfig } from './config.ts';
import { logSelfUpgrade } from './audit/self-upgrade-audit.ts';
import { BUN_FLOOR_EXIT_CODE, BUN_FLOOR_FIX } from './bun-floor.ts';
import { readSwapReceipt, SWAP_RECEIPT_ENV } from './self-upgrade.ts';
import { isNewerVersion } from './semver.ts';

export type AutopilotSwapResult = { relaunch: false } | { relaunch: true; installed: string };

/** The receipt file for the next swap, with any stale one removed. */
export function prepareSwapReceipt(): string {
  const path = gbrainPath('swap-receipt.json');
  try { unlinkSync(path); } catch { /* absent */ }
  return path;
}

/** Settle a finished `gbrain upgrade --swap-only` (`swapError` is what it threw, or null). */
export function settleAutopilotSwap(running: string, latestVersion: string, swapError: unknown, receiptPath: string): AutopilotSwapResult {
  const receipt = readSwapReceipt(receiptPath);
  try { unlinkSync(receiptPath); } catch { /* absent */ }
  const errorText = swapError === null ? undefined : swapError instanceof Error ? swapError.message : String(swapError);
  const held = swapError !== null && (swapError as { status?: number }).status === BUN_FLOOR_EXIT_CODE;

  if (!held && receipt?.outcome === 'not_installed') {
    const fresh = loadConfig();
    if (fresh) {
      fresh.self_upgrade = { ...(fresh.self_upgrade ?? {}), last_check_ts: Date.now() };
      delete fresh.self_upgrade.attempting_version;
      saveConfig(fresh);
    }
    logSelfUpgrade({
      channel: 'autopilot',
      action: 'apply',
      current: running,
      latest: latestVersion,
      outcome: 'skipped',
      reason: `nothing newer was installed: still running ${running} (${latestVersion} not recorded known-bad; next attempt in 24h)`,
      ...(errorText ? { error: errorText } : {}),
    });
    console.log(`[autopilot] self-upgrade installed nothing newer; staying on ${running}, retrying in 24h.`);
    return { relaunch: false };
  }
  const installed = receipt?.installed && isNewerVersion(running, receipt.installed) ? receipt.installed : null;

  if (swapError !== null) {
    const bad = installed ?? latestVersion;
    const fresh = loadConfig();
    if (fresh) {
      const failed = new Set(fresh.self_upgrade?.failed_versions ?? []);
      if (!held) failed.add(bad);
      fresh.self_upgrade = { ...(fresh.self_upgrade ?? {}), failed_versions: [...failed] };
      delete fresh.self_upgrade.attempting_version;
      saveConfig(fresh);
    }
    logSelfUpgrade(held
      ? { channel: 'autopilot', action: 'unsupported_runtime', current: running, latest: latestVersion, outcome: 'skipped', reason: `gbrain upgrade refused the swap: the Bun floor of ${latestVersion} is not met or unreadable. ${BUN_FLOOR_FIX}` }
      : { channel: 'autopilot', action: 'apply', current: running, latest: bad, outcome: 'failed', error: errorText });
    console.error(`[autopilot] self-upgrade swap failed; staying on ${running}.`);
    return { relaunch: false };
  }

  if (installed && installed !== latestVersion) {
    const fresh = loadConfig();
    if (fresh) {
      fresh.self_upgrade = { ...(fresh.self_upgrade ?? {}), attempting_version: installed };
      saveConfig(fresh);
    }
  }
  return { relaunch: true, installed: installed ?? latestVersion };
}
