/**
 * #7145: a doctor check that stops at one of its own bounds reports health unknown, naming the bound
 * (`details.reason: 'bound'`, `details.bound`, `details.exact: false`), never a known warn or a clear ok.
 * Synthetic directories and an in-memory PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { findMisroutedPages } from '../src/core/multi-source-drift.ts';
import { multiSourceDriftCheck } from '../src/commands/doctor/schema-pack-checks.ts';

const dirs: string[] = [];
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `gbrain-7145-${label}-`));
  dirs.push(d);
  return d;
};

describe('multi_source_drift stopped at its bound is unknown', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('src-a','src-a')");
  }, 60_000);
  afterAll(async () => {
    await engine.disconnect();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('the file limit: health unknown with the bound named, not drift detected', async () => {
    const root = tmp('files');
    for (let i = 0; i < 12; i++) writeFileSync(join(root, `p-${i}.md`), 'x\n');
    const result = await findMisroutedPages(engine, [{ id: 'src-a', local_path: root }], { limit: 5, timeoutMs: 60_000 });
    expect(result.truncated_by).toBe('files');
    const check = multiSourceDriftCheck(result, 1, 'local');
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ health: 'unknown', reason: 'bound', bound: 'files', limit: 5, exact: false, verified: false });
    expect(check.message).toContain('unknown');
    expect(check.message).toContain('file limit (5 files per source, GBRAIN_DRIFT_LIMIT)');
  });

  test('the time limit is named as the time bound', async () => {
    const root = tmp('time');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'p.md'), 'x\n');
    const timed = await findMisroutedPages(engine, [{ id: 'src-a', local_path: root }], { limit: 1000, timeoutMs: 0 });
    expect(timed.truncated_by).toBe('time');
    const check = multiSourceDriftCheck(timed, 1, 'remote');
    expect(check.details).toMatchObject({ health: 'unknown', reason: 'bound', bound: 'time', exact: false });
    expect(check.message).toContain('GBRAIN_DRIFT_TIMEOUT_MS');
  });

  test('drift found before the bound is kept as a floor', () => {
    const check = multiSourceDriftCheck({ walk_truncated: true, truncated_by: 'files', count: 2,
      sample: [{ slug: 'notes/alice-example', intended_source: 'src-a', local_path: '/synthetic' }],
      git_root_skipped: [], unreadable_sources: [], limit: 5, timeout_ms: 5000 }, 1, 'local');
    expect(check.details).toMatchObject({ health: 'unknown', drift_found_so_far: 2 });
    expect(check.message).toContain('At least 2 misrouted slug(s)');
    expect(check.message).toContain('notes/alice-example');
  });
});
