#!/usr/bin/env bun
/**
 * ActVox fork-delta ratchet. Compares HEAD against the upstream commit the fork
 * last integrated (scripts/actvox/upstream-base) and fails when:
 *   - a changed path has no row in scripts/actvox/patch-inventory.tsv,
 *   - a row's line budget (added + deleted vs upstream) is exceeded, or
 *   - a hand-edited row matches nothing in the delta (stale: remove it with its
 *     patch). Rows of class `generated` (stamps, bundles, goldens, build output)
 *     are exempt: they appear and disappear with each release.
 * Every in-place edit to an upstream-owned file is therefore a reviewed,
 * budgeted decision, and the conflict surface cannot grow silently.
 *
 * Usage: bun scripts/actvox/check-delta.ts [--base <commit>] [--print]
 *   --print  list the current delta as inventory-ready rows instead of checking.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globMatches } from './resolve-upstream-merge.ts';

export interface InventoryRow { glob: string; klass: string; budget: number | '*'; upstreamable: string; note: string }
export interface DeltaEntry { path: string; changed: number | 'binary' }
export interface DeltaReport { unlisted: string[]; overBudget: string[]; stale: string[] }

const INVENTORY = 'scripts/actvox/patch-inventory.tsv';
const BASE_FILE = 'scripts/actvox/upstream-base';

export function parseInventory(text: string): InventoryRow[] {
  return text.split('\n').filter(l => l.trim() && !l.startsWith('#')).map((line, i) => {
    const [glob, klass, budget, upstreamable = '', note = ''] = line.split('\t');
    const n = budget === '*' ? '*' : Number(budget);
    if (!glob || !klass || (n !== '*' && !(Number.isInteger(n) && n >= 0))) {
      throw new Error(`${INVENTORY} row ${i + 1}: expected path, class, budget (integer or *)`);
    }
    return { glob, klass, budget: n, upstreamable, note };
  });
}

/** `git diff --numstat` lines → per-path changed-line counts (renames keep the new path). */
export function parseNumstat(text: string): DeltaEntry[] {
  return text.split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...rest] = line.split('\t');
    const raw = rest.join('\t');
    const path = raw.includes(' => ') ? raw.replace(/\{([^}]*) => ([^}]*)\}/, '$2').replace(/^.* => /, '') : raw;
    return { path, changed: added === '-' ? 'binary' : Number(added) + Number(deleted) };
  });
}

export function checkDelta(rows: InventoryRow[], delta: DeltaEntry[]): DeltaReport {
  const report: DeltaReport = { unlisted: [], overBudget: [], stale: [] };
  const used = new Set<InventoryRow>();
  for (const entry of delta) {
    const row = rows.find(r => globMatches(r.glob, entry.path));
    if (!row) { report.unlisted.push(entry.path); continue; }
    used.add(row);
    if (row.budget === '*') continue;
    if (entry.changed === 'binary' || entry.changed > row.budget) {
      report.overBudget.push(`${entry.path}: ${entry.changed} changed line(s) > budget ${row.budget}`);
    }
  }
  // Generated/stamp rows come and go with each release; only hand-edited rows go stale.
  for (const row of rows) if (!used.has(row) && row.klass !== 'generated') report.stale.push(row.glob);
  return report;
}

function git(args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf('--base');
  const base = baseIdx >= 0 ? args[baseIdx + 1] : readFileSync(join(process.cwd(), BASE_FILE), 'utf8').trim();
  const delta = parseNumstat(git(['diff', '--numstat', '-M', base, 'HEAD']));
  if (args.includes('--print')) {
    for (const d of delta) console.log(`${d.path}\t?\t${d.changed === 'binary' ? '*' : d.changed}\t?\t`);
    process.exit(0);
  }
  const report = checkDelta(parseInventory(readFileSync(join(process.cwd(), INVENTORY), 'utf8')), delta);
  for (const p of report.unlisted) console.error(`UNLISTED   ${p}  (add a reviewed row to ${INVENTORY})`);
  for (const p of report.overBudget) console.error(`OVER       ${p}  (shrink the patch, or raise the budget in a reviewed row)`);
  for (const p of report.stale) console.error(`STALE      ${p}  (no longer in the fork delta; remove the row)`);
  const bad = report.unlisted.length + report.overBudget.length + report.stale.length;
  console.log(bad ? `fork-delta: ${bad} problem(s) against upstream ${base.slice(0, 12)}`
    : `OK: fork delta (${delta.length} path(s)) within ${INVENTORY} against upstream ${base.slice(0, 12)}`);
  process.exit(bad ? 1 : 0);
}
