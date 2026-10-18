/**
 * Large-pages hardening (h), N14-5: a purge removes the segment text an earlier withdrawal and restore left unreferenced.
 *
 * 1. Protects: on a page stored in segments, forget_fact rewrites the fence segment into a new generation without a
 *    version, so the old fence text is held only by a closed manifest row no GC root needs. The post-write sweep of a
 *    later write (restore_page) deletes that row and, because the text is younger than the GC grace window
 *    (SEGMENT_TEXT_GC_GRACE_MS, 1 h), keeps the text unreferenced. `delete_page purge: true` found the page's texts
 *    only through its manifest, so it left that text, holding the withdrawn claim, until the GC. The purge now also
 *    takes every text the page's own stagings recorded (page_body_staging_texts) and deletes those no manifest row
 *    references, in the same transaction. A text a live staging of another write recorded stays (that unpublished
 *    write's copy, the rule for referenced texts); purge_fact aborts a live staging holding the claim, so its texts go.
 * 2. Fails when: right after the purge, before any GC, a row of page_segment_texts still holds the planted claim.
 * 3. A 2 MB conversation page with a facts fence: put_page, forget_fact, delete_page, restore_page, then delete_page
 *    purge:true (the N14 lifecycle) or purge_fact of the claim. Runs on PGLite, and on Postgres when DATABASE_URL is
 *    set. N14 reproduced it at 2 MB, 20 MB and 24 MiB; the orphan is one fence segment at any size, so the 2 MB page
 *    exercises the same path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations } from '../../src/core/operations.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { reconstructedPage, segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const TOKEN = 'quillfeather7731';
const CLAIM = `The lifecycle marker is ${TOKEN}`;
const NEEDLES = ['lphneedleone', 'lphneedletwo', 'lphneedlethree'];
const FENCE = ['', '', '## Facts', '', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  `| 1 | ${CLAIM} | fact | 1.0 | world | low | 2026-10-01 |  | chat |  |`,
  '<!--- gbrain:facts:end -->', ''].join('\n');
const page = (seed: number) => `---\ntitle: Lifecycle chat\ntype: note\n---\n\n${conversationBody(2_000_000, { seed,
  needles: NEEDLES.map((word, i) => ({ at: 0.2 + i * 0.3, word })) })}${FENCE}`;

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

for (const { backend, databaseUrl } of pathologicalArms()) describe(`a purge after forget, delete and restore leaves no segment text (${backend})`, () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-lp-h-'));
  homes.push(home);
  const env = () => ({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => withEnv(env(), async () => {
    if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    await registerLocalWriter(engine, 'cli');
    await engine.setConfig('pages.segmented_storage', 'on');
  }), 120_000);
  afterAll(async () => withEnv(env(), async () => { await disposePersistenceConsumer(engine); await close?.(); }), 120_000);

  const ctx = (): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
    config: { engine: engine.kind, embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } },
    logger: { info() {}, warn() {}, error() {} } } as OperationContext);
  const op = (name: string, params: Record<string, unknown>) => operations.find(o => o.name === name)!.handler(ctx(), params) as Promise<Record<string, any>>;
  const revision = async (slug: string, includeDeleted = false) =>
    (await op('get_page', { slug, body: 'none', ...(includeDeleted ? { include_deleted: true } : {}) })).revision as string;
  /** Texts of the source holding `needle`'s bytes, referenced or not. */
  const textsHolding = async (needle: string) => Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_segment_texts
    WHERE source_id='default' AND position(convert_to($1::text,'UTF8') in body)>0`, [needle]))[0]!.n);
  /** Unreferenced texts the page's stagings recorded: what the purge must not leave. */
  const orphansOf = async (slug: string) => (await engine.executeRaw<{ sha: string }>(`SELECT DISTINCT encode(t.sha256,'hex') AS sha
    FROM page_body_stagings s JOIN page_body_staging_texts r ON r.staging_id=s.id JOIN page_segment_texts t ON t.source_id=r.source_id AND t.sha256=r.sha256
    WHERE s.source_id='default' AND s.slug=$1 AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256)
    ORDER BY 1`, [slug])).map(row => row.sha);

  /** put_page, forget_fact, delete_page, restore_page: leaves the pre-forget fence text unreferenced (N14-5). */
  async function lifecycle(slug: string, seed: number): Promise<{ factId: number; orphans: string[] }> {
    await op('put_page', { slug, content: page(seed), request_id: randomUUID(), wait_ms: 30000 });
    expect((await segmentedPageRow(engine, slug)).body_storage).toBe('segmented');
    const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND strpos(fact,$2)>0', ['default', TOKEN]);
    const factId = Number(fact!.id);
    expect((await op('forget_fact', { id: factId, reason: 'lp-h lifecycle' })).expired).toBe(true);
    expect((await op('delete_page', { slug, request_id: randomUUID(), expected_revision: await revision(slug) })).status).toBe('soft_deleted');
    expect((await op('restore_page', { slug, request_id: randomUUID(), expected_revision: await revision(slug, true) })).status).toBe('restored');
    const orphans = await orphansOf(slug);
    expect(orphans.length).toBeGreaterThan(0);
    expect(await textsHolding(TOKEN)).toBeGreaterThan(0);
    return { factId, orphans };
  }
  /** An unpublished create of another page that deduped onto `sha` (its staging recorded the text). */
  async function holdText(slug: string, sha: string): Promise<string> {
    const [source] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation FROM sources WHERE id='default'`);
    const id = randomUUID();
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      await tx.openBodyStaging({ id, kind: 'put', principalKind: 'application', principalId: 'test:fixture', clientRequestId: randomUUID(),
        sourceId: 'default', sourceIncarnation: source!.incarnation, slug, pageId: null, mode: 'create', baseRevision: null, baseGeneration: null,
        declaredBytes: 16, declaredSha256: null, reservedBytes: 0, idleExpiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) });
      await tx.executeRaw(`INSERT INTO page_body_staging_texts (staging_id, source_id, sha256) VALUES ($1::uuid, 'default', decode($2,'hex'))`, [id, sha]);
    }, TEST_WRITE_ATTRIBUTION));
    return id;
  }
  const stagingState = async (id: string) => (await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id=$1::uuid', [id]))[0]?.state;
  const allTexts = async () => (await engine.executeRaw<{ sha: string }>(`SELECT encode(sha256,'hex') AS sha FROM page_segment_texts WHERE source_id='default' ORDER BY 1`)).map(r => r.sha);
  const textExists = async (sha: string) => (await engine.executeRaw(`SELECT 1 FROM page_segment_texts WHERE source_id='default' AND sha256=decode($1,'hex')`, [sha])).length === 1;

  test('delete_page purge:true deletes the text the restore left unreferenced, in the purge', async () => withEnv(env(), async () => {
    const slug = 'notes/lp-h-page-purge';
    const before = new Set(await allTexts());
    const { orphans } = await lifecycle(slug, 11);
    const purge = await op('delete_page', { slug, purge: true, request_id: randomUUID(), expected_revision: await revision(slug) });
    expect(purge.status).toBe('purged');
    const left = { token: await textsHolding(TOKEN), needles: await Promise.all(NEEDLES.map(textsHolding)), orphans: (await Promise.all(orphans.map(textExists))).filter(Boolean).length };
    console.log(`[lp-h] ${backend} page purge: ${orphans.length} orphan(s) before; after: ${JSON.stringify(left)}`);
    expect(left).toEqual({ token: 0, needles: NEEDLES.map(() => 0), orphans: 0 });
    expect((await allTexts()).filter(sha => !before.has(sha))).toEqual([]);
    expect((purge.receipt.stores as Array<{ store: string; status: string }>).find(s => s.store === 'page_segment_texts')?.status).toBe('deleted');
  }), 600_000);

  test('a text an unpublished write of another page holds survives the page purge; the rest of the page goes', async () => withEnv(env(), async () => {
    const slug = 'notes/lp-h-held', other = 'notes/lp-h-held-create';
    const before = new Set(await allTexts());
    const { orphans } = await lifecycle(slug, 13);
    const held = orphans[0]!;
    const staging = await holdText(other, held);
    const purge = await op('delete_page', { slug, purge: true, request_id: randomUUID(), expected_revision: await revision(slug) });
    expect(purge.status).toBe('purged');
    expect(await stagingState(staging)).toBe('open');
    expect(await textExists(held)).toBe(true);
    expect((await Promise.all(orphans.slice(1).map(textExists))).filter(Boolean)).toHaveLength(0);
    for (const needle of NEEDLES) expect(await textsHolding(needle)).toBe(0);
    expect((await allTexts()).filter(sha => !before.has(sha))).toEqual([held]);
    await engine.executeRaw('DELETE FROM page_body_stagings WHERE id=$1::uuid', [staging]);
    await engine.executeRaw(`DELETE FROM page_segment_texts WHERE source_id='default' AND sha256=decode($1,'hex')`, [held]);
  }), 600_000);

  test('purge_fact of the claim deletes the unreferenced text, aborts a live staging holding it, and the page still reads', async () => withEnv(env(), async () => {
    const slug = 'notes/lp-h-fact-purge', other = 'notes/lp-h-fact-create';
    const { factId, orphans } = await lifecycle(slug, 17);
    const holding = (await engine.executeRaw<{ sha: string }>(`SELECT encode(sha256,'hex') AS sha FROM page_segment_texts WHERE source_id='default'
      AND sha256=ANY(SELECT decode(h,'hex') FROM unnest($1::text[]) AS h) AND position(convert_to($2::text,'UTF8') in body)>0`, [orphans, TOKEN])).map(r => r.sha);
    expect(holding.length).toBeGreaterThan(0);
    const staging = await holdText(other, holding[0]!);
    const dry = await op('purge_fact', { id: factId, dry_run: true });
    const done = await op('purge_fact', { id: factId, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
    expect(done.state).toBe('committed');
    expect(await stagingState(staging)).toBe('aborted');
    expect(await textsHolding(TOKEN)).toBe(0);
    for (const sha of holding) expect(await textExists(sha)).toBe(false);
    const { page: row, body, hash } = await reconstructedPage(engine, slug);
    expect(row.body_storage).toBe('segmented');
    expect(hash).toBe(row.content_hash);
    expect(body.compiled_truth).not.toContain(TOKEN);
    for (const needle of NEEDLES) expect(body.compiled_truth).toContain(needle);
    const read = await op('get_page', { slug, body: 'auto' });
    expect(read.revision).toBe(row.knowledge_revision);
    await engine.executeRaw('DELETE FROM page_body_stagings WHERE id=$1::uuid', [staging]);
  }), 600_000);
});
