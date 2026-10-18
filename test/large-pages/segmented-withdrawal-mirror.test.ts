/**
 * Switch-on blocker 1: a withdrawal mirrors a segmented page into its canonical file.
 *
 * 1. Protects: on a managed, file-backed source with `pages.segmented_storage` on, purge_fact (and forget_fact) of a
 *    claim in a segmented page's facts fence rewrites the page's canonical file as the inline twin's is rewritten: the
 *    file loses the purged claim (or shows the row forgotten) and keeps everything else, its bytes are the page's
 *    streamed export (the serializer the inline path uses, over the segments), and the withdrawal's Git effect commits
 *    it as the inline twin's is committed (for a purge, under the purge's subject).
 *    The file is produced from the segments in pieces: every piece the mirror reads or stages is at most one segment
 *    (`largeFileWork`), and the bytes it stages are exactly the file's. Its recovery record names the staged file by
 *    path and digest instead of embedding it, and a mirror interrupted before or after writing that stage recovers
 *    forward: the stage is written from the segments, or the written one renamed, exactly once.
 *    A facts fence longer than a segment (split by forced cuts) is mirrored joined, after a source withdrawal applies. A
 *    stage the filesystem refuses (EIO) leaves no record behind: other writes on the worktree proceed and the mirror
 *    retries, then parks after its attempts. The mirror renders the file only when it has a file to rewrite, the Git
 *    walk never renders it, and the claim is renewed between the pieces (`largeFileWork.bytesMeasured`,
 *    `effectClaimWork.renewals`, counts not time).
 * 2. Fails when: the withdrawal-mirror effect skips a segmented page (`page_body_segmented`) and leaves the purged claim
 *    on disk, the Git walk skips it, the mirror renders the body as one string (nothing staged in pieces), the record
 *    embeds the file or reserves it twice, or recovery cannot finish an interrupted mirror; a cross-cut fence parks the
 *    mirror (`page_projection_stale`); a refused stage keeps its record (writes on the worktree stay pending and the
 *    mirror never parks); the Git walk or a mirror of a missing file measures the file; no renewal happens mid-stream.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). The switch is off for the inline
 *    twin's writes and on for the segmented twin's. The interruptions are modelled at the `effect_recovery:before_stage`
 *    and `effect_recovery:staged` seams (fault-points.ts) with a hook that throws once; the EIO at
 *    `large_file:stage_streaming`.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { exportBodyLedger, readExportPage, readExportWithdrawals, segmentedExportMarkdown } from '../../src/core/export-snapshot.ts';
import { buildEmbedSkipMarker, EMBED_SKIP_KEY } from '../../src/core/embed-skip.ts';
import { serializeMarkdown, slugStampedFrontmatter } from '../../src/core/markdown.ts';
import { buildContentFlagMarker, CONTENT_FLAG_KEY } from '../../src/core/quarantine.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { __setEffectRenewalIntervalForTests, runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { effectClaimWork } from '../../src/core/persistence/effect-journal.ts';
import { PARK_AFTER_FAILURES } from '../../src/core/persistence/effect-model.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { largeFileWork } from '../../src/core/persistence/large-file.ts';
import { durableGitRepo, gitAsync } from '../helpers/git-publication.ts';
import { withManagedFixtureWrite } from '../helpers/managed-e2e-fixture-write.ts';
import { openTwinBrain, type TwinBrain } from '../helpers/segmented-twins.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { withEnv } from '../helpers/with-env.ts';

const INLINE = 'people/ina-example';
const SEGMENTED = 'people/sei-example';
/** Each twin's claim has its own fingerprint, so one twin's purge never reaches the other's rows or effects. */
const CLAIMS: Record<string, string> = { [INLINE]: 'Twin Example locker code is 3306', [SEGMENTED]: 'Twin Example locker code is 7781' };
/** Each twin's claim that forget_fact withdraws (the row stays in the fence, marked forgotten). */
const FORGOTTEN: Record<string, string> = { [INLINE]: 'Twin Example bike lock is 5150', [SEGMENTED]: 'Twin Example bike lock is 8462' };
const KEPT = 'Twin Example adopted a narwhalbot';
/** The claim each modelled interruption's purge removes. */
const CRASH_CLAIMS = { 'effect_recovery:before_stage': 'Twin Example vault code is 1902', 'effect_recovery:staged': 'Twin Example vault code is 6640' };
/** The claims of the mid-stream death and of the partial stage left at the reserved name. */
const STREAM_CLAIM = 'Twin Example vault code is 2718';
const PARTIAL_CLAIM = 'Twin Example vault code is 3141';
/** The claim purged from a page the content gate marked in the database only. */
const MARKED_CLAIM = 'Twin Example safe code is 6022';
/** A page whose one facts fence is longer than a segment, so the segmenter splits it with forced cuts. */
const CROSS_CUT = 'people/cuts-example';
const CROSS_CLAIM = 'Twin Example gate code is 4410';
const CROSS_KEPT = 'Routine note number 10999 about the weekly planning meeting';
/** The claims whose mirror stage the filesystem refuses (EIO) once, and on every attempt. */
const EIO_ONCE = 'Twin Example vault code is 5021';
const EIO_ALWAYS = 'Twin Example vault code is 5022';
const OTHER = 'people/oth-example';
/** The claim of the bounded-work mirror, and the page whose canonical file is gone before its purge (and its claim). */
const BOUND_CLAIM = 'Twin Example vault code is 7310';
const RENEW_CLAIM = 'Twin Example vault code is 7312';
const GONE = 'people/gone-example';
const GONE_CLAIM = 'Twin Example vault code is 7311';
const eio = () => Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO', errno: -5, syscall: 'write' });
const factRow = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
const crossCutPage = () => {
  const rows = Array.from({ length: 11_000 }, (_, i) => factRow(i + 1, `Routine note number ${i} about the weekly planning meeting`));
  rows.splice(5_500, 0, factRow(11_001, CROSS_CLAIM));
  return '---\ntype: person\ntitle: Twin Example\n---\n\n# Twin Example\n\nA page whose facts fence is longer than a segment.\n\n'
    + '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
    + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n' + rows.join('\n') + '\n<!--- gbrain:facts:end -->\n';
};

