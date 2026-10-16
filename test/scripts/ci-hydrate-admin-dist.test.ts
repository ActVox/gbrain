/**
 * #6756: ci:local mounts the named volume gbrain-ci-admin-dist over
 * /app/admin/dist, and a new named volume starts empty, so a fresh checkout's
 * `bun run build` failed on the hashed admin bundles src/admin-embedded.ts
 * imports. The runner now copies the worktree's admin/dist (mounted read-only
 * at /ci-src/admin-dist) into the volume before the build: an exact copy of
 * the current worktree bytes, stale hashed files removed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'scripts/ci-hydrate-admin-dist.sh');
const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-admin-dist-'));
  homes.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

function listing(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else out[r] = readFileSync(join(dir, r), 'utf8');
    }
  };
  walk('');
  return out;
}

const hydrate = (src: string, dest: string) => spawnSync('bash', [SCRIPT, src, dest], { encoding: 'utf8' });
const WORKTREE = { 'index.html': '<script src="/assets/index-NEW.js">', 'assets/index-NEW.js': 'new bundle', 'assets/logo.svg': '<svg/>' };

describe('#6756 ci:local hydrates the admin/dist volume from the worktree', () => {
  test('cold: an empty volume gets the worktree bytes', () => {
    const src = tree(WORKTREE), dest = join(tree({}), 'dist');
    const r = hydrate(src, dest);
    expect(r.status, r.stderr).toBe(0);
    expect(listing(dest)).toEqual(WORKTREE);
  });

  test('warm: a volume already matching stays identical', () => {
    const src = tree(WORKTREE), dest = tree(WORKTREE);
    expect(hydrate(src, dest).status).toBe(0);
    expect(listing(dest)).toEqual(WORKTREE);
  });

  test('changed bundle: a file whose bytes changed in the worktree is replaced', () => {
    const src = tree(WORKTREE), dest = tree({ ...WORKTREE, 'assets/logo.svg': '<svg old/>' });
    expect(hydrate(src, dest).status).toBe(0);
    expect(listing(dest)).toEqual(WORKTREE);
  });

  test('deleted bundle: stale hashed files from an older build are removed', () => {
    const src = tree(WORKTREE);
    const dest = tree({ 'index.html': '<script src="/assets/index-OLD.js">', 'assets/index-OLD.js': 'old bundle', '.vite/manifest.json': '{}' });
    expect(hydrate(src, dest).status).toBe(0);
    expect(listing(dest)).toEqual(WORKTREE);
  });

  test('a worktree without admin/dist/index.html refuses with the remedy and leaves the volume alone', () => {
    const src = tree({}), dest = tree({ 'index.html': 'kept' });
    const r = hydrate(src, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('git checkout -- admin/dist');
    expect(listing(dest)).toEqual({ 'index.html': 'kept' });
  });

  test('the runner mounts the worktree admin/dist read-only and hydrates after git setup, before the build', () => {
    const compose = Bun.YAML.parse(readFileSync(join(ROOT, 'docker-compose.ci.yml'), 'utf8')) as { services: { runner: { volumes: string[] } } };
    expect(compose.services.runner.volumes).toContain('./admin/dist:/ci-src/admin-dist:ro');
    expect(compose.services.runner.volumes).toContain('gbrain-ci-admin-dist:/app/admin/dist');
    const source = readFileSync(join(ROOT, 'scripts/ci-local.sh'), 'utf8');
    const template = source.slice(source.indexOf("INNER_CMD=$(cat <<'EOF'"), source.indexOf('__RUN_PHASES__'));
    const hydrateAt = template.indexOf('bash scripts/ci-hydrate-admin-dist.sh /ci-src/admin-dist admin/dist');
    expect(hydrateAt).toBeGreaterThan(template.indexOf('safe.directory'));
    expect(hydrateAt).toBeLessThan(template.indexOf('bun run build'));
    expect(existsSync(SCRIPT)).toBe(true);
  });
});
