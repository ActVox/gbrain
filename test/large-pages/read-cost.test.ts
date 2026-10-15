/**
 * Wave B PR 2 (spec 7.2, 13 "PR 2" tests): a get_page read of a segmented page
 * costs the size of what it returns, not the size of the page.
 *
 * 1. Protects: body: 'none', the first outline page and a 40 KB window in the
 *    middle of a 10 MB and a 40 MB page take about the same CPU (median ratio
 *    of best-of-runs below 1.3; Wave A's whole-document path is about 4x), and
 *    a window reads at most the window plus two segments of segment text.
 * 2. Fails when: a read materializes or projects the whole body (Wave A's
 *    readPageDocument / pageOutline over the full text), the line count reads
 *    every segment, or a window loads segments it does not cut from.
 * 3. PGLite only: PGLite runs its SQL on the calling thread, so thread CPU
 *    counts the database work too.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { cpuMsAsync } from '../helpers/cpu-time.ts';

const getPage = operations.find(o => o.name === 'get_page')!;
const WINDOW = 40_000;
const REPEAT = 20;
let engine: PGLiteEngine;
let dir: string;

/** About `bytes` of a conversation log: a dated heading every ~16 KB, then lines. */
function log(bytes: number): string {
  const parts: string[] = ['---\ntitle: Read cost\ntype: note\n---\n'];
  let size = 0;
  for (let day = 0; size < bytes; day++) {
    const head = `## Day ${day} 2024-${String(1 + (day % 12)).padStart(2, '0')}-${String(1 + (day % 28)).padStart(2, '0')}\n\n`;
    parts.push(head);
    size += head.length;
    for (let i = 0; i < 160; i++) {
      const line = `- ${day}.${i} alice-example asked acme-example about the widget plan and the shipping date\n`;
      parts.push(line);
      size += line.length;
    }
  }
  return parts.join('');
}

const remote = (): OperationContext => ({ engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true,
  transport: 'http', sourceId: 'default', auth: { token: 'fixture', clientId: 'read-cost', principal: { kind: 'oauth_client', id: 'read-cost' }, scopes: ['read'],
    sourceId: 'default', allowedSources: ['default'] } } as unknown as OperationContext);
const get = async (params: Record<string, unknown>) => await getPage.handler(remote(), params) as Record<string, any>;

/** cpuScalingRatio for async spans: median over rounds of best-of-runs large / best-of-runs small, after a warm-up of each. */
async function asyncScalingRatio(small: () => Promise<unknown>, large: () => Promise<unknown>, rounds = 5, runs = 3): Promise<number> {
  await small();
  await large();
  const best = async (fn: () => Promise<unknown>) => {
    let ms = Infinity;
    for (let k = 0; k < runs; k++) ms = Math.min(ms, await cpuMsAsync(fn));
    return ms;
  };
  const ratios: number[] = [];
  for (let r = 0; r < rounds; r++) ratios.push(await best(large) / await best(small));
  return ratios.sort((a, b) => a - b)[Math.floor(rounds / 2)]!;
}

describe('segmented get_page read cost', () => {
  const pages = { small: { slug: 'logs/read-cost-10mb', bytes: 10_000_000, size: 0 }, large: { slug: 'logs/read-cost-40mb', bytes: 40_000_000, size: 0 } };

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('pages.segmented_storage', 'on');
    dir = mkdtempSync(join(tmpdir(), 'gb-read-cost-'));
    for (const page of Object.values(pages)) {
      // The 40 MB page is over the single-string ceiling: it streams in from a file.
      const file = join(dir, 'page.md');
      writeFileSync(file, log(page.bytes));
      expect((await importFromFile(engine, file, `${page.slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).status).toBe('imported');
      const none = await get({ slug: page.slug, body: 'none' });
      expect(none.body_storage).toBe('segmented');
      page.size = none.size.total_bytes;
    }
  }, 600_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const reads: Array<[string, (slug: string, size: number) => Record<string, unknown>]> = [
    ['body none', () => ({ body: 'none' })],
    ['the first outline page', () => ({ body: 'outline' })],
    ['a window in the middle', (_slug, size) => ({ body: 'window', bytes: { offset: Math.floor(size / 2), length: WINDOW } })],
  ];
  for (const [name, params] of reads) {
    test(`${name}: 40 MB costs about what 10 MB costs`, async () => {
      // Thread CPU ticks at a few ms, so one sample is REPEAT reads.
      const read = (page: typeof pages.small) => async () => { for (let i = 0; i < REPEAT; i++) await get({ slug: page.slug, ...params(page.slug, page.size) }); };
      const ratio = await asyncScalingRatio(read(pages.small), read(pages.large));
      expect(ratio).toBeLessThan(1.3);
    }, 300_000);
  }

  test('a window reads at most the window plus two segments of segment text', async () => {
    const [largest] = await engine.executeRaw<{ n: unknown }>(`SELECT max(m.byte_len) AS n FROM page_body_manifest m JOIN pages p ON p.id = m.page_id WHERE p.slug = $1`, [pages.large.slug]);
    const segment = Number(largest!.n);
    const original = engine.readSegmentTexts.bind(engine);
    let bytes = 0;
    engine.readSegmentTexts = async (sourceId, hashes) => {
      const texts = await original(sourceId, hashes);
      for (const text of texts.values()) bytes += text.byteLength;
      return texts;
    };
    try {
      for (const at of [0.1, 0.5, 0.97]) {
        await get({ slug: pages.large.slug, body: 'none' });
        bytes = 0;
        const r = await get({ slug: pages.large.slug, body: 'window', bytes: { offset: Math.floor(pages.large.size * at), length: WINDOW } });
        expect(Buffer.byteLength(r.window.text)).toBeGreaterThan(WINDOW / 2);
        expect(bytes).toBeLessThanOrEqual(WINDOW + 2 * segment);
      }
    } finally {
      engine.readSegmentTexts = original;
    }
  }, 120_000);
});
