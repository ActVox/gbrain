#!/usr/bin/env bun
/**
 * ActVox upstream-merge resolver. Run inside a repository that is mid-merge
 * (`git merge --no-commit <upstream>` left conflicts). Every conflicted path is
 * matched against scripts/actvox/merge-policy.tsv and resolved deterministically;
 * a path no rule covers is left conflicted for a human and makes the run exit 3.
 *
 * After resolving, the repository's own generators rerun so stamp and generated
 * files match the merged sources (skip with --no-regenerate, e.g. in fixtures).
 *
 * Usage: bun scripts/actvox/resolve-upstream-merge.ts [--no-regenerate] [--json]
 * Exit: 0 all conflicts resolved, 3 residual conflicts remain, 2 usage/setup error.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Action = 'upstream' | 'ours' | 'package-pins' | 'ratchet' | 'claude-md' | 'admin-rebuild' | 'runner-labels';
export interface Rule { glob: string; action: Action; reason: string }
export interface Resolution { path: string; action: Action }
export interface ResolveResult { resolved: Resolution[]; residual: string[]; regenerated: string[] }

const ACTIONS = new Set<Action>(['upstream', 'ours', 'package-pins', 'ratchet', 'claude-md', 'admin-rebuild', 'runner-labels']);
const POLICY = 'scripts/actvox/merge-policy.tsv';
const PINS = 'scripts/actvox/package-pins.json';
const RATCHET = 'scripts/actvox/ratchet-overrides.tsv';
const SNIPPET = 'docs/operations/actvox-claude-md-snippet.md';

function dataRows(text: string): string[][] {
  return text.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t'));
}

export function parsePolicy(text: string): Rule[] {
  return dataRows(text).map(([glob, action, reason = ''], i) => {
    if (!glob || !ACTIONS.has(action as Action)) throw new Error(`merge-policy row ${i + 1}: unknown action "${action}"`);
    return { glob, action: action as Action, reason };
  });
}

/** `*` matches any run of characters including `/`; everything else is literal. */
export function globMatches(glob: string, path: string): boolean {
  const re = new RegExp('^' + glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(path);
}

export function matchRule(rules: Rule[], path: string): Rule | undefined {
  return rules.find(r => globMatches(r.glob, path));
}

function rangeVersion(range: string): number[] {
  return range.replace(/^[^0-9]*/, '').split(/[^0-9]+/).filter(Boolean).slice(0, 3).map(Number);
}

/** The higher of two semver ranges by their base version; ties keep `current`. */
export function higherRange(current: string, floor: string): string {
  const a = rangeVersion(current), b = rangeVersion(floor);
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return floor;
    if ((b[i] ?? 0) < (a[i] ?? 0)) return current;
  }
  return current;
}

/**
 * Re-apply pin floors to upstream's package.json text. Edits only the pinned
 * entries in place so upstream's formatting and key order survive; a pinned
 * key missing from its section is inserted at the top of that section.
 */
