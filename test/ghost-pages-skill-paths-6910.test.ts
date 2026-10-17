/**
 * #6910: `gbrain repair ghost-pages` on a source with an adopted shared skillpack.
 *
 * A legacy knowledge page under `skills/` whose file is gone is a ghost the knowledge guard refuses to retire
 * (`skill_bundle_required`). Protects: such a page is listed apart (`skill_path`, `residuals.skill_paths`,
 * `details.skill_paths`) and never enters the approved set, so the apply retires every ordinary ghost even when the
 * skill page comes first in page-id order; doctor `ghost_pages` and `gbrain pages ghosts` count it apart; and a per-item
 * `caller` refusal during the apply is recorded `refused` with its code while the rest of the approved set still applies.
 * Every case drives a real PGLite brain with a claimed canonical worktree.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { opError } from '../src/core/ops/contract.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { adoptSharedSkillpack } from '../src/core/shared-skills/publication.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { readGhostPages } from '../src/core/ghost-pages.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { runPagesGhosts } from '../src/commands/pages-ghosts.ts';
import { ghostPagesEntry } from '../src/commands/doctor/checks/ghost-pages.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const logger = { info() {}, warn() {}, error() {} };
const SOURCE = 'default';
const SKILL = 'skills/legacy-skill/notes';
const ORDINARY = ['notes/a', 'notes/b', 'notes/c'];

interface Fixture { engine: BrainEngine; root: string }

/**
 * A legacy knowledge page under skills/ (lowest page id, imported before the pack was adopted), three ordinary pages and
 * one kept page, all file-backed; then the shared skillpack is adopted on the source (pack root = source root) and every
 * file but the kept one is removed.
 */
