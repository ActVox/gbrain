/**
 * #5409: a per-source read-only mirror (`sources.config.mirror_read_only`),
 * on PGLite and, with a safe DATABASE_URL, Postgres
 * (test/e2e/sources-mirror-read-only-postgres.test.ts).
 *
 * Protects: with the flag on, managed sync imports a file whose canonical form
 * differs (no frontmatter) database-only and leaves the checkout's bytes and
 * `git status` clean, so the next upstream commit fast-forwards and syncs; a
 * page write into the source is stored database-only and says so
 * (`storage: "database_only"`). With the flag off (the default) both paths
 * keep writing the canonical file. `sources mirror-readonly|mirror-writable`
 * set and clear the flag and `sources list --json` reports it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { runSources } from '../src/commands/sources.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string, message = 'upstream'): string {
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

for (const backend of testBackends()) {
  describe(`read-only mirror sources (${backend})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-mirror-read-only-'));
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
    }, 120_000);
    afterAll(async () => {
      await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
      if (close) await close(); else await engine.disconnect();
      rmSync(home, { recursive: true, force: true });
    });

    const TODOS = '# Todos\n\n- ship the mirror flag\n';

    /** A managed Git source whose TODOS.md has no frontmatter, so its canonical form differs from its bytes. */
    async function mirror(readOnly: boolean) {
      const id = `mirror-${randomUUID().slice(0, 8)}`;
      const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
      writeFileSync(join(root, 'TODOS.md'), TODOS);
      commit(root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
      await claimWorktree(engine, id, root);
      if (readOnly) await cli(['mirror-readonly', id]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      return { id, root };
    }
    async function cli(args: string[]): Promise<string> {
      const lines: string[] = [];
      const original = console.log;
      console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
      try { await runSources(engine, args); } finally { console.log = original; }
      return lines.join('\n');
    }
    const ctx = (sourceId: string) => ({ engine, sourceId, remote: false as const, dryRun: false,
      config: { engine: engine.kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } });

    test('sources mirror-readonly / mirror-writable set the flag and sources list --json reports it', () => withEnv({ GBRAIN_HOME: home }, async () => {
      const id = `mirror-cli-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{\"federated\":true}')", [id]);
      const listed = async () => (JSON.parse(await cli(['list', '--json'])) as { sources: Array<{ id: string; mirror_read_only: boolean; federated: boolean }> })
        .sources.find(source => source.id === id)!;
      expect(await listed()).toMatchObject({ mirror_read_only: false, federated: true });
      expect(await cli(['mirror-readonly', id])).toContain(`Source "${id}" is now a read-only mirror`);
      expect(await listed()).toMatchObject({ mirror_read_only: true, federated: true });
      expect(await cli(['mirror-writable', id])).toContain(`Source "${id}" is writable again`);
      expect(await listed()).toMatchObject({ mirror_read_only: false, federated: true });
    }), 60_000);

    /** First sync, a database-only tag, then an upstream edit: the canonical form now differs from the file's bytes (an overlay). */
    async function overlaySync(m: { id: string; root: string }) {
      expect(await performManagedSync(engine, { sourceId: m.id, noPull: true })).toMatchObject({ status: 'first_sync', filesImported: 1 });
      await engine.transaction(tx => withCoordinatedWrite(tx, [m.id], () => tx.addTag('todos', 'kept-in-brain', { sourceId: m.id })));
      writeFileSync(join(m.root, 'TODOS.md'), `${TODOS}- keep the mirror pullable\n`);
      commit(m.root, 'upstream edit');
      expect(await performManagedSync(engine, { sourceId: m.id, noPull: true })).toMatchObject({ filesImported: 1 });
    }
    const tracked = (root: string) => git(root, 'status', '--porcelain', '--untracked-files=no');

    test('read-only: an overlay imports database-only, the checkout stays clean, and the next upstream commit syncs', () => withEnv({ GBRAIN_HOME: home }, async () => {
      const m = await mirror(true);
      await overlaySync(m);
      expect(readFileSync(join(m.root, 'TODOS.md'), 'utf8')).toBe(`${TODOS}- keep the mirror pullable\n`);
      expect(tracked(m.root)).toBe('');
      const page = (await engine.readPageSnapshot('todos', { sourceId: m.id }))!;
      expect(page.page.compiled_truth).toContain('keep the mirror pullable');
      expect(page.tags).toContain('kept-in-brain');
      const [receipt] = await engine.executeRaw<{ outcome: Record<string, unknown> }>(
        "SELECT outcome FROM persistence_requests WHERE source_id=$1 AND slug='todos' AND state='committed' ORDER BY sequence DESC LIMIT 1", [m.id]);
      expect(receipt.outcome).toMatchObject({ storage: 'database_only', write_through: { written: false, skipped: 'mirror_read_only' } });
      writeFileSync(join(m.root, 'TODOS.md'), `${TODOS}- keep the mirror pullable\n- and again\n`);
      commit(m.root, 'second upstream edit');
      expect(await performManagedSync(engine, { sourceId: m.id, noPull: true })).toMatchObject({ filesImported: 1 });
      expect(tracked(m.root)).toBe('');
      expect((await engine.getPage('todos', { sourceId: m.id }))?.compiled_truth).toContain('and again');
    }), 120_000);

    test('writable (default): the overlay is written back into the checkout', () => withEnv({ GBRAIN_HOME: home }, async () => {
      const m = await mirror(false);
      await overlaySync(m);
      expect(readFileSync(join(m.root, 'TODOS.md'), 'utf8')).toContain('kept-in-brain');
      expect(tracked(m.root)).toBe('M TODOS.md');
    }), 120_000);

    test('a page write into a read-only mirror is stored database-only and says so; a writable source gets its file', () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const readOnly of [true, false]) {
        const m = await mirror(readOnly);
        const receipt = await submitPageMutation(ctx(m.id), { operation: 'put_page', params: { slug: 'notes/agent-note', request_id: randomUUID(),
          content: '---\ntitle: Agent note\ntype: note\n---\nWritten by an agent.\n' } }) as Record<string, unknown>;
        expect((await engine.getPage('notes/agent-note', { sourceId: m.id }))?.compiled_truth).toContain('Written by an agent.');
        if (readOnly) {
          expect(receipt).toMatchObject({ storage: 'database_only', write_through: { written: false, skipped: 'mirror_read_only' } });
          expect(existsSync(join(m.root, 'notes/agent-note.md'))).toBe(false);
          expect(tracked(m.root)).toBe('');
        } else {
          expect(receipt).not.toHaveProperty('storage');
          expect(receipt.write_through).toMatchObject({ written: true });
          expect(existsSync(join(m.root, 'notes/agent-note.md'))).toBe(true);
        }
      }
    }), 120_000);
  });
}
