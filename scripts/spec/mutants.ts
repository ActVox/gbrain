#!/usr/bin/env bun
/**
 * Guard mutants for the TLA+ specs (spec/tla/README.md). Each mutant in spec/tla/<spec>/mutants.json removes one guard:
 *
 * - its `spec` edit is applied to a copy of the model, and TLC must report the named property (or nothing, for a
 *   mutant marked `survives`: a guard that is defense in depth at these bounds);
 * - its `code` edit, when present, is applied to the implementation, and the named test must fail under it and pass
 *   without it. That ties each guard the model relies on to the line that implements it and the test that pins it.
 *
 *   bun scripts/spec/mutants.ts [<spec>] [--only <id>] [--spec-only | --code-only] [--require-postgres]
 *
 * Failure codes: MUTANT_STALE (an edit's `before` text is not found exactly once: the spec or code moved; update the
 * mutant), MUTANT_SURVIVED (TLC found no violation, or the test passed under the code edit: a property or a test no
 * longer catches the guard), MUTANT_WRONG_PROPERTY, MUTANT_INCOMPLETE (TLC did not finish, or the test failed without
 * the edit), MUTANT_DIRTY (the code file has uncommitted changes; the runner edits it in place and restores it).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Edit { file: string; before: string; after: string }
interface CodeEdit extends Edit { test: string; filter: string; postgres?: boolean }
interface Mutant { id: string; title: string; expect: string; reason?: string; spec: Edit; code?: CodeEdit }
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
    if (clean) return void console.log(`ok   ${m.id}: survives as expected (defense in depth)`);
    if (violated) return fail('MUTANT_WRONG_PROPERTY', m.id, `expected to survive, but ${violated} is violated: the guard is now load-bearing; give it an expect and a code test. Log: ${work}/tlc.log`);
    return fail('MUTANT_INCOMPLETE', m.id, `TLC did not finish (exit ${r.status ?? r.signal}). Log: ${work}/tlc.log`);
  }
  if (violated === m.expect) return void console.log(`ok   ${m.id}: caught by ${violated}`);
  if (violated) return fail('MUTANT_WRONG_PROPERTY', m.id, `expected ${m.expect}, but ${violated} caught it. Log: ${work}/tlc.log`);
  if (clean) return fail('MUTANT_SURVIVED', m.id, `no property caught "${m.title}"; ${m.expect} no longer depends on this guard. Log: ${work}/tlc.log`);
  fail('MUTANT_INCOMPLETE', m.id, `TLC did not finish (exit ${r.status ?? r.signal}). Log: ${work}/tlc.log`);
}

function bunTest(code: CodeEdit): { ok: boolean; tail: string } {
  const r = spawnSync('bun', ['test', '--timeout=300000', code.test, '-t', code.filter], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 600_000 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const ran = /\b[1-9]\d* pass\b|\b[1-9]\d* fail\b/.test(text);
  return { ok: r.status === 0 && ran, tail: text.split('\n').slice(-12).join('\n') };
}

function runCode(m: Mutant): void {
  const code = m.code!;
  if (code.postgres && !process.env.DATABASE_URL) {
    if (flag('--require-postgres')) return fail('MUTANT_INCOMPLETE', m.id, `${code.test} needs DATABASE_URL (a test Postgres)`);
    return void console.log(`skip ${m.id} (code): ${code.test} needs DATABASE_URL`);
  }
  const file = join(ROOT, code.file);
  const dirty = spawnSync('git', ['status', '--porcelain', '--', code.file], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  if (dirty) return fail('MUTANT_DIRTY', m.id, `${code.file} has uncommitted changes; commit or stash them first`);
  const original = readFileSync(file, 'utf8');
  const mutated = applyOnce(original, code);
  if (mutated === null) return fail('MUTANT_STALE', m.id, `code text not found exactly once in ${code.file}: ${JSON.stringify(code.before)}`);
  const base = bunTest(code);
  if (!base.ok) return fail('MUTANT_INCOMPLETE', m.id, `${code.test} -t "${code.filter}" does not pass (or matched no test) without the edit:\n${base.tail}`);
  try {
    writeFileSync(file, mutated);
    const under = bunTest(code);
    if (under.ok) return fail('MUTANT_SURVIVED', m.id, `${code.test} -t "${code.filter}" passes with ${code.file} edited; the test no longer pins this guard`);
    console.log(`ok   ${m.id} (code): ${code.test} fails with the guard removed from ${code.file}`);
  } finally {
    writeFileSync(file, original);
  }
}

const selected = catalog.mutants.filter(m => !only || m.id === only);
if (selected.length === 0) { console.error(`no mutant ${only} in ${specName}`); process.exit(2); }
if (!flag('--code-only')) { const tla2tools = jar(); for (const m of selected) runSpec(m, tla2tools); }
if (!flag('--spec-only')) for (const m of selected) if (m.code) runCode(m);
if (failures.length) { console.error(`\n${failures.length} mutant check(s) failed; spec/tla/README.md says what each code means.`); process.exit(1); }
console.log(`\nall ${selected.length} mutant(s) behave as catalogued`);