export function applyPackagePins(upstreamText: string, pins: Record<string, Record<string, string>>): string {
  const parsed = JSON.parse(upstreamText) as Record<string, Record<string, string> | unknown>;
  let text = upstreamText;
  for (const [section, entries] of Object.entries(pins)) {
    if (section.startsWith('_')) continue;
    const current = (parsed[section] ?? {}) as Record<string, string>;
    const open = text.indexOf(`"${section}": {`);
    if (open < 0) throw new Error(`package.json has no "${section}" section for pins`);
    const close = text.indexOf('}', open);
    let block = text.slice(open, close);
    for (const [name, floor] of Object.entries(entries)) {
      const quoted = JSON.stringify(name);
      if (current[name] === undefined) {
        const indent = (/\n(\s+)"/.exec(block)?.[1]) ?? '    ';
        block = block.replace(`"${section}": {`, `"${section}": {\n${indent}${quoted}: ${JSON.stringify(floor)},`);
        continue;
      }
      const next = higherRange(current[name], floor);
      block = block.replace(`${quoted}: ${JSON.stringify(current[name])}`, `${quoted}: ${JSON.stringify(next)}`);
    }
    text = text.slice(0, open) + block + text.slice(close);
  }
  JSON.parse(text);
  return text;
}

const RATCHET_SHAPE: Record<string, { keyCols: number; valueCol: number }> = {
  'scripts/module-size-limits.tsv': { keyCols: 1, valueCol: 1 },
  'scripts/function-size-baseline.tsv': { keyCols: 2, valueCol: 2 },
  'scripts/structural-suites.tsv': { keyCols: 2, valueCol: 2 },
};

/** Re-apply the fork's ratchet deltas for one TSV to upstream's text. */
export function applyRatchetOverrides(tsv: string, upstreamText: string, overridesText: string): string {
  const shape = RATCHET_SHAPE[tsv];
  if (!shape) throw new Error(`no ratchet shape for ${tsv}`);
  const lines = upstreamText.split('\n');
  const keyOf = (cols: string[]) => cols.slice(0, shape.keyCols).join('|');
  for (const [file, key, op, ...rest] of dataRows(overridesText)) {
    if (file !== tsv) continue;
    const idx = lines.findIndex(l => !l.startsWith('#') && keyOf(l.split('\t')) === key);
    if (op === 'row') {
      if (idx < 0) {
        const insertAt = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
        lines.splice(insertAt, 0, rest.join('\t'));
      }
      continue;
    }
    if (idx < 0) throw new Error(`${tsv}: upstream has no row "${key}" for a ${op} override; review ratchet-overrides.tsv`);
    const cols = lines[idx].split('\t');
    const base = Number(cols[shape.valueCol]);
    const value = Number(rest[0]);
    if (!Number.isFinite(base) || !Number.isFinite(value)) throw new Error(`${tsv}: non-numeric value for "${key}"`);
    cols[shape.valueCol] = String(op === 'add' ? base + value : op === 'set' ? value : NaN);
    if (cols[shape.valueCol] === 'NaN') throw new Error(`${tsv}: unknown op "${op}" for "${key}"`);
    lines[idx] = cols.join('\t');
  }
  return lines.join('\n');
}

/**
 * Snippet file: first line `<!-- anchor: <exact line text> -->`, then the
 * paragraph. The paragraph is inserted after the anchor's paragraph (the next
 * blank line). Idempotent; a missing anchor throws so a human reviews it.
 */
export function applyClaudeMdSnippet(upstreamText: string, snippetDoc: string): string {
  const [first, ...body] = snippetDoc.replace(/\s+$/, '').split('\n');
  const anchor = /^<!-- anchor: (.*) -->$/.exec(first)?.[1];
  const paragraph = body.join('\n').trim();
  if (!anchor || !paragraph) throw new Error(`${SNIPPET} must start with <!-- anchor: ... --> followed by the paragraph`);
  if (upstreamText.includes(paragraph)) return upstreamText;
  const lines = upstreamText.split('\n');
  const at = lines.findIndex(l => l.includes(anchor));
  if (at < 0) throw new Error(`CLAUDE.md anchor not found: "${anchor}"`);
  let end = at;
  while (end < lines.length && lines[end].trim() !== '') end++;
  lines.splice(end, 0, '', paragraph);
  return lines.join('\n');
}

/** ActVox runner policy: hosted Ubuntu runners instead of upstream's Ubicloud labels. */
export function swapRunnerLabels(text: string): string {
  return text
    .replace(/ubicloud-standard-\d+-arm-ubuntu-2404/g, 'ubuntu-24.04-arm')
    .replace(/ubicloud-standard-\d+-ubuntu-2404/g, 'ubuntu-24.04');
}

/**
 * Safe only when the fork's whole edit to the file IS the label swap: the
 * fork's side must equal swapRunnerLabels(merge base). Any other fork edit
 * returns null so the file stays with a human.
 */
export function runnerLabelResolution(base: string, ours: string, theirs: string): string | null {
  return swapRunnerLabels(base) === ours ? swapRunnerLabels(theirs) : null;
}

function git(cwd: string, args: string[], allowFail = false): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

function takeSide(cwd: string, path: string, side: 'theirs' | 'ours'): boolean {
  const stage = side === 'theirs' ? 3 : 2;
  const exists = Bun.spawnSync(['git', 'cat-file', '-e', `:${stage}:${path}`], { cwd }).exitCode === 0;
  if (!exists) { git(cwd, ['rm', '-q', '--', path]); return false; }
  git(cwd, ['checkout', `--${side}`, '--', path]);
  return true;
}

function run(cwd: string, cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) throw new Error(`regenerate step failed (${r.exitCode}): ${cmd.join(' ')}`);
}

