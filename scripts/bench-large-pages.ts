/**
 * Wave B large-page bench: one seeded conversation-like page of `--size`
 * bytes through the streamed segmented import (`pages.segmented_storage` on,
 * embeddings off), on PGLite or Postgres. Prints one JSON summary:
 *
 * - `ingest_ms`: wall time of the streamed import (pass 1, pass 2, staging,
 *   flip, projection), no provider calls.
 * - `rss`: peak RSS of a fresh child process ingesting `--size` and one
 *   ingesting a page 2 MiB over PAGE_MAX_BYTES through the same path, and
 *   their difference (the slope: ingest memory must not grow with the page).
 * - `rows`: distinct segment texts and manifest rows of the live generation, and live chunk rows.
 * - `append_10kb`: time, and the manifest and chunk rows the new generation staged, of re-importing the file with 10 KB
 *   appended (only the tail should be restaged).
 * - `concurrent_small_put`: latency of small page writes (the put_page import
 *   core, `importFromContent`) issued one per event-loop turn, as separate
 *   requests arrive, while the large ingest runs.
 *
 * Run it under a memory cap so a regression fails instead of swapping:
 *   sudo systemd-run --scope -p MemoryMax=3G bun scripts/bench-large-pages.ts --size 100MB
 *   sudo systemd-run --scope -p MemoryMax=3G env DATABASE_URL=postgresql://... bun scripts/bench-large-pages.ts --size 100MB --engine postgres
 * Flags: --size <N>[KB|MB|GB] (default 100MB; above PAGE_MAX_BYTES, where the streamed path starts), --engine pglite|postgres (default pglite; postgres reads DATABASE_URL), --json.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { importStreamedMarkdownFile } from '../src/core/page-body/streamed-import.ts';
import { conversationBody, conversationPage } from '../test/helpers/conversation-page.ts';

const SLUG = 'bench/large-page';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

function parseSize(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB|B)?$/i.exec(raw.trim());
  if (!match) throw new Error(`--size ${raw}: expected a number with KB, MB or GB`);
  const unit = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[(match[2] ?? 'B').toUpperCase() as 'B' | 'KB' | 'MB' | 'GB'];
  return Math.round(Number(match[1]) * unit);
}

async function openEngine(kind: string, dir: string): Promise<BrainEngine> {
  if (kind === 'postgres') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('--engine postgres needs DATABASE_URL (a disposable database: the bench deletes its page).');
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const engine = new PostgresEngine();
    await engine.connect({ database_url: url });
    await engine.initSchema();
    return engine;
  }
  const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: join(dir, 'brain.pglite') });
  await engine.initSchema();
  return engine;
}

async function count(engine: BrainEngine, sql: string, params: unknown[]): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number | string }>(sql, params);
  return Number(row?.n ?? 0);
}

async function pageRows(engine: BrainEngine) {
  const [page] = await engine.executeRaw<{ id: number; body_generation: number | string }>('SELECT id, body_generation FROM pages WHERE slug=$1', [SLUG]);
  if (!page) throw new Error('the bench page was not imported');
  const id = Number(page.id);
  const generation = Number(page.body_generation);
  return {
    generation,
    texts: await count(engine, 'SELECT count(DISTINCT sha256) AS n FROM page_body_manifest WHERE page_id=$1 AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2)', [id, generation]),
    manifest: await count(engine, 'SELECT count(*) AS n FROM page_body_manifest WHERE page_id=$1 AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2)', [id, generation]),
    manifestAtGeneration: await count(engine, 'SELECT count(*) AS n FROM page_body_manifest WHERE page_id=$1 AND gen_from=$2', [id, generation]),
    chunks: await count(engine, 'SELECT count(*) AS n FROM content_chunks WHERE page_id=$1 AND retired_generation IS NULL', [id]),
    chunksAtGeneration: await count(engine, 'SELECT count(*) AS n FROM content_chunks WHERE page_id=$1 AND body_generation=$2', [id, generation]),
  };
}

async function ingest(engine: BrainEngine, file: string) {
  const stat = statSync(file);
  const policy = await readPageBodyPolicy(engine);
  if (stat.size > policy.maxBytes) throw new Error(`--size ${stat.size} is over this engine's ceiling ${policy.maxBytes} (pages.max_bytes).`);
  const result = await importStreamedMarkdownFile(engine, file, `${SLUG}.md`, { noEmbed: true }, stat, policy);
  if (result.status !== 'imported') throw new Error(`the bench page was not imported: ${result.error ?? result.status}`);
  return result;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * This process's own peak RSS. Linux keeps getrusage's maxRSS across execve, so a child spawned by a parent that has
 * ingested a large page reports at least the parent's peak; VmHWM belongs to the new address space.
 */
