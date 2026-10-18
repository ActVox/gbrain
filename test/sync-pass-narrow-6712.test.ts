/**
 * #6712 PR 4b fix 3, first part: a taken confirm round at the previous round's tree patches the previous round's origin
 * domain (claims, claimants, domain, spelling twins, the attestation walk) at the origins the pass wrote, and classifies
 * again only the paths whose kept entry could change (sync-pass-narrow.ts). Every other round reads in full, as before.
 *
 * Protects: on each case, every taken round after the first gives exactly the level a cacheless full read of the same
 * database and tree gives: each path's class, state (attestation `A`, spelling twin), page, revision and claimants, and
 * the level's reconcilable count, holds and kind. Cases: a round-1 edit, a rename that moves a page's origin (old and new)
 * and a new page, alone and beside tombstones at the rename's and the new page's origins, several live pages on one
 * origin (#6948), several tombstones, two spellings and a differing identity (GBRA-130); and the seeded mix. A round whose
 * seam refuses the patch (`sync:level_narrow`) builds the domain whole and says so (`narrow: 'forced'`), with the same level.
 *
 * PGLite here; Postgres through test/e2e/sync-pass-narrow-6712-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { readShadowLevel, type ShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { mixSetup, seedMix } from '../scripts/bench/sync-convergence-seeded.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body = `The body of ${title}.`, front = '') => `---\ntype: concept\ntitle: ${title}\n${front}---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`));
  writeFileSync(join(root, 'notes/Kept Doc.md'), note('Kept doc', 'A kept document.', 'id: kept-one\n'));
  commit(root, 'notes');
};

/** What the level hands the pass, path by path and level-wide. */
function project(level: ShadowLevel) {
  return {
    paths: level.paths.map(entry => ({ path: entry.path, slug: entry.slug, pageId: entry.pageId, revision: entry.revision, result: entry.result, state: entry.state,
      legacyPageless: entry.legacyPageless ?? null, ambiguousOrigin: entry.ambiguousOrigin ?? null })),
    reconcilable: level.reconcilable, releasableHolds: level.releasableHolds, heldRenames: level.heldRenames, rescreenDue: level.rescreenDue, kind: level.kind,
    kindBlockers: level.kindBlockers, fileRefusals: level.fileRefusals ?? null,
  };
}

type Compared = { round: number; narrow: string | undefined; same: boolean; paths: number };
/** A sync whose rounds after the first, when their confirm round is taken, are each compared with a cacheless full read. */
async function compared(engine: BrainEngine, { force = false } = {}) {
  const rounds: Compared[] = [], mismatches: unknown[] = [];
  installFaultHook(async (point, detail) => {
    if (point === 'sync:level_narrow' && force) throw new Error('a refused patch');
    if (point !== 'sync:level_read' || !detail.level?.confirm?.taken) return;
    const input = detail.level.input as Parameters<typeof readShadowLevel>[1];
    const narrowed = project(detail.level.shadow as ShadowLevel);
    const full = project((await readShadowLevel(engine, { ...input, pass: { ...input.pass!, cache: undefined, passId: undefined } }))!);
    const same = JSON.stringify(narrowed) === JSON.stringify(full);
    if (!same) mismatches.push({ round: detail.round, narrowed, full });
    rounds.push({ round: detail.round!, narrow: detail.level.confirm.narrow, same, paths: narrowed.paths.length });
  });
  try {
    const result = await performManagedSync(engine, OPTS);
    expect(mismatches).toEqual([]);
    return { status: result.status, rounds };
  } finally { installFaultHook(undefined); }
}
const narrowed = (run: { rounds: Compared[] }) => run.rounds.filter(round => round.narrow === 'taken');

/** A second live page recording notes/a.md (#6948), as legacy data left it. */
async function liveTwin(engine: BrainEngine) {
  await dropOriginIndex(engine);
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.putPage('notes/a-copy', { type: 'concept', title: 'Example', compiled_truth: 'A different body.', timeline: '', frontmatter: {}, content_hash: crypto.randomUUID() }, { sourceId: 'default' });
    await tx.executeRaw("UPDATE pages SET source_path='notes/a.md' WHERE source_id='default' AND slug='notes/a-copy'");
  }, TEST_WRITE_ATTRIBUTION));
}
/** Two deleted pages recording notes/twin.md (#6517). */
async function tombstoneTwins(engine: BrainEngine) {
  for (const slug of ['archive/twin-one', 'archive/twin-two']) await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.putPage(slug, { type: 'note', title: slug, compiled_truth: `Deleted ${slug}.`, timeline: '', frontmatter: {}, content_hash: `h-${slug}` }, { sourceId: 'default' });
    await tx.executeRaw("UPDATE pages SET source_path='notes/twin.md', deleted_at=now() WHERE source_id='default' AND slug=$1", [slug]);
  }, TEST_WRITE_ATTRIBUTION));
}

