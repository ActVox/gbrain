/**
 * Owner-phrase precision sample (scripts/owner-phrase-sample.ts,
 * mentions/owner-phrase/sample.ts): the read-only derivation, sampling rule
 * v1, the labeling TSV and the Wilson bound.
 *
 * Protects: the dry run deriving exactly the links the stored pass would
 * write, without writing (it runs inside a READ ONLY transaction and leaves
 * every table unchanged, with `mentions.owner_phrases` off); a sample
 * reproducible from the operator's seed; the refusal below 22 links; stdout
 * carrying counts only. Regression: a sampler that differs from the pass, a
 * sample that changes between runs, or a log line naming a page.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { deriveOwnerPhraseLinks, sampleLinks, scoreLabels, toTsv, wilsonLower, SAMPLE_MIN_POPULATION, TSV_COLUMNS } from '../src/core/mentions/owner-phrase/sample.ts';
import { doc, ownerPhraseLinks, seedOwnerPhraseBrain, sweepOwnerPhrases } from './helpers/owner-phrase-brain.ts';

const dir = mkdtempSync(join(tmpdir(), 'owner-phrase-sample-'));
const brainPath = join(dir, 'brain.pglite');
let engine: PGLiteEngine;

async function counts(e: PGLiteEngine) {
  const [r] = await e.executeRaw<Record<string, number>>(`SELECT (SELECT count(*) FROM links)::int AS links, (SELECT count(*) FROM owner_phrase_windows)::int AS windows,
    (SELECT count(*) FROM owner_phrase_page_state)::int AS states, (SELECT count(*) FROM owner_phrase_status)::int AS status, (SELECT count(*) FROM config)::int AS config`);
  return r;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_path: brainPath } as never);
  await engine.initSchema();
  await seedOwnerPhraseBrain(engine, { enabled: false });
  for (let i = 1; i <= 24; i++) {
    await doc(engine, `notes/call-${String(i).padStart(2, '0')}`, `Call recap: Quill's freight account asked about lane ${i}.`, { date: `2025-05-${String(i + 1).padStart(2, '0')}` });
  }
  await sweepOwnerPhrases(engine);
  await engine.executeRaw("INSERT INTO sources(id, name) VALUES('small-example', 'small-example') ON CONFLICT DO NOTHING");
  await doc(engine, 'notes/small', "Quill's freight account called.", { date: '2025-06-02' });
  await engine.executeRaw("UPDATE pages SET source_id = 'small-example' WHERE slug = 'notes/small'");
}, 180_000);
afterAll(async () => { await engine.disconnect().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

describe('read-only derivation', () => {
  let derivedPairs: string[];
  test('derives inside a READ ONLY transaction with the key off and writes nothing', async () => {
    const before = await counts(engine);
    const derived = await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION READ ONLY');
      return deriveOwnerPhraseLinks(tx, 'default');
    });
    expect(await counts(engine)).toEqual(before);
    expect(before).toMatchObject({ windows: 0, states: 0, status: 0 });
    expect(derived.links.length).toBe(28);
    expect(derived.windows).toBe(6);
    derivedPairs = derived.links.map(l => `${l.doc} -> ${l.account}`);
    const renewal = derived.links.find(l => l.doc === 'notes/renewal')!;
    expect(renewal).toMatchObject({ phrase: "Quill's freight account", line: 1, windows: [{ owner: 'Quill Example', from: '2025-05-01', to: null }],
      evidence: [{ slug: 'updates/acme-handoff', line: 1 }] });
  });

  test('the derived links are exactly the links the stored pass writes once the key is on', async () => {
    await engine.setConfig('mentions.owner_phrases', 'true');
    await sweepOwnerPhrases(engine);
    expect(await ownerPhraseLinks(engine)).toEqual([...derivedPairs].sort());
    await engine.setConfig('mentions.owner_phrases', 'false');
    await sweepOwnerPhrases(engine);
    expect(await ownerPhraseLinks(engine)).toEqual([]);
  });
});

describe('sampling rule v1, TSV and scoring', () => {
  test('a seed reproduces the sample; another seed reorders it; n caps it', async () => {
    const { links } = await deriveOwnerPhraseLinks(engine, 'default');
    const a = sampleLinks(links, 'seed-a', 10).map(l => l.doc);
    expect(sampleLinks(links, 'seed-a', 10).map(l => l.doc)).toEqual(a);
    expect(sampleLinks(links, 'seed-b', 10).map(l => l.doc)).not.toEqual(a);
    expect(sampleLinks(links, 'seed-a', 100)).toHaveLength(links.length);
    expect(sampleLinks([...links].reverse(), 'seed-a', 10).map(l => l.doc)).toEqual(a);
  });

  test('the TSV has the labeling columns and one row per sampled link; labels score with a Wilson 95% lower bound', async () => {
    const { links } = await deriveOwnerPhraseLinks(engine, 'default');
    const tsv = toTsv(sampleLinks(links, 's', 3).map(l => ({ ...l, excerpt: 'line\twith tab' })));
    const rows = tsv.split('\n').filter(Boolean).map(r => r.split('\t'));
    expect(rows[0]).toEqual([...TSV_COLUMNS]);
    expect(rows.slice(1).every(r => r.length === TSV_COLUMNS.length && r[3] === 'line with tab')).toBe(true);
    const labeled = [rows[0]!.join('\t'), ...rows.slice(1).map((r, i) => [...r.slice(0, 7), i === 2 ? 'n' : 'y'].join('\t'))].join('\n');
    expect(scoreLabels(labeled)).toMatchObject({ labeled: 3, correct: 2, wrong: 1, unlabeled: 0 });
    expect(wilsonLower(57, 60)).toBeGreaterThanOrEqual(0.85);
    expect(wilsonLower(56, 60)).toBeLessThan(0.85);
    expect(wilsonLower(92, 100)).toBeGreaterThanOrEqual(0.85);
    expect(wilsonLower(91, 100)).toBeLessThan(0.85);
  });
});

describe('scripts/owner-phrase-sample.ts', () => {
  const run = (args: string[]) => Bun.spawnSync(['bun', 'scripts/owner-phrase-sample.ts', '--pglite', brainPath, ...args], { cwd: join(import.meta.dir, '..'), env: { ...process.env, GBRAIN_HOME: dir } });

  test('writes the sample to the named path; stdout names no page; a repeat with the same seed is byte-identical', async () => {
    await engine.disconnect();
    const out = join(dir, 'sample.tsv');
    const first = run(['--out', out, '--seed', 'operator-seed', '--n', '25']);
    expect(first.exitCode).toBe(0);
    const stdout = first.stdout.toString() + first.stderr.toString();
    const summary = JSON.parse(first.stdout.toString().trim().split('\n').at(-1)!);
    expect(summary).toMatchObject({ rule: 'owner-phrase-sample-v1', population: 28, sample: 25, windows: 6 });
    expect(stdout).not.toMatch(/notes\/|companies\/|Quill|Rowan|Juniper|freight/);
    const tsv = readFileSync(out, 'utf8');
    expect(tsv.trim().split('\n')).toHaveLength(26);
    expect(run(['--out', out, '--seed', 'operator-seed', '--n', '25']).exitCode).toBe(3);
    expect(run(['--out', out, '--seed', 'operator-seed', '--n', '25', '--force']).exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(tsv);
    const all = run(['--out', join(dir, 'all.tsv'), '--seed', 'operator-seed', '--n', '25', '--source', 'all']);
    expect(all.exitCode).toBe(0);
    expect(JSON.parse(all.stdout.toString().trim().split('\n').at(-1)!)).toMatchObject({ population: 28, sample: 25 });
  }, 120_000);

  test(`refuses below ${SAMPLE_MIN_POPULATION} links and writes nothing`, async () => {
    const out = join(dir, 'small.tsv');
    const r = run(['--out', out, '--seed', 'x', '--source', 'small-example']);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stdout.toString().trim().split('\n').at(-1)!)).toMatchObject({ population: 0 });
    expect(() => readFileSync(out)).toThrow();
  }, 120_000);
});
