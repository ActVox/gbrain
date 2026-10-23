/**
 * #7436: the pending-import check (a page write onto a file that differs from the database) ran Git synchronously, up
 * to 30 s per call, so a slow checkout froze the owner process (its lease renewals and every other preparation) while
 * one page was prepared, and the stall line blamed the last statement (`waiting_on=db last_sql=SELECT_sources`).
 * Git now runs as an awaited child process, and the step's stamp says `waiting_on=git` while it runs.
 * A `git` shim on PATH that sleeps before each call stands in for the slow checkout. Managed PGLite brain, no providers.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterClaimStep, startClaimPhase, type WaitingOn } from '../src/core/persistence/claim-phase.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';

const slug = 'people/alice-example';
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

describe('#7436 pending-import Git check during page preparation', () => {
  test.skipIf(process.platform === 'win32')('keeps the event loop running and stamps waiting_on=git while Git runs', () => managedBrain(async ({ engine, ctx, root }) => {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: '---\ntype: person\ntitle: Alice\n---\n\nBody.\n' } });
    const file = join(root, `${slug}.md`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('Body.', 'Body.\n\nAnother agent added this line through Git.'));
    git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'agent commit not yet imported');
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    const [binding] = await engine.executeRaw<{ worktree_id: string }>("SELECT worktree_id FROM persistence_source_bindings WHERE source_id='default'");
    const realGit = Bun.which('git')!;
    const shims = mkdtempSync(join(tmpdir(), 'gbrain-slow-git-'));
    writeFileSync(join(shims, 'git'), `#!/bin/sh\nsleep 0.4\nexec "${realGit}" "$@"\n`);
    chmodSync(join(shims, 'git'), 0o755);
    const clock = startClaimPhase();
    enterClaimStep(clock, 'link_resolution', undefined, 'db');
    let ticks = 0;
    const seen = new Set<WaitingOn>();
    const timer = setInterval(() => { ticks++; seen.add(clock.waitingOn); }, 20);
    try {
      const outcome = await withEnv({ PATH: `${shims}:${process.env.PATH}` }, () =>
        prepareFileTarget(engine, { source_id: 'default', worktree_id: binding!.worktree_id, slug }, snapshot, 'replacement\n', undefined, { clock })
          .then(() => null, (error: { reason?: string }) => error));
      expect(outcome?.reason).toBe('pending_import');
    } finally { clearInterval(timer); rmSync(shims, { recursive: true, force: true }); }
    // At least two shimmed Git calls (0.8 s): a synchronous spawn let the 20 ms timer run at most once in that time.
    expect(ticks).toBeGreaterThanOrEqual(10);
    expect(seen.has('git')).toBe(true);
    expect(clock.waitingOn).toBe('db');
    expect(clock.step).toBe('link_resolution');
  }, { setup }), 120_000);
});