const fileOf = (brain: TwinBrain, slug: string) => join(brain.root, slug + '.md');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** A twin's file as `view` neutralizes it, with its own forgotten claim (the twins' only differing text) neutralized too. */
const twinFile = async (brain: TwinBrain, slug: string) => String((await brain.view(slug)).file).split(FORGOTTEN[slug]!).join('<forgotten>');
/**
 * Records every whole-file `readFileSync` of `path` made from the persistence layer (the mirror and Git effects, their
 * drift checks and recovery), with the call's stack as evidence. The purge's own residual scan (facts/purge-verify.ts)
 * is outside it.
 */
function watchWholeReads(path: string) {
  const original = fs.readFileSync;
  const hits: string[] = [];
  const spy = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const stack = new Error().stack ?? '';
    if (String(args[0]) === path && stack.includes('/src/core/persistence/')) hits.push(stack.split('\n').slice(1, 4).join(' | '));
    return original(...args);
  }) as typeof fs.readFileSync);
  return { hits, restore: () => spy.mockRestore() };
}
const resetWork = () => { for (const key of Object.keys(largeFileWork) as (keyof typeof largeFileWork)[]) largeFileWork[key] = 0; };
/** Staging leftovers (hidden `.<sha>.tmp.<uuid>` siblings) next to the twins' files. */
const stagingLeft = (brain: TwinBrain) => readdirSync(join(brain.root, 'people')).filter(name => name.includes('.tmp.'));

/**
 * Runs effect passes on this host until the source's mirror and Git effects have all settled; the persistence consumer
 * runs them too, so a claim it holds settles meanwhile. Past the deadline the assertions report the effects' state.
 */
