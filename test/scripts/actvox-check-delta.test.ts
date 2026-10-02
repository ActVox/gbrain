/**
 * ActVox fork-delta ratchet (scripts/actvox/check-delta.ts).
 *
 * Protects: every fork edit to an upstream-owned file is inventoried with a
 * line budget; growth past a budget, an unlisted edit, and a stale hand-edited
 * row all fail. Generated/stamp rows never go stale.
 * Fails when: an unlisted path passes, a patch grows inside a listed file
 * unnoticed, a removed patch leaves its row behind, or a release flips a
 * generated row stale.
 * Why new: no check compared the fork against upstream; the conflict surface
 * could grow silently between integrations.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDelta, parseInventory, parseNumstat } from '../../scripts/actvox/check-delta.ts';

const inventory = parseInventory([
  '# path\tclass\tbudget\tupstreamable\tnote',
  'src/core/watchdog.ts\tcode\t50\tyes\tworker restart fix',
  'docs/operations/*\tactvox-owned\t*\tno\tfork ops docs',
  'VERSION\tgenerated\t*\tno\tstamp',
  'src/core/dropped.ts\tcode\t10\tyes\tpatch since upstreamed',
].join('\n'));

describe('fork-delta ratchet', () => {
  test('a delta inside its budgets passes except for the stale hand-edited row', () => {
    const report = checkDelta(inventory, parseNumstat('36\t14\tsrc/core/watchdog.ts\n120\t0\tdocs/operations/runbook.md\n'));
    expect(report).toEqual({ unlisted: [], overBudget: [], stale: ['src/core/dropped.ts'] });
  });

  test('growth past a budget, an unlisted edit, and a binary change in a budgeted row fail', () => {
    const report = checkDelta(inventory, parseNumstat('40\t14\tsrc/core/watchdog.ts\n1\t1\tsrc/core/new-patch.ts\n-\t-\tsrc/core/dropped.ts\n5\t0\tdocs/operations/x.md\n'));
    expect(report.unlisted).toEqual(['src/core/new-patch.ts']);
    expect(report.overBudget).toEqual([
      'src/core/watchdog.ts: 54 changed line(s) > budget 50',
      'src/core/dropped.ts: binary changed line(s) > budget 10',
    ]);
    expect(report.stale).toEqual([]);
  });

  test('a generated row absent from the delta is not stale', () => {
    expect(checkDelta(inventory, parseNumstat('1\t1\tsrc/core/watchdog.ts\n1\t0\tsrc/core/dropped.ts\n5\t0\tdocs/operations/x.md\n')).stale).toEqual([]);
  });

  test('renamed paths are checked under their new name', () => {
    expect(parseNumstat('3\t1\tsrc/core/{old.ts => watchdog.ts}\n2\t0\ta.ts => docs/operations/b.md\n')).toEqual([
      { path: 'src/core/watchdog.ts', changed: 4 },
      { path: 'docs/operations/b.md', changed: 2 },
    ]);
  });

  test('malformed budgets are rejected', () => {
    expect(() => parseInventory('src/a.ts\tcode\tlots\tyes\tx')).toThrow('budget');
  });

  test('the committed inventory parses and the recorded upstream base is a full commit id', () => {
    const root = join(import.meta.dir, '../..');
    expect(parseInventory(readFileSync(join(root, 'scripts/actvox/patch-inventory.tsv'), 'utf8')).length).toBeGreaterThan(0);
    expect(readFileSync(join(root, 'scripts/actvox/upstream-base'), 'utf8').trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
