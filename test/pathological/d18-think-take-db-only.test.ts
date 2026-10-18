/**
 * D-18 (GBRA-131, #6982): `think --take --anchor` never creates a takes-only
 * file for a database-only page, or appends to a file that differs from the
 * database.
 *
 * Protects: `persistTakeFromSynthesis` publishes the take through the
 * coordinated `takes_add` mutation, which composes the fence from the page's
 * database snapshot. With `sync.write_through` off, or for a page in a
 * declared `storage.db_only` directory, the take lands in the page's
 * database body after its existing text and no file is created. With
 * write-through on, a page whose file is missing, or whose file and database
 * body differ (a newer database edit, or an unimported file edit), is
 * refused with `TAKE_WRITE_FAILED: source_changed` and neither copy changes.
 * Agreeing copies get the take in both. On Postgres a classic brain's source
 * with no canonical owner refuses the take (`owner_unavailable`) and writes
 * nothing; there the other cases bind the source first (`claimWorktree`, the
 * claim PGLite makes automatically on its first coordinated write, so the
 * PGLite arm starts unclaimed).
 * Fails when: the take goes through the legacy md-first addTakeToPage (the
 * pre-fix path), which reads a missing file as an empty body and writes a
 * takes-only file the next sync imports over the page, or appends to a stale
 * file.
 * Seams: none. A concurrent edit after the comparison is the coordinator's
 * own admission recheck (covered by its tests), not this caller's.
 * PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { claimWorktree, managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { parseTakesFence } from '../../src/core/takes-fence.ts';
import { persistTakeFromSynthesis } from '../../src/core/think/persist-take.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const ALICE = 'people/alice-example';
const BODY = '# Alice Example\n\nDB-BODY-MARKER: Alice Example works at Acme Example.';
const ANSWER = { answer: '- Alice Example is the strongest operator at Acme Example.\n\nDetail.', synthesisOk: true };
const CLAIM = 'Alice Example is the strongest operator at Acme Example.';

interface Brain {
  engine: BrainEngine;
  root: string;
  path: string;
  file(): string | null;
  body(): Promise<string>;
  takes(): Promise<string[]>;
  take(): ReturnType<typeof persistTakeFromSynthesis>;
}

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>, opts: { bound?: boolean } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d18-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await engine.setConfig('sync.repo_path', root);
        if (opts.bound ?? databaseUrl !== undefined) await claimWorktree(engine, 'default', root);
        await engine.putPage(ALICE, { type: 'person', title: 'Alice Example', compiled_truth: BODY });
        const path = join(root, `${ALICE}.md`);
        await run({
          engine, root, path,
          file: () => existsSync(path) ? readFileSync(path, 'utf8') : null,
          body: async () => (await engine.executeRaw<{ compiled_truth: string }>(
            "SELECT compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1", [ALICE]))[0]!.compiled_truth,
          takes: async () => (await engine.executeRaw<{ claim: string }>(
            "SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = 'default' AND p.slug = $1 ORDER BY t.row_num", [ALICE])).map(r => r.claim),
          take: () => persistTakeFromSynthesis(engine, ANSWER, { anchor: ALICE, sourceId: 'default' }),
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function fileFromDatabase(b: Brain): Promise<string> {
  await b.engine.executeRaw("UPDATE pages SET source_path = $1 WHERE source_id = 'default' AND slug = $2", [`${ALICE}.md`, ALICE]);
  const snapshot = (await b.engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!;
  const bytes = serializePageToMarkdown(snapshot.page, snapshot.tags);
  mkdirSync(dirname(b.path), { recursive: true });
  writeFileSync(b.path, bytes);
  return bytes;
}

const fenceClaims = (text: string) => parseTakesFence(text).takes.map(t => t.claim);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-18 think --take on a database-only or drifted page (${backend})`, () => {
    test('D-18 write-through off: the take lands in the database body after its text and no file is created', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('sync.write_through', 'false');
        _resetWriteThroughCacheForTest();
        const r = await expectUnitNotAborted(() => b.take());
        const body = await b.body();
        expect({ row: r.take_row, warnings: r.warnings, file: b.file(), kept: body.startsWith(BODY), fence: fenceClaims(body), takes: await b.takes() })
          .toEqual({ row: 1, warnings: [], file: null, kept: true, fence: [CLAIM], takes: [CLAIM] });
      });
    }, 180_000);

    test('D-18 storage.db_only page: the take lands in the database body and no file is created', async () => {
      await withBrain(databaseUrl, async b => {
        writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - people/\n');
        const r = await expectUnitNotAborted(() => b.take());
        const body = await b.body();
        expect({ row: r.take_row, file: b.file(), kept: body.startsWith(BODY), fence: fenceClaims(body), takes: await b.takes() })
          .toEqual({ row: 1, file: null, kept: true, fence: [CLAIM], takes: [CLAIM] });
      });
    }, 180_000);

    test('D-18 write-through on, page with no file: refused, no takes-only file is created and the body is unchanged', async () => {
      await withBrain(databaseUrl, async b => {
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, refused: r.warnings.some(w => w.startsWith('TAKE_WRITE_FAILED: source_changed')), file: b.file(), body: await b.body(), takes: await b.takes() })
          .toEqual({ row: null, refused: true, file: null, body: BODY, takes: [] });
      });
    }, 180_000);

    test('D-18 db-newer: a stale file is not appended to; refused and both copies stay', async () => {
      await withBrain(databaseUrl, async b => {
        const stale = await fileFromDatabase(b);
        await b.engine.putPage(ALICE, { type: 'person', title: 'Alice Example', compiled_truth: `${BODY}\n\nDB-NEWER-MARKER: edited with write-through off.` });
        const bodyBefore = await b.body();
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, refused: r.warnings.some(w => w.startsWith('TAKE_WRITE_FAILED: source_changed')), file: b.file() === stale, body: (await b.body()) === bodyBefore, takes: await b.takes() })
          .toEqual({ row: null, refused: true, file: true, body: true, takes: [] });
      });
    }, 180_000);

    test('D-18 file-newer: an unimported file edit is refused and both copies stay', async () => {
      await withBrain(databaseUrl, async b => {
        const edited = (await fileFromDatabase(b)).replace('works at Acme Example.', 'works at Acme Example.\n\nFILE-ONLY-EDIT-MARKER.');
        writeFileSync(b.path, edited);
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, refused: r.warnings.some(w => w.startsWith('TAKE_WRITE_FAILED: source_changed')), file: b.file() === edited, body: await b.body(), takes: await b.takes() })
          .toEqual({ row: null, refused: true, file: true, body: BODY, takes: [] });
      });
    }, 180_000);

    if (backend === 'postgres') test('D-18 Postgres, unbound source: the take is refused owner_unavailable and nothing is written', async () => {
      await withBrain(databaseUrl, async b => {
        const stale = await fileFromDatabase(b);
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, refused: r.warnings.some(w => w.startsWith('TAKE_WRITE_FAILED: owner_unavailable')), file: b.file() === stale, body: await b.body(), takes: await b.takes() })
          .toEqual({ row: null, refused: true, file: true, body: BODY, takes: [] });
      }, { bound: false });
    }, 180_000);

    test('D-18 agreeing copies: the take lands in the file and the database with the body kept', async () => {
      await withBrain(databaseUrl, async b => {
        await fileFromDatabase(b);
        const r = await expectUnitNotAborted(() => b.take());
        const body = await b.body();
        expect({ row: r.take_row, warnings: r.warnings, path: r.path, file: fenceClaims(b.file()!), fileKept: b.file()!.includes('DB-BODY-MARKER'),
          db: fenceClaims(body), dbKept: body.startsWith(BODY), takes: await b.takes() })
          .toEqual({ row: 1, warnings: [], path: b.path, file: [CLAIM], fileKept: true, db: [CLAIM], dbKept: true, takes: [CLAIM] });
      });
    }, 180_000);
  });
}
