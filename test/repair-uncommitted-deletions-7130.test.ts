/**
 * #7130 (reported by @liuwenyong1985): before the fix a managed sync soft-deleted pages whose recorded file Git never
 * held (a write-through file in a .gitignore'd directory, an untracked file removed before any commit), and the purge
 * removed them for good after 72 h. For brains already hit, on a real managed brain (PGLite, and Postgres through the
 * E2E wrapper), this protects:
 * - doctor `uncommitted_sync_deletions` warns about exactly the sync-deleted tombstones whose file is ignored or never
 *   committed (a committed then git-rm'd control, and a page another writer deleted, never warn; a
 *   `sync-delete-tombstone` marker naming the page counts as a sync deletion);
 * - `gbrain repair uncommitted-deletions --source <id>` previews them with a hash and the purge caveat, refuses a wrong
 *   hash (preview_changed), exits 3 without --yes, and with the right hash restores each live and detached
 *   (database-only, no file written); the next sync, incremental and full, keeps them live and the control deleted;
 * - off the owner host the doctor check is not_applicable and the repair refuses not_owner_host.
 */
import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { resolveRepairScope, type RepairKind } from '../src/core/repair/core.ts';
import { EXPLICIT_REPAIR_REGISTRY, repairRunner } from '../src/core/repair/registry.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { uncommittedSyncDeletionsEntry } from '../src/commands/doctor/checks/uncommitted-sync-deletions.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const KIND = 'uncommitted-deletions' as RepairKind;
const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`, `The committed body of notes/${name}.`));
  commit(root, 'notes');
};

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await fn(); } finally { console.log = original; process.stdout.write = write; }
  return printed;
}

async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const pageRow = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ live: boolean; source_path: string | null; database_only_reason: string | null }>(
  "SELECT deleted_at IS NULL AS live, source_path, database_only_reason FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0];
const doctor = async (engine: BrainEngine) => (await uncommittedSyncDeletionsEntry.run({ engine } as never) as Array<Record<string, any>>)[0]!;
const repair = async (engine: BrainEngine, opts: { apply?: boolean; expect?: string; includeAmbiguous?: boolean } = {}) => (await repairRunner(engine, { apply: opts.apply === true, logger }))
  .run(KIND, await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', expect: opts.expect, includeAmbiguous: opts.includeAmbiguous });

/** Imports untracked files from the working tree (working mode), then returns to committed mode. */
async function importUntracked(engine: BrainEngine, root: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), note(path.replace(/\.md$/, ''), body)); }
  await engine.setConfig('sync.include_working_tree', 'true');
  expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
  await engine.setConfig('sync.include_working_tree', 'false');
}

/** A coordinated delete_page; `asSync` stamps its committed receipt as the pre-#7130 sync's managed_sync_delete (the deletion this repair undoes). */
async function softDelete(engine: BrainEngine, ctx: OperationContext, slug: string, asSync: boolean) {
  const requestId = randomUUID();
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: requestId } });
  await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed',
    { timeoutMs: 20_000, label: `delete_page ${slug} commits` });
  if (asSync) await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw(`UPDATE persistence_requests SET intent=jsonb_set(intent, '{kind}', '"managed_sync_delete"') WHERE request_id=$1::uuid`, [requestId]);
  });
}

/**
 * notes/draft (untracked, never committed) and scratch/agent (its directory later .gitignore'd) are sync-deleted the
 * pre-fix way; notes/hand (untracked) is deleted by hand; notes/c is committed, then git rm'd and deleted by a real sync.
 */
async function hitBrain(engine: BrainEngine, ctx: OperationContext, root: string) {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await importUntracked(engine, root, { 'notes/draft.md': 'An untracked draft only the brain holds.', 'notes/hand.md': 'An untracked note deleted by hand.',
    'scratch/agent.md': 'An agent page written to scratch/.' });
  writeFileSync(join(root, '.gitignore'), 'scratch/\n');
  git(root, 'add', '.gitignore'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'ignore scratch');
  await softDelete(engine, ctx, 'notes/draft', true);
  await softDelete(engine, ctx, 'scratch/agent', true);
  await softDelete(engine, ctx, 'notes/hand', false);
  rmSync(join(root, 'notes/draft.md'), { force: true }); rmSync(join(root, 'notes/hand.md'), { force: true }); rmSync(join(root, 'scratch'), { recursive: true, force: true });
  git(root, 'rm', '-q', 'notes/c.md'); commit(root, 'remove c');
  await performManagedSync(engine, OPTS);
  expect((await pageRow(engine, 'notes/c'))!.live).toBe(false);
  for (const slug of ['notes/draft', 'scratch/agent', 'notes/hand']) expect((await pageRow(engine, slug))!.live).toBe(false);
}

for (const backend of testBackends()) describe(`[${backend}] #7130: restoring pages a sync deleted although Git never held their file`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => _resetCliExitVerdictForTests());
  afterEach(() => _resetCliExitVerdictForTests());

  test('doctor lists only the uncommitted sync deletions; preview, wrong hash, consent, apply; the next sync keeps them live', () => managedBrain(async ({ engine, ctx, root }) => {
    await hitBrain(engine, ctx, root);
    expect(categorizeCheck('uncommitted_sync_deletions')).toBeDefined();
    const found = await doctor(engine);
    expect(found).toMatchObject({ name: 'uncommitted_sync_deletions', status: 'warn', details: { count: 2, other_writer_count: 1, exact: true } });
    expect(found.details.samples.map((page: { slug: string; evidence: string }) => [page.slug, page.evidence]).sort()).toEqual([['notes/draft', 'never_committed'], ['scratch/agent', 'ignored']]);
    expect(found.message).toContain('gbrain repair uncommitted-deletions --source default');
    expect(found.message).toContain('only a backup');
    expect(found.fix.argv).toEqual(['gbrain', 'repair', 'uncommitted-deletions', '--source', 'default', '--json']);

    expect(EXPLICIT_REPAIR_REGISTRY.map(spec => spec.kind)).toContain(KIND);
    const preview = JSON.parse(await capture(() => runRepairCommand(engine, ['uncommitted-deletions', '--source', 'default', '--json']))).results[0];
    expect(preview.listing.map((entry: { item: string; class: string }) => [entry.item, entry.class]).sort()).toEqual([
      ['default:notes/draft', 'restore:never_committed'], ['default:notes/hand', 'excluded:deleted_by_other'], ['default:scratch/agent', 'restore:ignored']]);
    expect(preview.affected).toBe(2);
    expect(preview.warnings[0]).toContain('Pages already purged cannot be restored by this command');
    expect(preview.apply_command).toBe(`gbrain repair uncommitted-deletions --source default --apply --expect ${preview.preview_hash} --yes`);
    expect((await repair(engine, { includeAmbiguous: true })).affected).toBe(3);

    expect((await refusal(() => repair(engine, { apply: true, expect: 'f'.repeat(64) }))).code).toBe('preview_changed');
    const priorExitCode = process.exitCode;
    await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() =>
      runRepairCommand(engine, ['uncommitted-deletions', '--source', 'default', '--apply', '--expect', preview.preview_hash, '--json'])));
    expect(currentExitCode()).toBe(3);
    process.exitCode = priorExitCode ?? 0;
    _resetCliExitVerdictForTests();
    expect((await pageRow(engine, 'notes/draft'))!.live).toBe(false);

    const applied = JSON.parse(await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() =>
      runRepairCommand(engine, ['uncommitted-deletions', '--source', 'default', '--apply', '--expect', preview.preview_hash, '--yes', '--json'])))).results[0];
    expect(applied).toMatchObject({ mode: 'apply', applied: 2, skipped: 0, failed: [], complete: true, outcomes: { restored_detached: 2 } });
    for (const slug of ['notes/draft', 'scratch/agent']) expect(await pageRow(engine, slug)).toEqual({ live: true, source_path: null, database_only_reason: 'detached' });
    expect(existsSync(join(root, 'notes/draft.md')) || existsSync(join(root, 'scratch/agent.md'))).toBe(false);

    // The next sync, incremental and full, keeps them live; the committed-then-removed control and the hand delete stay deleted.
    await performManagedSync(engine, OPTS);
    await performManagedSync(engine, { ...OPTS, full: true });
    for (const slug of ['notes/draft', 'scratch/agent']) expect(await pageRow(engine, slug)).toEqual({ live: true, source_path: null, database_only_reason: 'detached' });
    expect((await pageRow(engine, 'notes/c'))!.live).toBe(false);
    expect((await pageRow(engine, 'notes/hand'))!.live).toBe(false);
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { count: 0, other_writer_count: 1 } });
  }, { databaseUrl, setup }), 240_000);

  test('a sync tombstone marker counts as a sync deletion; off the owner host the doctor check is not applicable and the repair refuses not_owner_host', () => managedBrain(async ({ engine, ctx, root }) => {
    await hitBrain(engine, ctx, root);
    const [hand] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug='notes/hand'");
    await engine.executeRaw("INSERT INTO op_checkpoints(op, fingerprint, completed_keys) VALUES ('sync-delete-tombstone', $1, '[]'::jsonb)", [String(hand!.id)]);
    expect(await doctor(engine)).toMatchObject({ status: 'warn', details: { count: 3, other_writer_count: 0 } });
    const hash = (await repair(engine)).preview_hash!;
    await withEnv({ GBRAIN_HOME: join(dirname(root), 'other-host') }, async () => {
      expect(await doctor(engine)).toMatchObject({ status: 'ok', readiness_state: 'not_applicable', details: { reason: 'not_owner_host' } });
      expect((await refusal(() => repair(engine))).code).toBe('not_owner_host');
      expect((await refusal(() => repair(engine, { apply: true, expect: hash }))).code).toBe('not_owner_host');
    });
    expect((await pageRow(engine, 'notes/draft'))!.live).toBe(false);
  }, { databaseUrl, setup }), 240_000);
});
