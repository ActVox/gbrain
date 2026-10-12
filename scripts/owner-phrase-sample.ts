#!/usr/bin/env bun
/**
 * Owner-phrase precision sample (docs/guides/owner-phrases.md, "Precision
 * sample"). Read-only: derives the owner-phrase windows and links the pass
 * would store for one source of the configured brain (or a PGLite copy given
 * with --pglite), inside a READ ONLY transaction, with no model or network
 * calls, then writes a labeling TSV of a reproducible sample to the path the
 * operator names. stdout carries counts only, never page names or text.
 *
 *   bun scripts/owner-phrase-sample.ts --out <file.tsv> --seed <seed> [--source <id>] [--n 100] [--pglite <dir>] [--force]
 *   bun scripts/owner-phrase-sample.ts --score <labeled.tsv>
 *
 * Exit codes: 0 written (or scored), 1 usage or runtime error, 3 refused
 * (fewer than 22 derivable links, or --out exists without --force).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { EngineConfig } from '../src/core/types.ts';
import {
  deriveOwnerPhraseLinks, lineExcerpt, sampleLinks, scoreLabels, toTsv, SAMPLE_DEFAULT_SIZE, SAMPLE_MIN_POPULATION, SAMPLE_RULE,
} from '../src/core/mentions/owner-phrase/sample.ts';

const USAGE = 'usage: bun scripts/owner-phrase-sample.ts --out <file.tsv> --seed <seed> [--source <id>] [--n 100] [--pglite <dir>] [--force]\n'
  + '       bun scripts/owner-phrase-sample.ts --score <labeled.tsv>';
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (code: number, message: string): never => { console.error(message); process.exit(code); };

if (flag('--score')) {
  console.log(JSON.stringify({ rule: SAMPLE_RULE, ...scoreLabels(readFileSync(flag('--score')!, 'utf8')) }));
  process.exit(0);
}
const out = flag('--out');
const seed = flag('--seed');
if (!out || !seed) fail(1, USAGE);
const n = Number(flag('--n') ?? SAMPLE_DEFAULT_SIZE);
if (!Number.isInteger(n) || n < 1) fail(1, `--n must be a positive integer\n${USAGE}`);
if (existsSync(out!) && !args.includes('--force')) fail(3, 'refused: --out already exists; pass --force to replace it');
const sourceId = flag('--source') ?? 'default';

let engineConfig: EngineConfig;
if (flag('--pglite')) engineConfig = { engine: 'pglite', database_path: flag('--pglite') } as EngineConfig;
else {
  const config = loadConfig();
  if (!config) fail(1, 'No GBrain config found. Pass --pglite <brain directory copy>, or run from a machine with a configured brain.');
  engineConfig = toEngineConfig(config!);
}
const engine = await createEngine(engineConfig);
await engine.connect(engineConfig);
let code = 0;
try {
  const result = await engine.transaction(async tx => {
    await tx.executeRaw('SET TRANSACTION READ ONLY');
    const derived = await deriveOwnerPhraseLinks(tx, sourceId);
    if (derived.links.length < SAMPLE_MIN_POPULATION) return { refused: true as const, derived };
    const sample = sampleLinks(derived.links, seed!, n);
    const pages = new Map((await tx.executeRaw<{ slug: string; title: string | null; compiled_truth: string | null; timeline: string | null }>(
      'SELECT slug, title, compiled_truth, timeline FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])',
      [sourceId, [...new Set(sample.map(s => s.doc))]])).map(p => [p.slug, p]));
    return { refused: false as const, derived, rows: sample.map(s => ({ ...s, excerpt: pages.has(s.doc) ? lineExcerpt(pages.get(s.doc)!, s.line) : '' })) };
  });
  const counts = { rule: SAMPLE_RULE, seed_sha256: createHash('sha256').update(seed!).digest('hex').slice(0, 16), source: sourceId,
    pages: result.derived.pages, windows: result.derived.windows, population: result.derived.links.length,
    unresolved: result.derived.unresolved, ambiguous: result.derived.ambiguous };
  if (result.refused) {
    console.log(JSON.stringify({ ...counts, refused: `fewer than ${SAMPLE_MIN_POPULATION} owner-phrase links derivable; no sample written` }));
    code = 3;
  } else {
    writeFileSync(out!, toTsv(result.rows), { mode: 0o600 });
    console.log(JSON.stringify({ ...counts, sample: result.rows.length, out }));
  }
} catch (error) {
  console.error(`owner-phrase sample failed: ${error instanceof Error ? error.message : String(error)}`);
  code = 1;
} finally {
  await engine.disconnect();
}
process.exit(code);
