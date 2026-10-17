/**
 * #6712 PR 4b lane M (design v3.2 §2.5, eng F7): every page-row deletion of a managed Git source writes its origin's
 * deletion marker in the same transaction, so the classifier never reads a purged page's file as a new one. This lint
 * refuses a new page-row deleter in src/ (`.deletePage(`, `.deletePages(`, raw `DELETE FROM pages`) that is not a
 * reviewed caller below, and asserts the two deleters a managed source reaches call `writeOriginDeletedMarker` right
 * before the delete. A new caller either goes through the helper (and joins MARKED) or names why a managed Git source
 * never reaches it.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const PATTERN = /\.deletePages?\(|DELETE FROM pages\b/g;

/** The deleters a managed Git source reaches: each delete must follow `writeOriginDeletedMarker(` within three lines. */
const MARKED: Record<string, number> = {
  'src/core/persistence/page-purge.ts': 1, // delete_page --purge, manual and retention (the coordinator's purge transaction)
  'src/core/belief/purge-mirror.ts': 1, // the restore-time purge replay
};

/** Reviewed callers a managed Git source never reaches, with the number of matches each file may hold. */
const REVIEWED: Record<string, { count: number; why: string }> = {
  'src/core/pglite-engine.ts': { count: 2, why: 'engine methods forwarding to engine-sql/pages.ts' },
  'src/core/postgres-engine.ts': { count: 2, why: 'engine methods forwarding to engine-sql/pages.ts' },
  'src/core/engine-sql/pages.ts': { count: 3, why: 'the engine implementations themselves' },
  'src/core/engine.ts': { count: 1, why: 'doc comment of deletePages' },
  'src/core/engine-constants.ts': { count: 1, why: 'doc comment of the batch bound' },
  'src/core/bootstrap/verify.ts': { count: 1, why: 'unmanaged brains only; a managed brain removes its probe pages through delete_page --purge' },
  'src/core/transcripts/ingest.ts': { count: 1, why: 'unmanaged brains only; a managed brain deletes stale parts through the coordinator' },
  'src/core/persistence/purge-deleted.ts': { count: 1, why: 'unmanaged retention (expireRecordedTombstones); a managed brain purges through delete_page --purge' },
  'src/commands/migrate-engine.ts': { count: 1, why: 'engine migration copy, outside any source write' },
  'src/core/github-source.ts': { count: 2, why: 'GitHub connector source, not a managed Git checkout' },
  'src/core/google/google-source.ts': { count: 1, why: 'Google connector source' },
  'src/core/google/sweep-shared.ts': { count: 1, why: 'Google connector sweep' },
};

function scan(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const path of new Bun.Glob('src/**/*.ts').scanSync({ cwd: ROOT })) {
    const lines = readFileSync(join(ROOT, path), 'utf8').split('\n');
    lines.forEach((line, i) => { for (const _ of line.matchAll(PATTERN)) found.set(path, [...(found.get(path) ?? []), i]); });
  }
  return found;
}

test('no page-row deleter outside the reviewed callers', () => {
  const found = scan();
  const unexpected = [...found].filter(([path, hits]) => (MARKED[path] ?? REVIEWED[path]?.count) !== hits.length)
    .map(([path, hits]) => `${path}: ${hits.length} page-row deletion(s); expected ${MARKED[path] ?? REVIEWED[path]?.count ?? 0}`);
  expect(unexpected).toEqual([]);
  const stale = [...Object.keys(MARKED), ...Object.keys(REVIEWED)].filter(path => !found.has(path));
  expect(stale).toEqual([]);
});

test('the deleters a managed Git source reaches write the deletion marker right before the delete', () => {
  const found = scan();
  for (const [path, count] of Object.entries(MARKED)) {
    const lines = readFileSync(join(ROOT, path), 'utf8').split('\n');
    const hits = found.get(path) ?? [];
    expect(hits).toHaveLength(count);
    for (const line of hits) expect({ path, line: line + 1, marked: lines.slice(Math.max(0, line - 3), line).some(prior => prior.includes('writeOriginDeletedMarker(')) })
      .toEqual({ path, line: line + 1, marked: true });
  }
});