/** Deleted pages recording the origins round 1 would move a page onto and create a page at: round 1 holds both, beside its edit. */
async function tombstonedTargets(engine: BrainEngine) {
  for (const [slug, path] of [['archive/old-moved', 'notes/b-moved.md'], ['archive/old-new', 'notes/new.md']]) await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.putPage(slug!, { type: 'note', title: slug!, compiled_truth: `Deleted ${slug}.`, timeline: '', frontmatter: {}, content_hash: `h-${slug}` }, { sourceId: 'default' });
    await tx.executeRaw("UPDATE pages SET source_path=$2, deleted_at=now() WHERE source_id='default' AND slug=$1", [slug, path]);
  }, TEST_WRITE_ATTRIBUTION));
}

/**
 * Each case's arrangement after the first sync; round 1 also edits, renames and adds a page (`roundOneWrites`). `whole`:
 * no round of the case takes the confirm round, so it never narrows (several live pages on one origin: their page row is
 * rewritten during each pass's first round, which the confirm round reads as a foreign write), and the case shows only that.
 */
const CASES: Record<string, { arrange: (engine: BrainEngine, root: string) => Promise<void>; whole?: true }> = {
  moves: { arrange: async () => {} },
  tombstoned_targets: { arrange: engine => tombstonedTargets(engine) },
  several_live: { arrange: engine => liveTwin(engine), whole: true },
  several_tombstones: { arrange: async (engine, root) => { await tombstoneTwins(engine); writeFileSync(join(root, 'notes/twin.md'), note('notes/twin')); } },
  spelling: { arrange: async (_engine, root) => { writeFileSync(join(root, 'notes/Case.md'), note('Upper')); writeFileSync(join(root, 'notes/case.md'), note('Lower')); } },
  identity_differs: { arrange: async (_engine, root) => { git(root, 'rm', '-q', 'notes/Kept Doc.md'); writeFileSync(join(root, 'notes/kept-doc.md'), note('Another document', 'Another.', 'id: kept-two\n')); } },
};
const roundOneWrites = (root: string) => {
  writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'An edited body of notes/a.'));
  git(root, 'mv', 'notes/b.md', 'notes/b-moved.md');
  writeFileSync(join(root, 'notes/new.md'), note('notes/new'));
};

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0], seed: (b: { root: string }) => void = setup) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup: seed });
  describe(`#6712 PR 4b round-2 narrowing (${backend})`, () => {
    for (const [name, { arrange, whole }] of Object.entries(CASES)) {
      test(`${name}: a narrowed round is the level a full read gives`, () => brain(async ({ engine, root }) => {
        expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
        await arrange(engine, root);
        roundOneWrites(root);
        commit(root, name);
        const run = await compared(engine);
        expect(run.status).toBe('synced');
        if (whole) expect(run.rounds).toEqual([]);
        else expect(narrowed(run).length).toBeGreaterThan(0);
        expect(run.rounds.every(round => round.same)).toBe(true);
      }), 240_000);
    }

    test('the seeded mix: each narrowed round is the level a full read gives', () => brain(async ({ engine, ctx, root }) => {
      await seedMix({ engine, ctx, root });
      const run = await compared(engine);
      expect(narrowed(run).length).toBeGreaterThan(0);
      expect(run.rounds.every(round => round.same)).toBe(true);
    }, mixSetup), 600_000);

    test('a refused patch builds the domain whole, says so in confirm, and gives the same level', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      roundOneWrites(root);
      commit(root, 'forced');
      const run = await compared(engine, { force: true });
      expect(run.status).toBe('synced');
      expect(run.rounds.length).toBeGreaterThan(0);
      expect(run.rounds.map(round => [round.narrow, round.same])).toEqual(run.rounds.map(() => ['forced', true]));
    }), 240_000);
  });
}
