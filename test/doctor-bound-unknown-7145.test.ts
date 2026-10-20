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
import { conversationOutcomesStaleCheck, OUTCOME_SCAN_CAP } from '../src/commands/doctor/checks/conversation-outcomes.ts';
import { missingRecordedFilesEntry } from '../src/commands/doctor/checks/missing-recorded-files.ts';
import { __setMissingFilesScanLimitForTests } from '../src/core/persistence/detached-pages.ts';
import { CONVERSATION_EXTRACTOR_VERSION, TERMINAL_AUDIT_SOURCE } from '../src/core/facts/audit-sources.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

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

describe('conversation_outcomes_stale and missing_recorded_files stopped at their row bound are unknown', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    __setMissingFilesScanLimitForTests(null);
    await engine.disconnect();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('conversation_outcomes_stale: no stale outcome among the newest capped rows is unknown, not clear', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('src-conv','src-conv')");
    await engine.executeRaw(`INSERT INTO facts(source_id, source, fact, context, source_markdown_slug, kind)
      SELECT 'src-conv', $1, 'EXTRACTION_COMPLETE', 'synthetic; extractor_version=' || $2::int, 'conversations/c-' || g, 'fact' FROM generate_series(1, $3::int) g`,
      [TERMINAL_AUDIT_SOURCE, CONVERSATION_EXTRACTOR_VERSION, OUTCOME_SCAN_CAP + 1]);
    const check = await conversationOutcomesStaleCheck(engine, ['src-conv']);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ health: 'unknown', reason: 'bound', bound: 'rows', limit: OUTCOME_SCAN_CAP, exact: false, capped: true });
    expect(check.message).toContain(`only the newest ${OUTCOME_SCAN_CAP} outcome rows were read`);
  }, 60_000);

  test('missing_recorded_files: a source read only up to the scan limit is unknown when clean, and a found page is a floor', async () => {
    const dir = tmp('checkout');
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes', 'kept.md'), '# kept\n');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('src-files','src-files',$1)", [dir]);
    for (const path of ['notes/kept.md', 'blobs/b-1.bin', 'blobs/b-2.bin']) {
      await engine.executeRaw("INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, source_path) VALUES('src-files', $1, 'note', 't', '', '', '{}'::jsonb, $2)",
        [path.replace(/\.[a-z]+$/, ''), path]);
    }
    __setMissingFilesScanLimitForTests(2);
    const run = async () => ((await missingRecordedFilesEntry.run({ engine, sourceIds: ['src-files'] } as unknown as DoctorContext)) as Check[])[0]!;
    const clean = await run();
    expect(clean.status).toBe('warn');
    expect(clean.details).toMatchObject({ health: 'unknown', reason: 'bound', bound: 'rows', limit: 2, exact: false });
    expect(clean.message).toContain('the scan stops at 2 live pages per source');
    await engine.executeRaw("UPDATE pages SET source_path='notes/gone.md' WHERE source_id='src-files' AND slug='blobs/b-1'");
    const found = await run();
    expect(found.status).toBe('warn');
    expect(found.details).toMatchObject({ count: 1, exact: false });
    expect(found.message).toStartWith('At least 1 live page(s)');
  }, 60_000);
});