export function resolveMerge(cwd: string, opts: { regenerate: boolean }): ResolveResult {
  if (!existsSync(join(cwd, '.git')) && git(cwd, ['rev-parse', '--git-dir'], true) === '') throw new Error('not a git repository');
  const rules = parsePolicy(readFileSync(join(cwd, POLICY), 'utf8'));
  const conflicted = git(cwd, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  const result: ResolveResult = { resolved: [], residual: [], regenerated: [] };
  let adminRebuild = false;
  for (const path of conflicted) {
    const rule = matchRule(rules, path);
    if (!rule) { result.residual.push(path); continue; }
    const file = join(cwd, path);
    try {
      switch (rule.action) {
        case 'upstream': takeSide(cwd, path, 'theirs'); break;
        case 'ours': case 'admin-rebuild': takeSide(cwd, path, 'ours'); adminRebuild ||= rule.action === 'admin-rebuild'; break;
        case 'package-pins': {
          takeSide(cwd, path, 'theirs');
          const pins = JSON.parse(readFileSync(join(cwd, PINS), 'utf8'));
          writeFileSync(file, applyPackagePins(readFileSync(file, 'utf8'), pins));
          break;
        }
        case 'ratchet':
          takeSide(cwd, path, 'theirs');
          writeFileSync(file, applyRatchetOverrides(path, readFileSync(file, 'utf8'), readFileSync(join(cwd, RATCHET), 'utf8')));
          break;
        case 'runner-labels': {
          const stage = (n: number) => git(cwd, ['show', `:${n}:${path}`]);
          const resolved = runnerLabelResolution(stage(1), stage(2), stage(3));
          if (resolved === null) throw new Error('fork edits go beyond the runner-label swap');
          takeSide(cwd, path, 'theirs');
          writeFileSync(file, resolved);
          break;
        }
        case 'claude-md':
          takeSide(cwd, path, 'theirs');
          writeFileSync(file, applyClaudeMdSnippet(readFileSync(file, 'utf8'), readFileSync(join(cwd, SNIPPET), 'utf8')));
          break;
      }
      if (existsSync(file)) git(cwd, ['add', '--', path]);
      result.resolved.push({ path, action: rule.action });
    } catch (e) {
      // A rule that cannot apply cleanly is a human decision, never a guess.
      git(cwd, ['checkout', '--merge', '--', path], true);
      result.residual.push(`${path} (${rule.action}: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (opts.regenerate && result.resolved.length) {
    // Each step runs only when its generator exists in the merged tree.
    const steps: Array<[string, string, string[]]> = [
      ['bun.lock', 'package.json', ['bun', 'install']],
      ['templates/bootstrap/template-repo', 'scripts/generate-template-repo.ts', ['bun', 'run', 'scripts/generate-template-repo.ts', '--out', 'templates/bootstrap/template-repo']],
      ['plugin trees', 'scripts/generate-plugin-tree.ts', ['bun', 'run', 'scripts/generate-plugin-tree.ts', '--out', 'plugin', '--variants-out', 'plugin-variants']],
      ['llms bundles', 'scripts/build-llms.ts', ['bun', 'run', 'build:llms']],
    ];
    if (adminRebuild) steps.push(['admin dist', 'admin/package.json', ['bash', '-c', 'cd admin && bun install --frozen-lockfile && cd .. && bun run build:admin']]);
    for (const [label, needs, cmd] of steps) {
      if (!existsSync(join(cwd, needs))) continue;
      run(cwd, cmd); result.regenerated.push(label);
    }
    git(cwd, ['add', '-A', '--', 'bun.lock', 'templates/bootstrap/template-repo', 'plugin', 'plugin-variants', 'llms.txt', 'llms-full.txt', 'admin/dist', 'src/admin-embedded.ts'], true);
  }
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter(a => a !== '--no-regenerate' && a !== '--json');
  if (unknown.length) { console.error(`unknown argument: ${unknown[0]}`); process.exit(2); }
  try {
    const result = resolveMerge(process.cwd(), { regenerate: !args.includes('--no-regenerate') });
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      for (const r of result.resolved) console.log(`resolved  ${r.action.padEnd(13)} ${r.path}`);
      for (const p of result.residual) console.log(`RESIDUAL  ${p}`);
      if (result.regenerated.length) console.log(`regenerated: ${result.regenerated.join(', ')}`);
      console.log(`summary: ${result.resolved.length} resolved by policy, ${result.residual.length} need a human`);
    }
    process.exit(result.residual.length ? 3 : 0);
  } catch (e) {
    console.error(`resolve-upstream-merge: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
