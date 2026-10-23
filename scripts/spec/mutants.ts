#!/usr/bin/env bun
/**
 * Guard mutants for the TLA+ specs (spec/tla/README.md). Each mutant in spec/tla/<spec>/mutants.json removes one guard:
 *
 * - its `spec` edit is applied to a copy of the model, and TLC must report the named property (or nothing, for a
 *   mutant marked `survives`: a guard that is defense in depth at these bounds);
 * - its `code` edits, when present, are applied to the implementation in a scratch copy of the working tree, and each
 *   named test must fail on its own assertions under them and pass without them. That ties each guard the model relies
 *   on to the lines that implement it (every engine branch) and the tests that pin it.
 *
 *   bun scripts/spec/mutants.ts [<spec>] [--only <id>] [--spec-only | --code-only] [--require-postgres]
 *
 * Failure codes: MUTANT_STALE (an edit's `before` text is not found exactly once: the spec or code moved; update the
 * mutant), MUTANT_SURVIVED (TLC found no violation, or the test passed under the code edit: a property or a test no
 * longer catches the guard), MUTANT_WRONG_PROPERTY, MUTANT_INCOMPLETE (TLC did not finish, or a test failed without
 * the edit, matched no test, or did not load with it).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Edit { file: string; before: string; after: string }
interface CodeTest { test: string; filter: string; postgres?: boolean }
interface CodeEdit { edits: Edit[]; tests: CodeTest[] }
interface Mutant { id: string; kind: 'guard' | 'assumption' | 'survivor'; title: string; expect: string; reason?: string; spec: Edit; code?: CodeEdit }
interface Catalog { module: string; config: string; mutants: Mutant[] }

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const specName = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') ?? 'drain-lease';
const specDir = join(ROOT, 'spec/tla', specName);
const catalog = JSON.parse(readFileSync(join(specDir, 'mutants.json'), 'utf8')) as Catalog;
const out = process.env.TLC_OUT ?? join(ROOT, '.context/tlc');
const timeoutS = Number(process.env.TLC_TIMEOUT_S ?? 300);
const failures: string[] = [];
const fail = (code: string, id: string, message: string) => { failures.push(`${code} ${id}: ${message}`); console.error(`FAIL ${code} ${id}: ${message}`); };

function applyOnce(text: string, edit: Edit): string | null {
  const at = text.indexOf(edit.before);
  if (at < 0 || text.indexOf(edit.before, at + 1) >= 0) return null;
  return text.slice(0, at) + edit.after + text.slice(at + edit.before.length);
}

function jar(): string {
  const r = spawnSync('bash', [join(ROOT, 'scripts/spec/tla-jar.sh')], { encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(2); }
  return r.stdout.trim();
}

function runSpec(m: Mutant, tla2tools: string): void {
  const work = join(out, `mutant-${specName}-${m.id}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'tmp'), { recursive: true });
  for (const f of [`${catalog.module}.tla`, catalog.config]) cpSync(join(specDir, f), join(work, f));
  const target = join(work, m.spec.file);
  const mutated = applyOnce(readFileSync(target, 'utf8'), m.spec);
  if (mutated === null) return fail('MUTANT_STALE', m.id, `spec text not found exactly once in ${m.spec.file}: ${JSON.stringify(m.spec.before)}`);
  writeFileSync(target, mutated);
  const r = spawnSync('java', ['-XX:+UseParallelGC', `-Djava.io.tmpdir=${join(work, 'tmp')}`, '-cp', tla2tools, 'tlc2.TLC', '-workers', 'auto',
    '-config', catalog.config, '-metadir', join(work, 'states'), `${catalog.module}.tla`], { cwd: work, encoding: 'utf8', timeout: timeoutS * 1000 });
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(join(work, 'tlc.log'), log);
  const violated = log.match(/(?:Invariant|Action property|Property) (\w+) is violated/)?.[1];
  const clean = log.includes('Model checking completed. No error has been found.');
  if (m.expect === 'survives') {
    if (clean) return void console.log(`ok   ${m.id} (survivor): survives as expected (defense in depth)`);
    if (violated) return fail('MUTANT_WRONG_PROPERTY', m.id, `expected to survive, but ${violated} is violated: the guard is now load-bearing; give it an expect and a code test. Log: ${work}/tlc.log`);
    return fail('MUTANT_INCOMPLETE', m.id, `TLC did not finish (exit ${r.status ?? r.signal}). Log: ${work}/tlc.log`);
  }
  if (violated === m.expect) return void console.log(`ok   ${m.id} (${m.kind}): caught by ${violated}`);
  if (violated) return fail('MUTANT_WRONG_PROPERTY', m.id, `expected ${m.expect}, but ${violated} caught it. Log: ${work}/tlc.log`);
  if (clean) return fail('MUTANT_SURVIVED', m.id, `no property caught "${m.title}"; ${m.expect} no longer depends on this guard. Log: ${work}/tlc.log`);
  fail('MUTANT_INCOMPLETE', m.id, `TLC did not finish (exit ${r.status ?? r.signal}). Log: ${work}/tlc.log`);
}

/** The code checks run in a scratch copy of the working tree, so an interrupted run never leaves the checkout edited. */
function scratchCopy(): string {
  const dir = join(out, `mutant-tree-${specName}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.split('\0').filter(Boolean);
  for (const f of files) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

interface TestRun { passed: number; failed: number; clean: boolean; tail: string }
function bunTest(cwd: string, t: CodeTest): TestRun {
  const r = spawnSync('bun', ['test', '--timeout=300000', t.test, '-t', t.filter], { cwd, encoding: 'utf8', env: process.env, timeout: 600_000 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const count = (word: string) => Number(text.match(new RegExp(`^\\s*(\\d+) ${word}\\b`, 'm'))?.[1] ?? 0);
  // A load or bootstrap failure is not a caught guard: the test must have run and failed on its own assertions.
  const clean = !/Unhandled error between tests|SyntaxError|Cannot find module|error: Unexpected/.test(text);
  return { passed: count('pass'), failed: count('fail'), clean, tail: text.split('\n').slice(-12).join('\n') };
}

function runCode(m: Mutant, tree: string): void {
  const code = m.code!;
  const tests = code.tests.filter(t => {
    if (!t.postgres || process.env.DATABASE_URL) return true;
    if (flag('--require-postgres')) fail('MUTANT_INCOMPLETE', m.id, `${t.test} needs DATABASE_URL (a test Postgres)`);
    else console.log(`skip ${m.id} (code): ${t.test} needs DATABASE_URL`);
    return false;
  });
  if (tests.length === 0) return;
  const originals = new Map<string, string>();
  let mutated = new Map<string, string>();
  for (const edit of code.edits) {
    const text = mutated.get(edit.file) ?? readFileSync(join(tree, edit.file), 'utf8');
    originals.set(edit.file, originals.get(edit.file) ?? text);
    const next = applyOnce(text, edit);
    if (next === null) return fail('MUTANT_STALE', m.id, `code text not found exactly once in ${edit.file}: ${JSON.stringify(edit.before)}`);
    mutated.set(edit.file, next);
  }
  for (const t of tests) {
    const base = bunTest(tree, t);
    if (!base.clean || base.failed > 0 || base.passed === 0) return fail('MUTANT_INCOMPLETE', m.id, `${t.test} -t "${t.filter}" does not pass (or matched no test) without the edit:\n${base.tail}`);
    try {
      for (const [file, text] of mutated) writeFileSync(join(tree, file), text);
      const under = bunTest(tree, t);
      if (!under.clean) return fail('MUTANT_INCOMPLETE', m.id, `${t.test} did not load or run with the edit, so it proves nothing:\n${under.tail}`);
      if (under.failed === 0) return fail('MUTANT_SURVIVED', m.id, `${t.test} -t "${t.filter}" passes with the guard removed from ${[...mutated.keys()].join(', ')}; the test no longer pins it`);
      console.log(`ok   ${m.id} (code): ${t.test} fails with the guard removed from ${[...mutated.keys()].join(', ')}`);
    } finally {
      for (const [file, text] of originals) writeFileSync(join(tree, file), text);
    }
  }
}

const selected = catalog.mutants.filter(m => !only || m.id === only);
if (selected.length === 0) { console.error(`no mutant ${only} in ${specName}`); process.exit(2); }
if (!flag('--code-only')) { const tla2tools = jar(); for (const m of selected) runSpec(m, tla2tools); }
if (!flag('--spec-only') && selected.some(m => m.code)) { const tree = scratchCopy(); for (const m of selected) if (m.code) runCode(m, tree); }
if (failures.length) { console.error(`\n${failures.length} mutant check(s) failed; spec/tla/README.md says what each code means.`); process.exit(1); }
console.log(`\nall ${selected.length} mutant(s) behave as catalogued`);
