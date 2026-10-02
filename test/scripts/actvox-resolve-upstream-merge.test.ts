/**
 * ActVox upstream-merge resolver (scripts/actvox/resolve-upstream-merge.ts).
 *
 * Protects: an upstream integration resolves generated/stamp files, the fork's
 * dependency security floors, ratchet deltas and the CLAUDE.md fork paragraph by
 * policy, and stops on any source conflict instead of guessing.
 * Fails when: package.json is taken wholesale (pins lost), a floor downgrades an
 * upstream bump, a ratchet delta is dropped or double-applied, the CLAUDE.md
 * paragraph is lost or duplicated, or an unlisted conflict is auto-resolved.
 * Why new: the fork's previous sync script took package.json wholesale and had
 * no generated-file policy; nothing tested integration resolution.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  applyClaudeMdSnippet, applyPackagePins, applyRatchetOverrides, globMatches, higherRange,
  matchRule, parsePolicy, resolveMerge, runnerLabelResolution,
} from '../../scripts/actvox/resolve-upstream-merge.ts';

const REPO = join(import.meta.dir, '../..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

describe('policy table', () => {
  test('the committed policy parses and routes the fork-sensitive paths', () => {
    const rules = parsePolicy(read('scripts/actvox/merge-policy.tsv'));
    const action = (p: string) => matchRule(rules, p)?.action;
    expect(action('VERSION')).toBe('upstream');
    expect(action('package.json')).toBe('package-pins');
    expect(action('plugin-variants/gbrain-daily/README.md')).toBe('upstream');
    expect(action('admin/dist/assets/index-abc.css')).toBe('admin-rebuild');
    expect(action('scripts/module-size-limits.tsv')).toBe('ratchet');
    expect(action('CLAUDE.md')).toBe('claude-md');
    expect(action('docs/operations/fork-upstream-production-branching.md')).toBe('ours');
    expect(action('src/commands/extract.ts')).toBeUndefined();
    expect(action('.github/workflows/test.yml')).toBe('runner-labels');
    expect(action('.github/workflows/upstream-watch.yml')).toBe('ours');
  });

  test('an unknown action is rejected', () => {
    expect(() => parsePolicy('VERSION\tguess\twhy')).toThrow('unknown action');
  });

  test('globs match literally except for *', () => {
    expect(globMatches('plugin/*', 'plugin/a/b.md')).toBe(true);
    expect(globMatches('plugin/*', 'plugin-variants/x')).toBe(false);
    expect(globMatches('llms.txt', 'llmsXtxt')).toBe(false);
  });
});

describe('package pins are floors', () => {
  const upstream = `{\n  "name": "x",\n  "version": "1.2.0",\n  "dependencies": {\n    "marked": "^18.0.2",\n    "zod": "^4.0.0"\n  },\n  "overrides": {\n    "fast-xml-parser": "^5.11.0"\n  }\n}\n`;
  const pins = { _comment: {} as Record<string, string>, dependencies: { marked: '^18.0.5' }, overrides: { 'fast-xml-parser': '^5.10.1', '@hono/node-server': '^2.0.10' } };

  test('raises a dependency below the floor, keeps an upstream bump above it, inserts a missing override', () => {
    const out = JSON.parse(applyPackagePins(upstream, pins));
    expect(out.version).toBe('1.2.0');
    expect(out.dependencies).toEqual({ marked: '^18.0.5', zod: '^4.0.0' });
    expect(out.overrides).toEqual({ '@hono/node-server': '^2.0.10', 'fast-xml-parser': '^5.11.0' });
  });

  test('leaves upstream formatting outside the pinned lines untouched', () => {
    const out = applyPackagePins(upstream, { dependencies: { marked: '^18.0.5' } });
    expect(out).toBe(upstream.replace('"marked": "^18.0.2"', '"marked": "^18.0.5"'));
  });

  test('higherRange compares base versions numerically', () => {
    expect(higherRange('^5.9.0', '^5.10.1')).toBe('^5.10.1');
    expect(higherRange('^5.11.0', '^5.10.1')).toBe('^5.11.0');
    expect(higherRange('2.0.10', '^2.0.10')).toBe('2.0.10');
  });
});

describe('ratchet overrides', () => {
  const overrides = [
    'scripts/module-size-limits.tsv\tsrc/a.ts\tadd\t44\tfork',
    'scripts/function-size-baseline.tsv\tsrc/a.ts|run\tset\t310\tfork',
    'scripts/structural-suites.tsv\ttest/f.test.ts|fork suite\trow\ttest/f.test.ts\tfork suite\t1\treadFileSync',
  ].join('\n');

  test('add applies the fork delta to upstream’s new ceiling exactly once', () => {
    const upstream = '# Columns: path\tmax_lines\tpolicy\tnote\nsrc/a.ts\t2700\tratchet\tgrew upstream\n';
    expect(applyRatchetOverrides('scripts/module-size-limits.tsv', upstream, overrides))
      .toBe('# Columns: path\tmax_lines\tpolicy\tnote\nsrc/a.ts\t2744\tratchet\tgrew upstream\n');
  });

  test('set replaces a two-key row value and row appends a missing fork row once', () => {
    expect(applyRatchetOverrides('scripts/function-size-baseline.tsv', 'src/a.ts\trun\t398\tseed\n', overrides))
      .toBe('src/a.ts\trun\t310\tseed\n');
    const once = applyRatchetOverrides('scripts/structural-suites.tsv', 'test/u.test.ts\tupstream\t2\treadFileSync\n', overrides);
    expect(once).toBe('test/u.test.ts\tupstream\t2\treadFileSync\ntest/f.test.ts\tfork suite\t1\treadFileSync\n');
    expect(applyRatchetOverrides('scripts/structural-suites.tsv', once, overrides)).toBe(once);
  });

  test('an add/set override whose row upstream removed stops for review', () => {
    expect(() => applyRatchetOverrides('scripts/module-size-limits.tsv', 'src/b.ts\t10\tratchet\tx\n', overrides)).toThrow('no row "src/a.ts"');
  });
});

describe('runner-label transform', () => {
  const base = 'jobs:\n  a:\n    runs-on: ubicloud-standard-4-ubuntu-2404\n  b:\n    runs-on: ubicloud-standard-4-arm-ubuntu-2404\n';
  const ours = 'jobs:\n  a:\n    runs-on: ubuntu-24.04\n  b:\n    runs-on: ubuntu-24.04-arm\n';
  const theirs = base.replace('  b:', '  c:\n    runs-on: ubicloud-standard-8-ubuntu-2404\n  b:');

  test('a fork side that is exactly the label swap of the base resolves to upstream with labels swapped', () => {
    expect(runnerLabelResolution(base, ours, theirs))
      .toBe('jobs:\n  a:\n    runs-on: ubuntu-24.04\n  c:\n    runs-on: ubuntu-24.04\n  b:\n    runs-on: ubuntu-24.04-arm\n');
  });

  test('any fork edit beyond the swap is left for a human', () => {
    expect(runnerLabelResolution(base, ours + '    env: { PAID: 1 }\n', theirs)).toBeNull();
  });
});

describe('CLAUDE.md fork paragraph', () => {
  const snippet = '<!-- anchor: **Always use PATCH**, rule; -->\nFork exception paragraph.\n';
  const upstream = '# T\n\n**Always use PATCH**, rule;\nmore of that paragraph.\n\n### Next\n';

  test('inserts after the anchor paragraph and is idempotent', () => {
    const once = applyClaudeMdSnippet(upstream, snippet);
    expect(once).toBe('# T\n\n**Always use PATCH**, rule;\nmore of that paragraph.\n\nFork exception paragraph.\n\n### Next\n');
    expect(applyClaudeMdSnippet(once, snippet)).toBe(once);
  });

  test('a removed anchor stops for review', () => {
    expect(() => applyClaudeMdSnippet('# T\n', snippet)).toThrow('anchor not found');
  });

  test('the committed CLAUDE.md already carries the committed snippet', () => {
    const text = read('CLAUDE.md');
    expect(applyClaudeMdSnippet(text, read('docs/operations/actvox-claude-md-snippet.md'))).toBe(text);
  });
});

describe('resolveMerge on a real conflicted merge', () => {
  const roots: string[] = [];
  afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

  function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0 && args[0] !== 'merge') throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.toString();
  }
  function write(root: string, files: Record<string, string>) {
    for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
  }
  const pkg = (version: string, marked: string) => `{\n  "name": "fixture",\n  "version": "${version}",\n  "dependencies": {\n    "marked": "${marked}"\n  },\n  "overrides": {\n    "fast-xml-parser": "^5.7.0"\n  }\n}\n`;

  test('policy paths resolve, pins and deltas survive, a source conflict is left for a human', () => {
    const root = mkdtempSync(join(tmpdir(), 'actvox-resolver-'));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'master');
    for (const p of ['scripts/actvox/merge-policy.tsv', 'scripts/actvox/package-pins.json']) {
      mkdirSync(dirname(join(root, p)), { recursive: true }); copyFileSync(join(REPO, p), join(root, p));
    }
    write(root, {
      'scripts/actvox/ratchet-overrides.tsv': 'scripts/module-size-limits.tsv\tsrc/a.ts\tadd\t44\tfork\n',
      VERSION: '1.0.0.0\n',
      'package.json': pkg('1.0.0.0', '^18.0.2'),
      'scripts/module-size-limits.tsv': 'src/a.ts\t100\tratchet\tbase\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');

    git(root, 'checkout', '-q', '-b', 'upstream');
    write(root, {
      VERSION: '1.0.1.0\n',
      'package.json': pkg('1.0.1.0', '^18.0.2').replace('^5.7.0', '^5.12.0'),
      'scripts/module-size-limits.tsv': 'src/a.ts\t120\tratchet\tgrew upstream\n',
      'src/a.ts': 'export const a = 2;\n',
    });
    git(root, 'commit', '-q', '-am', 'upstream release');

    git(root, 'checkout', '-q', 'master');
    write(root, {
      VERSION: '1.0.0.1\n',
      'package.json': pkg('1.0.0.1', '^18.0.5').replace('^5.7.0', '^5.10.1'),
      'scripts/module-size-limits.tsv': 'src/a.ts\t144\tratchet\tbase; +44 fork\n',
      'src/a.ts': 'export const a = 3;\n',
    });
    git(root, 'commit', '-q', '-am', 'fork release');

    git(root, 'merge', '--no-ff', '--no-commit', 'upstream');
    const result = resolveMerge(root, { regenerate: false });

    expect(result.resolved.map(r => `${r.action}:${r.path}`).sort()).toEqual([
      'package-pins:package.json', 'ratchet:scripts/module-size-limits.tsv', 'upstream:VERSION',
    ]);
    expect(result.residual).toEqual(['src/a.ts']);
    expect(readFileSync(join(root, 'VERSION'), 'utf8')).toBe('1.0.1.0\n');
    const merged = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(merged.version).toBe('1.0.1.0');
    expect(merged.dependencies.marked).toBe('^18.0.5');
    expect(merged.overrides['fast-xml-parser']).toBe('^5.12.0');
    expect(merged.overrides['@hono/node-server']).toBe('^2.0.10');
    expect(readFileSync(join(root, 'scripts/module-size-limits.tsv'), 'utf8')).toBe('src/a.ts\t164\tratchet\tgrew upstream\n');
    expect(git(root, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('src/a.ts');
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toContain('<<<<<<<');
  });
});