const settle = (brain: TwinBrain, kind: 'pglite' | 'postgres', beforePass?: () => Promise<void>) => waitFor(async () => {
  await beforePass?.();
  const [open] = await brain.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects
    WHERE source_id=$1 AND kind IN ('withdrawal-mirror','git') AND (state<>'committed' OR recovery IS NOT NULL)`, [brain.sourceId]);
  if (!open!.n) return true;
  await withEnv(brain.env(), async () => {
    await brain.engine.executeRaw(`UPDATE persistence_effects SET next_attempt_at=now() WHERE source_id=$1 AND state='queued'`, [brain.sourceId]);
    await runPersistenceEffects(brain.engine, { engine: kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 });
  });
  return false;
}, { timeoutMs: 120_000, intervalMs: 100, label: 'the mirror and Git effects settled' }).catch(() => undefined);

/** The page's export, streamed as `gbrain export` streams a segmented page (export.ts), concatenated here only to compare. */
const exported = (brain: TwinBrain, slug: string) => brain.engine.transaction(async tx => {
  const [key] = await tx.executeRaw<{ id: string; source_id: string; slug: string }>(
    'SELECT id::text AS id, source_id, slug FROM pages WHERE source_id=$1 AND slug=$2', [brain.sourceId, slug]);
  const withdrawals = await readExportWithdrawals(tx, brain.sourceId);
  const { page, tags } = await readExportPage(tx, key!, withdrawals);
  const head = serializeMarkdown(slugStampedFrontmatter(page.slug, page.frontmatter ?? {}), '', '', { type: page.type, title: page.title, tags }).slice(0, -1);
  const parts: Buffer[] = [];
  for await (const piece of segmentedExportMarkdown(tx, page, exportBodyLedger(page.slug, withdrawals), head)) parts.push(Buffer.from(piece));
  return Buffer.concat(parts);
});

const effectsOf = async (brain: TwinBrain, requestId: string) => (await brain.engine.executeRaw<{ kind: string; state: string; error_code: string | null; data: any }>(
  `SELECT e.kind, e.state, e.error_code, e.data FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE r.request_id=$1::uuid AND e.kind IN ('withdrawal-mirror','git') ORDER BY e.kind`, [requestId]))
  .map(e => ({ kind: e.kind, state: e.state, error: e.error_code, skipped: (typeof e.data === 'string' ? JSON.parse(e.data) : e.data)?.skipped ?? [] }));
const SETTLED = [{ kind: 'git', state: 'committed', error: null, skipped: [] }, { kind: 'withdrawal-mirror', state: 'committed', error: null, skipped: [] }];

async function purge(brain: TwinBrain, kind: 'pglite' | 'postgres', slug: string, claim: string, beforePass?: () => Promise<void>) {
  const [fact] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3', [brain.sourceId, slug, claim]);
  const dry = await brain.call('purge_fact', { id: Number(fact!.id), dry_run: true }, slug);
  expect(dry.confirm_token).toBeString();
  const requestId = randomUUID();
  const done = await brain.call('purge_fact', { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: requestId }, slug);
  expect(done.state).toBe('committed');
  await settle(brain, kind, beforePass);
  return { requestId, hash8: String(done.purge.hash8) };
}

async function extract(brain: TwinBrain, slug: string, facts: string[]) {
  brain.setChatReply(JSON.stringify({ facts: facts.map(fact => ({ fact, kind: 'fact', entity: slug, confidence: 1, notability: 'high' })) }));
  expect(await brain.call('extract_facts', { turn_text: 'Synthetic meeting record. ' + facts.join('. ') + '.', visibility: 'world', valid_from: '2026-10-15T00:00:00Z' }, slug))
    .toMatchObject({ inserted: facts.length });
}

for (const kind of testBackends()) {
  describe(kind + ': a withdrawal mirrors a segmented page into its canonical file', () => {
    let brain: TwinBrain;

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [INLINE], async seed => {
        await seed.setSwitch(false);
        await seed.put(INLINE, 1_100_000);
        await seed.setSwitch(true);
        await seed.put(SEGMENTED, 1_100_000);
      });
      for (const slug of [INLINE, SEGMENTED]) await extract(brain, slug, [CLAIMS[slug]!, FORGOTTEN[slug]!, KEPT]);
      expect([await brain.storageOf(INLINE), await brain.storageOf(SEGMENTED)]).toEqual(['inline', 'segmented']);
      await settle(brain, kind);
      // The checkout becomes a durability-hardened repository holding both files, so each purge's Git effect commits for real.
      durableGitRepo(brain.root, [INLINE + '.md', SEGMENTED + '.md']);
    }, 600_000);

    afterAll(() => brain.close(), 120_000);

    test('purge_fact rewrites the segmented file without the claim, as the inline twin\'s, streamed and committed', async () => {
      for (const slug of [INLINE, SEGMENTED]) expect(readFileSync(fileOf(brain, slug), 'utf8')).toContain(CLAIMS[slug]!);

      const inline = await purge(brain, kind, INLINE, CLAIMS[INLINE]!);
      resetWork();
      const reads = watchWholeReads(fileOf(brain, SEGMENTED));
      let segmented: Awaited<ReturnType<typeof purge>>;
      try { segmented = await purge(brain, kind, SEGMENTED, CLAIMS[SEGMENTED]!); } finally { reads.restore(); }
      const wholeReads = reads.hits;
      const work = { ...largeFileWork };

      // Neither twin's mirror or Git walk passed its page by: both effects committed with nothing skipped.
      expect(await effectsOf(brain, segmented.requestId)).toEqual(await effectsOf(brain, inline.requestId));
      expect(await effectsOf(brain, segmented.requestId)).toEqual(SETTLED);

      // The file lost the purged claim, kept the rest, and is the inline twin's file and the page's streamed export.
      const file = readFileSync(fileOf(brain, SEGMENTED));
      expect(file.toString('utf8')).not.toContain(CLAIMS[SEGMENTED]!);
      expect(file.toString('utf8')).toContain(KEPT);
      expect(await twinFile(brain, SEGMENTED)).toBe(await twinFile(brain, INLINE));
      expect(file.equals(await exported(brain, SEGMENTED))).toBe(true);
      expect(stagingLeft(brain)).toEqual([]);

      // Git: each twin's file is committed by its purge's Git effect, under the purge's subject, and nothing is left dirty.
      for (const [slug, receipt] of [[INLINE, inline], [SEGMENTED, segmented]] as const) {
        expect((await gitAsync(brain.root, 'log', '-1', '--format=%s', '--', slug + '.md')).trim()).toBe(`gbrain: purge fact ${receipt.hash8}`);
        expect(await gitAsync(brain.root, 'status', '--porcelain', '--', slug + '.md')).toBe('');
        expect(await gitAsync(brain.root, 'show', `HEAD:${slug}.md`)).toBe(readFileSync(fileOf(brain, slug), 'utf8'));
      }

      // Streamed: the mirror staged exactly the file's bytes, and no piece it read or wrote was over one segment. The
      // canonical file itself (the drift check before the overwrite, about 1.1 MB) is read in pieces too, never whole.
      expect(wholeReads).toEqual([]);
      expect(work.bytesWritten).toBe(file.length);
      expect(work.bytesRead).toBeGreaterThanOrEqual(work.bytesWritten);
      expect(work.largestPiece).toBeGreaterThan(0);
      expect(work.largestPiece).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    }, 600_000);

    test('forget_fact rewrites the segmented file with the row withdrawn, as the inline twin\'s, and commits it', async () => {
      const before = { [INLINE]: readFileSync(fileOf(brain, INLINE), 'utf8'), [SEGMENTED]: readFileSync(fileOf(brain, SEGMENTED), 'utf8') };
      const receipts: Record<string, string> = {};
      const reads = watchWholeReads(fileOf(brain, SEGMENTED));
      try { for (const slug of [INLINE, SEGMENTED]) {
        const [fact] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3', [brain.sourceId, slug, FORGOTTEN[slug]]);
        receipts[slug] = randomUUID();
        expect(await brain.call('forget_fact', { id: Number(fact!.id), request_id: receipts[slug] }, slug)).toMatchObject({ state: 'committed' });
        if (slug === INLINE) resetWork();
        await settle(brain, kind);
      } } finally { reads.restore(); }
      const wholeReads = reads.hits;
      const work = { ...largeFileWork };

      expect(await effectsOf(brain, receipts[SEGMENTED]!)).toEqual(await effectsOf(brain, receipts[INLINE]!));
      expect(await effectsOf(brain, receipts[SEGMENTED]!)).toEqual(SETTLED);
      const file = readFileSync(fileOf(brain, SEGMENTED));
      expect(file.toString('utf8')).not.toBe(before[SEGMENTED]);
      expect(readFileSync(fileOf(brain, INLINE), 'utf8')).not.toBe(before[INLINE]);
      expect(await twinFile(brain, SEGMENTED)).toBe(await twinFile(brain, INLINE));
      expect(file.equals(await exported(brain, SEGMENTED))).toBe(true);
      expect(stagingLeft(brain)).toEqual([]);
      for (const slug of [INLINE, SEGMENTED]) {
        expect(await gitAsync(brain.root, 'status', '--porcelain', '--', slug + '.md')).toBe('');
        expect(await gitAsync(brain.root, 'show', `HEAD:${slug}.md`)).toBe(readFileSync(fileOf(brain, slug), 'utf8'));
      }
      expect(wholeReads).toEqual([]);
      expect(work.bytesWritten).toBe(file.length);
      expect(work.largestPiece).toBeGreaterThan(0);
      expect(work.largestPiece).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    }, 600_000);
  });

  describe(kind + ': a withdrawal mirrors a segmented page the content gate marked in the database only', () => {
    let brain: TwinBrain;

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [], async seed => {
        await seed.setSwitch(true);
        await seed.put(SEGMENTED, 1_100_000);
      });
      await extract(brain, SEGMENTED, [MARKED_CLAIM, KEPT]);
      expect(await brain.storageOf(SEGMENTED)).toBe('segmented');
      await settle(brain, kind);
      // The content gate's assessments are database state an import stamps (import-screen.ts), never written to the file.
      const markers = { [EMBED_SKIP_KEY]: buildEmbedSkipMarker(1_100_000), [CONTENT_FLAG_KEY]: buildContentFlagMarker('markup_heavy', 'synthetic assessment') };
      await withManagedFixtureWrite(brain.engine, [brain.sourceId], tx => tx.executeRaw('UPDATE pages SET frontmatter=frontmatter||$3::text::jsonb WHERE source_id=$1 AND slug=$2', [brain.sourceId, SEGMENTED, JSON.stringify(markers)]));
    }, 600_000);

    afterAll(() => brain.close(), 120_000);

    test('purge_fact rewrites the file without the claim instead of reading the markers as drift', async () => {
      const [row] = await brain.engine.executeRaw<{ frontmatter: Record<string, unknown> }>('SELECT frontmatter FROM pages WHERE source_id=$1 AND slug=$2', [brain.sourceId, SEGMENTED]);
      expect(Object.keys(row!.frontmatter)).toEqual(expect.arrayContaining([EMBED_SKIP_KEY, CONTENT_FLAG_KEY]));
      const before = readFileSync(fileOf(brain, SEGMENTED), 'utf8');
      expect(before).toContain(MARKED_CLAIM);
      expect(before).not.toContain(EMBED_SKIP_KEY);
      expect(before).not.toContain(CONTENT_FLAG_KEY);

      const receipt = await purge(brain, kind, SEGMENTED, MARKED_CLAIM);
      expect(await effectsOf(brain, receipt.requestId)).toEqual(SETTLED);
      const file = readFileSync(fileOf(brain, SEGMENTED));
      expect(file.toString('utf8')).not.toContain(MARKED_CLAIM);
      expect(file.toString('utf8')).toContain(KEPT);
      expect(file.equals(await exported(brain, SEGMENTED))).toBe(true);
      expect(stagingLeft(brain)).toEqual([]);
    }, 600_000);
  });

  describe(kind + ': a withdrawal mirrors a segmented page whose facts fence crosses a forced cut', () => {
    let brain: TwinBrain;

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [], async seed => { await seed.setSwitch(true); });
      expect(await brain.call('put_page', { slug: CROSS_CUT, content: crossCutPage() })).toMatchObject({ state: 'committed' });
      expect(await brain.storageOf(CROSS_CUT)).toBe('segmented');
      await settle(brain, kind);
    }, 600_000);

    afterAll(() => brain.close(), 120_000);

    test('purge_fact rewrites the file without the claim, the fence joined across the cut as discovery joins it', async () => {
      // The fence runs on across at least one forced cut (a facts slot that opens in one segment and closes in a later one).
      const [split] = await brain.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_manifest m JOIN pages p ON p.id=m.page_id,
        jsonb_array_elements(m.facts_slots) s WHERE p.source_id=$1 AND p.slug=$2 AND m.gen_to IS NULL AND s ? 'open_start'`, [brain.sourceId, CROSS_CUT]);
      expect(split!.n).toBeGreaterThan(1);
      expect(readFileSync(fileOf(brain, CROSS_CUT), 'utf8')).toContain(CROSS_CLAIM);

      const receipt = await purge(brain, kind, CROSS_CUT, CROSS_CLAIM);
      expect(await effectsOf(brain, receipt.requestId)).toEqual(SETTLED);
      const file = readFileSync(fileOf(brain, CROSS_CUT));
      expect(file.toString('utf8')).not.toContain(CROSS_CLAIM);
      expect(file.toString('utf8')).toContain(CROSS_KEPT);
      expect(file.equals(await exported(brain, CROSS_CUT))).toBe(true);
      expect(stagingLeft(brain)).toEqual([]);
    }, 600_000);
  });

  describe(kind + ': a mirror stage the filesystem refuses holds nothing behind it', () => {
    let brain: TwinBrain;
    const mirrorOf = async (requestId: string) => (await brain.engine.executeRaw<{ state: string; error_code: string | null; recovering: boolean; data: any }>(
      `SELECT e.state, e.error_code, e.recovery IS NOT NULL AS recovering, e.data FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
        WHERE r.request_id=$1::uuid AND e.kind='withdrawal-mirror'`, [requestId]))[0]!;
    const reserved = async () => (await brain.engine.executeRaw<{ bytes: string }>('SELECT recovery_bytes::text AS bytes FROM persistence_counters')).map(row => Number(row.bytes));
    const pass = () => withEnv(brain.env(), async () => {
      await brain.engine.executeRaw(`UPDATE persistence_effects SET next_attempt_at=now() WHERE source_id=$1 AND state='queued'`, [brain.sourceId]);
      await runPersistenceEffects(brain.engine, { engine: kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 });
    });
    /** purge_fact committed; its effects are then run by `pass` only. */
    const submitPurge = async (claim: string) => {
      const [fact] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3', [brain.sourceId, SEGMENTED, claim]);
      const dry = await brain.call('purge_fact', { id: Number(fact!.id), dry_run: true }, SEGMENTED);
      const requestId = randomUUID();
      expect(await brain.call('purge_fact', { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: requestId }, SEGMENTED))
        .toMatchObject({ state: 'committed' });
      return requestId;
    };

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [], async seed => {
        await seed.setSwitch(true);
        await seed.put(SEGMENTED, 1_100_000);
      });
      await extract(brain, SEGMENTED, [EIO_ONCE, EIO_ALWAYS, KEPT]);
      expect(await brain.storageOf(SEGMENTED)).toBe('segmented');
      await settle(brain, kind);
    }, 600_000);

    afterAll(() => { installFaultHook(undefined); return brain.close(); }, 120_000);

    test('an EIO while staging is retried and the next attempt publishes', async () => {
      let refused = 0;
      installFaultHook(async point => { if (point === 'large_file:stage_streaming' && refused === 0) { refused++; throw eio(); } });
      let requestId = '';
      try {
        requestId = await submitPurge(EIO_ONCE);
        await settle(brain, kind);
      } finally { installFaultHook(undefined); }
      expect(refused).toBe(1);
      const file = readFileSync(fileOf(brain, SEGMENTED));
      expect(file.toString('utf8')).not.toContain(EIO_ONCE);
      expect(file.equals(await exported(brain, SEGMENTED))).toBe(true);
      expect(await effectsOf(brain, requestId)).toEqual(SETTLED);
      expect(await mirrorOf(requestId)).toMatchObject({ recovering: false });
      expect(await reserved()).toEqual((await reserved()).map(() => 0));
      expect(stagingLeft(brain)).toEqual([]);
    }, 600_000);

    test('a stage refused on every attempt parks the mirror after its attempts while other writes on the worktree proceed', async () => {
      const before = readFileSync(fileOf(brain, SEGMENTED));
      let refused = 0;
      installFaultHook(async point => { if (point === 'large_file:stage_streaming') { refused++; throw eio(); } });
      let requestId = '';
      try {
        requestId = await submitPurge(EIO_ALWAYS);
        await waitFor(async () => { await pass(); return refused >= 1; }, { timeoutMs: 60_000, intervalMs: 100, label: 'the first stage write refused' });
        // Another page of the same worktree is written while the mirror retries: the refused stage holds no record that blocks it.
        expect(await brain.call('put_page', { slug: OTHER, content: '---\ntype: person\ntitle: Other Example\n---\n\nWritten while a mirror retries.\n' }))
          .toMatchObject({ state: 'committed' });
        expect(readFileSync(fileOf(brain, OTHER), 'utf8')).toContain('Written while a mirror retries.');
        await waitFor(async () => { await pass(); return (await mirrorOf(requestId)).state === 'failed'; },
          { timeoutMs: 120_000, intervalMs: 100, label: 'the mirror parked' }).catch(() => undefined);
      } finally { installFaultHook(undefined); }
      expect(await mirrorOf(requestId)).toMatchObject({ state: 'failed', error_code: 'targets_parked', recovering: false,
        data: { parked: [{ slug: SEGMENTED, error_code: 'effect_unavailable' }] } });
      expect(refused).toBe(PARK_AFTER_FAILURES);
      expect(await reserved()).toEqual((await reserved()).map(() => 0));
      expect(readFileSync(fileOf(brain, SEGMENTED)).equals(before)).toBe(true);
      expect(stagingLeft(brain)).toEqual([]);
    }, 600_000);
  });

  describe(kind + ': the mirror and Git walk do only the work a target needs', () => {
    let brain: TwinBrain;
    let restoreRenewal: () => void = () => {};

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [], async seed => {
        await seed.setSwitch(true);
        await seed.put(SEGMENTED, 1_100_000);
        await seed.put(GONE, 1_100_000);
      });
      await extract(brain, SEGMENTED, [BOUND_CLAIM, RENEW_CLAIM, KEPT]);
      await extract(brain, GONE, [GONE_CLAIM, KEPT]);
      expect([await brain.storageOf(SEGMENTED), await brain.storageOf(GONE)]).toEqual(['segmented', 'segmented']);
      await settle(brain, kind);
    }, 600_000);

    afterAll(() => { restoreRenewal(); return brain.close(); }, 120_000);

    test('the file is measured once, by the mirror; the Git walk only compares it', async () => {
      resetWork();
      const receipt = await purge(brain, kind, SEGMENTED, BOUND_CLAIM);
      const work = { ...largeFileWork };
      const file = readFileSync(fileOf(brain, SEGMENTED));
      expect(await effectsOf(brain, receipt.requestId)).toEqual(SETTLED);
      expect(file.toString('utf8')).not.toContain(BOUND_CLAIM);
      expect(file.equals(await exported(brain, SEGMENTED))).toBe(true);
      expect(work.bytesMeasured).toBe(file.length);
      expect(work.bytesWritten).toBe(file.length);
    }, 600_000);

    test('the mirror renews its claim between the pieces of the file it measures and stages', async () => {
      // Interval 0: every piece renews, so the count is a function of the pieces, not of time.
      restoreRenewal = __setEffectRenewalIntervalForTests(0);
      effectClaimWork.renewals = 0;
      let receipt: Awaited<ReturnType<typeof purge>>;
      try { receipt = await purge(brain, kind, SEGMENTED, RENEW_CLAIM); } finally { restoreRenewal(); }
      const renewals = effectClaimWork.renewals;
      expect(await effectsOf(brain, receipt!.requestId)).toEqual(SETTLED);
      expect(readFileSync(fileOf(brain, SEGMENTED), 'utf8')).not.toContain(RENEW_CLAIM);
      // At least one renewal per segment of each pass over the file: once measured, once staged.
      const [segments] = await brain.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_manifest m JOIN pages p ON p.id=m.page_id
        WHERE p.source_id=$1 AND p.slug=$2 AND m.gen_to IS NULL AND m.staging_id IS NULL`, [brain.sourceId, SEGMENTED]);
      expect(segments!.n).toBeGreaterThan(1);
      expect(renewals).toBeGreaterThanOrEqual(2 * segments!.n);
    }, 600_000);

    test('a page whose canonical file is gone is never rendered by its mirror', async () => {
      rmSync(fileOf(brain, GONE));
      resetWork();
      const receipt = await purge(brain, kind, GONE, GONE_CLAIM);
      expect(await effectsOf(brain, receipt.requestId)).toEqual(SETTLED);
      expect(existsSync(fileOf(brain, GONE))).toBe(false);
      expect(largeFileWork.bytesMeasured).toBe(0);
    }, 600_000);
  });

  describe(kind + ': an interrupted streamed mirror recovers forward', () => {
    let brain: TwinBrain;

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [], async seed => {
        await seed.setSwitch(true);
        await seed.put(SEGMENTED, 1_100_000);
      });
      await extract(brain, SEGMENTED, [...Object.values(CRASH_CLAIMS), STREAM_CLAIM, PARTIAL_CLAIM, KEPT]);
      expect(await brain.storageOf(SEGMENTED)).toBe('segmented');
      await settle(brain, kind);
    }, 600_000);

    afterAll(() => brain.close(), 120_000);

    for (const seam of Object.keys(CRASH_CLAIMS) as (keyof typeof CRASH_CLAIMS)[]) {
      test(`a mirror interrupted at ${seam} publishes on recovery, staged once`, async () => {
        const claim = CRASH_CLAIMS[seam];
        expect(readFileSync(fileOf(brain, SEGMENTED), 'utf8')).toContain(claim);
        const hits: { stages: string[]; recovery: any; bytes: number }[] = [];
        installFaultHook(async (point, detail) => {
          if (point !== seam || hits.length) return;
          const [row] = await brain.engine.executeRaw<{ recovery: unknown; bytes: string }>(
            'SELECT recovery, recovery_bytes::text AS bytes FROM persistence_effects WHERE id=$1', [detail.effectId]);
          hits.push({ stages: stagingLeft(brain), recovery: typeof row!.recovery === 'string' ? JSON.parse(row!.recovery) : row!.recovery, bytes: Number(row!.bytes) });
          throw new Error(`modelled crash at ${seam}`);
        });
        resetWork();
        let receipt: Awaited<ReturnType<typeof purge>>;
        try { receipt = await purge(brain, kind, SEGMENTED, claim); } finally { installFaultHook(undefined); }
        const work = { ...largeFileWork };
        const file = readFileSync(fileOf(brain, SEGMENTED));

        // The interruption left a durable record naming the stage by path and digest, never the file's bytes, reserving
        // the file once; before the stage was written nothing was staged, after it the flushed stage was on disk.
        expect(hits).toHaveLength(1);
        const [hit] = hits;
        expect(hit!.recovery).toMatchObject({ version: 2, kind: 'withdrawal-mirror', after: null, afterHash: sha(file),
          staging: { publication: { hash: sha(file), bytes: file.length } } });
        expect(hit!.bytes).toBe(Buffer.byteLength(JSON.stringify(hit!.recovery)) + file.length + 4096);
        expect(hit!.stages).toEqual(seam === 'effect_recovery:staged' ? [basename(hit!.recovery.staging.publication.path)] : []);

        // Recovery finished the mirror forward: the file is the page's export without the claim, nothing is left staged
        // or reserved, and the effects settled.
        expect(file.toString('utf8')).not.toContain(claim);
        expect(file.toString('utf8')).toContain(KEPT);
        expect(file.equals(await exported(brain, SEGMENTED))).toBe(true);
        expect(await effectsOf(brain, receipt!.requestId)).toEqual(SETTLED);
        expect(stagingLeft(brain)).toEqual([]);
        await waitFor(async () => (await brain.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests
          WHERE source_id=$1 AND recovery IS NOT NULL`, [brain.sourceId]))[0]!.n === 0, { timeoutMs: 30_000, label: 'request recovery records cleared' });
        const counters = await brain.engine.executeRaw<{ bytes: string }>('SELECT recovery_bytes::text AS bytes FROM persistence_counters');
        expect(counters.every(row => Number(row.bytes) === 0)).toBe(true);

        // Staged exactly once, in pieces of at most one segment: from the segments on recovery, or the flushed stage renamed.
        expect(work.bytesWritten).toBe(file.length);
        expect(work.largestPiece).toBeGreaterThan(0);
        expect(work.largestPiece).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
      }, 600_000);
    }

    test('a mirror whose process dies mid-stream discards the partial file on recovery and publishes', async () => {
      const recoveryState = async () => (await brain.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects
        WHERE source_id=$1 AND kind='withdrawal-mirror' AND state='queued' AND recovery IS NOT NULL`, [brain.sourceId]))[0]!.n;
      // The seam fires after each piece written to the in-progress file; on the third the process "dies". A death leaves
      // that file as it is, while the modelled one (a throw) lets the writer remove it, so its bytes are put back at the
      // same path once the attempt has released its claim and before recovery runs: the state a death leaves.
      let pieces = 0;
      let partial: { path: string; bytes: Buffer; stage: string } | null = null;
      let restored = false;
      installFaultHook(async (point, detail) => {
        if (point !== 'large_file:stage_streaming' || partial || ++pieces < 3) return;
        const [row] = await brain.engine.executeRaw<{ recovery: any }>('SELECT recovery FROM persistence_effects WHERE source_id=$1 AND recovery IS NOT NULL', [brain.sourceId]);
        const recovery = typeof row!.recovery === 'string' ? JSON.parse(row!.recovery) : row!.recovery;
        partial = { path: detail.path!, bytes: readFileSync(detail.path!), stage: recovery.staging.publication.path };
        throw new Error('modelled death mid-stream');
      });
      const putBack = async () => {
        if (!partial || restored || existsSync(partial.path) || !(await recoveryState())) return;
        writeFileSync(partial.path, partial.bytes, { flag: 'wx' });
        restored = true;
      };
      resetWork();
      let receipt: Awaited<ReturnType<typeof purge>>;
      try { receipt = await purge(brain, kind, SEGMENTED, STREAM_CLAIM, putBack); } finally { installFaultHook(undefined); }
      const work = { ...largeFileWork };
      const file = readFileSync(fileOf(brain, SEGMENTED));

      // The death left a partial file under its own in-progress name next to the reserved stage name, never at it.
      expect(partial).not.toBeNull();
      const died = partial! as { path: string; bytes: Buffer; stage: string };
      expect(restored).toBe(true);
      expect(died.path).not.toBe(died.stage);
      expect(died.bytes.length).toBeGreaterThan(0);
      expect(died.bytes.length).toBeLessThan(file.length);

      // Recovery discarded it, streamed the stage again from the segments and published the file without the claim.
      expect(file.toString('utf8')).not.toContain(STREAM_CLAIM);
      expect(file.toString('utf8')).toContain(KEPT);
      expect(file.equals(await exported(brain, SEGMENTED))).toBe(true);
      expect(await effectsOf(brain, receipt!.requestId)).toEqual(SETTLED);
      expect(stagingLeft(brain)).toEqual([]);
      const counters = await brain.engine.executeRaw<{ bytes: string }>('SELECT recovery_bytes::text AS bytes FROM persistence_counters');
      expect(counters.every(row => Number(row.bytes) === 0)).toBe(true);
      expect(work.bytesWritten).toBe(died.bytes.length + file.length);
      expect(work.largestPiece).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    }, 600_000);

    // Last: it leaves the source's worktree blocked on purpose.
    test('a partial file at the reserved stage name still refuses (unexpected_staging_bytes) and leaves the file alone', async () => {
      const before = readFileSync(fileOf(brain, SEGMENTED));
      let stage: string | null = null;
      installFaultHook(async (point, detail) => {
        if (point !== 'effect_recovery:before_stage' || stage) return;
        stage = detail.path!;
        writeFileSync(stage, 'partial bytes', { flag: 'wx' });
        throw new Error('modelled death after a foreign write at the stage name');
      });
      let requestId = '';
      try {
        const [fact] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3', [brain.sourceId, SEGMENTED, PARTIAL_CLAIM]);
        const dry = await brain.call('purge_fact', { id: Number(fact!.id), dry_run: true }, SEGMENTED);
        requestId = randomUUID();
        expect(await brain.call('purge_fact', { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: requestId }, SEGMENTED))
          .toMatchObject({ state: 'committed' });
        await waitFor(async () => {
          await withEnv(brain.env(), async () => {
            await brain.engine.executeRaw(`UPDATE persistence_effects SET next_attempt_at=now() WHERE source_id=$1 AND state='queued'`, [brain.sourceId]);
            await runPersistenceEffects(brain.engine, { engine: kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 });
          });
          return (await effectsOf(brain, requestId)).find(e => e.kind === 'withdrawal-mirror')?.error === 'unexpected_staging_bytes';
        }, { timeoutMs: 60_000, intervalMs: 100, label: 'the mirror refused the foreign stage' });
      } finally { installFaultHook(undefined); }
      expect(stage).not.toBeNull();
      expect(readFileSync(stage!, 'utf8')).toBe('partial bytes');
      expect(readFileSync(fileOf(brain, SEGMENTED)).equals(before)).toBe(true);
      const [mirror] = await brain.engine.executeRaw<{ recovering: boolean }>(`SELECT e.recovery IS NOT NULL AS recovering FROM persistence_effects e
        JOIN persistence_requests r ON r.id=e.request_id WHERE r.request_id=$1::uuid AND e.kind='withdrawal-mirror'`, [requestId]);
      expect(mirror!.recovering).toBe(true);
    }, 600_000);
  });
}