async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-ghost-skills-'));
  try {
    await withEnv({ GBRAIN_HOME: join(scratch, 'home'), DATABASE_URL: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine();
      const engine = isolated.engine;
      try {
        const root = join(scratch, 'brain'); mkdirSync(root);
        execFileSync('git', ['init', '-q'], { cwd: root });
        writeFileSync(join(root, 'skillpack.json'), JSON.stringify({ api_version: 'gbrain-skillpack-v1', name: 'example-pack', version: '1.0.0',
          description: 'Synthetic fixture', author: 'Example Maintainer', license: 'MIT', homepage: 'https://example.com/skills',
          gbrain_min_version: '0.51.0', brain_resident: true, skills: ['skills/alpha'] }));
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, SOURCE]);
        for (const slug of [SKILL, ...ORDINARY, 'notes/keep']) {
          await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body.` }, { sourceId: SOURCE });
          await engine.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [SOURCE, slug, `${slug}.md`]);
          const snapshot = (await engine.readPageSnapshot(slug, { sourceId: SOURCE }))!;
          mkdirSync(dirname(join(root, `${slug}.md`)), { recursive: true });
          writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
        }
        await claimWorktree(engine, SOURCE, root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, sourceId: SOURCE, dryRun: false, logger };
        await engine.setConfig('mcp.publish_skills', 'true');
        await setSharedSkillPolicy(ctx, SOURCE, { version: 1, enabled: true, classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: true }, null);
        const adopted = await adoptSharedSkillpack(ctx, SOURCE, { request_id: randomUUID(), pack_id: 'example-pack', skills: [
          { pack_id: 'example-pack', name: 'alpha', expected_revision: null, files: [
            { path: 'skills/alpha/SKILL.md', content: '---\nname: alpha\ndescription: A synthetic shared skill\n---\n\nApproved instructions.\n', file_class: 'prose' },
          ] },
        ] });
        expect(adopted.receipts[0].state).toBe('committed');
        for (const slug of [SKILL, ...ORDINARY]) unlinkSync(join(root, `${slug}.md`));
        await run({ engine, root });
      } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); await isolated.close(); }
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const live = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [SOURCE, slug]))[0]!.n === 1;
const repair = async (engine: BrainEngine, opts: { apply?: boolean; expect?: string } = {}) => (await repairRunner(engine, { apply: opts.apply === true, logger }))
  .run('ghost-pages', await resolveRepairScope(engine, SOURCE), { explicit: true, sourceFlag: SOURCE, expect: opts.expect });

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  try { await fn(); } finally { console.log = original; }
  return printed;
}

describe('#6910 ghost pages under the shared skillpack', () => {
  afterEach(() => installFaultHook(undefined));

  test('the skill-path ghost is listed apart and every ordinary ghost is retired, though it comes first in page-id order', () => fixture(async f => {
        const preview = await repair(f.engine);
    expect(preview.affected).toBe(3);
    expect(preview.residuals).toMatchObject({ ghosts: 3, skill_paths: 1 });
    expect(preview.listing!.filter(entry => entry.class === 'canonical_file_missing').map(entry => entry.item)).toEqual(ORDINARY.map(slug => `${SOURCE}:${slug}`));
    expect(preview.listing!.filter(entry => entry.class === 'skill_path').map(entry => entry.item)).toEqual([`${SOURCE}:${SKILL}`]);
    expect(preview.details).toMatchObject({ skill_paths: { count: 1, slugs: [SKILL], owned_by: 'shared_skill_publisher', route: null } });
    expect(String((preview.details as { skill_paths: { note: string } }).skill_paths.note)).toContain('no gbrain command removes them today');

    const applied = await repair(f.engine, { apply: true, expect: preview.preview_hash });
    expect(applied).toMatchObject({ applied: 3, failed: [], complete: true, outcomes: { soft_deleted: 3 } });
    for (const slug of ORDINARY) expect(await live(f.engine, slug)).toBe(false);
    expect(await live(f.engine, SKILL)).toBe(true);
    expect(await live(f.engine, 'notes/keep')).toBe(true);

    const after = await repair(f.engine);
    expect(after.affected).toBe(0);
    expect(after.residuals).toMatchObject({ ghosts: 0, skill_paths: 1 });
  }), 120_000);

  test('doctor ghost_pages and pages ghosts count the skill-path ghost apart, not as a knowledge ghost awaiting the repair', () => fixture(async f => {
        const summary = await readGhostPages(f.engine, { sourceIds: [SOURCE] });
    expect(summary).toMatchObject({ count: 3, skill_paths: 1, by_source: [{ source_id: SOURCE, count: 3, skill_paths: 1 }] });
    expect(summary.samples.map(ghost => ghost.slug)).toEqual(ORDINARY);
    expect(summary.skill_path_samples.map(ghost => ghost.slug)).toEqual([SKILL]);

    const out = JSON.parse(await capture(() => runPagesGhosts(f.engine, ['--source', SOURCE, '--json'])));
    expect(out.count).toBe(3);
    expect(out.ghosts.map((ghost: { slug: string }) => ghost.slug)).toEqual(ORDINARY);
    expect(out.skill_paths.map((ghost: { slug: string }) => ghost.slug)).toEqual([SKILL]);

    const preview = await repair(f.engine);
    await repair(f.engine, { apply: true, expect: preview.preview_hash });
    const [check] = await ghostPagesEntry.run({ engine: f.engine } as never) as Array<Record<string, any>>;
    expect(check).toMatchObject({ name: 'ghost_pages', status: 'ok', details: { count: 0, skill_paths: { count: 1, owned_by: 'shared_skill_publisher', route: null } } });
    expect(check.details.skill_paths.samples.map((ghost: { slug: string }) => ghost.slug)).toEqual([SKILL]);
    expect(check.message).toContain(`${SOURCE}:${SKILL}`);
  }), 120_000);

  test('a per-item caller refusal during the apply is recorded refused with its code and the rest still applies', () => fixture(async f => {
        const preview = await repair(f.engine);
    installFaultHook(async (at, detail) => {
      if (at !== 'consumer:preparing' || detail.operation !== 'submit_job') return;
      const [row] = await f.engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE id=$1', [detail.writeId]);
      if (row?.slug === 'notes/b') throw opError('skill_bundle_required', 'Knowledge writes cannot change the canonical shared skillpack.', 'Forced per-item refusal.');
    });
    const applied = await repair(f.engine, { apply: true, expect: preview.preview_hash });
    expect(applied).toMatchObject({ applied: 2, outcomes: { soft_deleted: 2, refused: 1 } });
    expect(applied.outcome_items!.find(item => item.item === `${SOURCE}:notes/b`)).toMatchObject({ outcome: 'refused', reason: 'skill_bundle_required' });
    expect(await live(f.engine, 'notes/a')).toBe(false);
    expect(await live(f.engine, 'notes/b')).toBe(true);
    expect(await live(f.engine, 'notes/c')).toBe(false);
  }), 120_000);
});
