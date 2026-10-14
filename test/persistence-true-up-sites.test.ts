/**
 * #6696 (A1) guard: every site that moves an effect to a settled state
 * (`committed`, `failed`, or a computed state) must reach `trueUpRequests`
 * after its transaction, or the request keeps its admission reservation
 * forever. A new site fails here until it is wired and listed.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

/** Settling file -> the file whose code calls trueUpRequests for it (itself when it calls it directly). */
const SITES: Record<string, string> = {
  // completeEffect / parkEffect / failEffect run only under the effect runner, which trues up every request it claimed.
  'src/core/persistence/effect-journal.ts': 'src/core/persistence/effects.ts',
  'src/core/persistence/effects.ts': 'src/core/persistence/effects.ts',
  'src/core/persistence/embedding-settlement.ts': 'src/core/persistence/embedding-settlement.ts',
  'src/core/persistence/embedding-noop-settle.ts': 'src/core/persistence/embedding-noop-settle.ts',
  'src/core/persistence/effect-retry.ts': 'src/core/persistence/effect-retry.ts',
  'src/core/shared-skills/restore.ts': 'src/core/backup/snapshot.ts',
};
/** Files that may call the effect-journal settle helpers: the runner and the handlers it dispatches. */
const RUNNER_FILES = new Set(['src/core/persistence/effects.ts', 'src/core/persistence/effect-facts.ts', 'src/core/persistence/effect-links.ts',
  'src/core/persistence/effect-journal.ts']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}
const sources = files(SRC).map(path => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));
/** An UPDATE of persistence_effects whose SET list (before WHERE) assigns `state` anything but queued/running, in any position. */
const SETTLE = /UPDATE\s+persistence_effects\b(?:(?!\bWHERE\b)[^`;])*?\bSET\b(?:(?!\bWHERE\b)[^`;])*?(?<![.\w])state\s*=\s*(?!'queued'|'running')/;

test('every effect settle site is listed and reaches trueUpRequests', () => {
  const settling = sources.filter(file => SETTLE.test(file.text)).map(file => file.path).sort();
  expect(settling).toEqual(Object.keys(SITES).sort());
  for (const [site, caller] of Object.entries(SITES)) {
    const text = sources.find(file => file.path === caller)?.text ?? '';
    expect({ site, caller, calls: /trueUpRequests\(/.test(text) }).toEqual({ site, caller, calls: true });
  }
});

test('the effect-journal settle helpers are called only under the effect runner', () => {
  const callers = sources.filter(file => /\b(?:completeEffect|failEffect|parkEffect)\(/.test(file.text)).map(file => file.path);
  expect(callers.filter(path => !RUNNER_FILES.has(path))).toEqual([]);
});