function peakRssBytes(): number {
  const hwm = existsSync('/proc/self/status') ? /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8')) : null;
  return (hwm ? Number(hwm[1]) : process.resourceUsage().maxRSS) * 1024;
}

/** Child mode: ingest `--file` in a fresh process (the parent generated it) and report its peak RSS. */
async function child(file: string, kind: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-bench-large-'));
  const engine = await openEngine(kind, dir);
  try {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [SLUG]);
    await ingest(engine, file);
    process.stdout.write(JSON.stringify({ peak_rss_bytes: peakRssBytes() }) + '\n');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function childRss(file: string, kind: string): number {
  const run = spawnSync(process.execPath, [import.meta.path, '--child', file, '--engine', kind], { encoding: 'utf8', env: process.env, maxBuffer: 1 << 20 });
  if (run.status !== 0) throw new Error(`child ingest of ${file} failed:\n${run.stderr}`);
  return JSON.parse(run.stdout.trim().split('\n').pop()!).peak_rss_bytes;
}

async function main(): Promise<void> {
  const size = parseSize(arg('--size', '100MB'));
  const kind = arg('--engine', 'pglite');
  if (process.argv.includes('--child')) return child(arg('--child', ''), kind);
  if (size <= PAGE_MAX_BYTES) throw new Error(`--size ${size} is not above PAGE_MAX_BYTES (${PAGE_MAX_BYTES}); smaller files take the single-string import.`);

  const dir = mkdtempSync(join(tmpdir(), 'gbrain-bench-large-'));
  const engine = await openEngine(kind, dir);
  try {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.executeRaw('DELETE FROM pages WHERE slug=$1 OR slug LIKE $2', [SLUG, 'bench/small-%']);
    const file = join(dir, 'page.md');
    writeFileSync(file, conversationPage(size, { seed: 1 }));

    const latencies: number[] = [];
    let ingesting = true;
    const small = (async () => {
      for (let i = 0; ingesting; i++) {
        const t0 = performance.now();
        await importFromContent(engine, `bench/small-${i % 50}`, `---\ntitle: Small ${i}\ntype: note\n---\n\nA short note, revision ${i}.\n`, { sourceId: 'default', noEmbed: true });
        latencies.push(performance.now() - t0);
        await new Promise(resolve => setImmediate(resolve));
      }
    })();
    const t0 = performance.now();
    await ingest(engine, file);
    const ingestMs = performance.now() - t0;
    ingesting = false;
    await small;
    const rows = await pageRows(engine);

    appendFileSync(file, `\n\n${conversationBody(10 * 1024, { seed: 2 })}\n`);
    const t1 = performance.now();
    await ingest(engine, file);
    const appendMs = performance.now() - t1;
    const appended = await pageRows(engine);

    latencies.sort((a, b) => a - b);
    const pct = (p: number) => latencies.length ? round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]!) : null;
    const reference = join(dir, 'page-reference.md');
    writeFileSync(file, conversationPage(size, { seed: 1 }));
    writeFileSync(reference, conversationPage(PAGE_MAX_BYTES + 2 * 1024 * 1024, { seed: 1 }));
    const rssLarge = childRss(file, kind);
    const rssSmall = childRss(reference, kind);
    const report = {
      engine: kind, size_bytes: statSync(file).size, ingest_ms: round(ingestMs),
      rss: { peak_bytes: rssLarge, peak_reference_bytes: rssSmall, slope_bytes: rssLarge - rssSmall },
      rows: { texts: rows.texts, manifest: rows.manifest, chunks: rows.chunks },
      append_10kb: { ms: round(appendMs), manifest: appended.manifestAtGeneration, chunks: appended.chunksAtGeneration },
      concurrent_small_put: { writes: latencies.length, p50_ms: pct(0.5), p95_ms: pct(0.95), max_ms: pct(1) },
    };
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report) + '\n');
    else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
