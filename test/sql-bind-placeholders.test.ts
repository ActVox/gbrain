/**
 * One guard for the bind-placeholder bug class (#6659):
 * Postgres and PGLite refuse a statement that binds a parameter it never
 * references (42P18 "could not determine data type", or 08P01 "bind message
 * supplies N parameters"). Each exported `{ sql, params }` builder runs over
 * its platform/option matrix, and the `$n` placeholders its SQL references
 * must be exactly `1..params.length`.
 */
import { describe, expect, test } from 'bun:test';
import { fileClaimCandidatesQuery } from '../src/core/persistence/file-claims.ts';

function referenced(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)(?!\d)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
}
function expectEveryBindReferenced(statement: { sql: string; params: unknown[] } | null): void {
  expect(statement).not.toBeNull();
  expect(referenced(statement!.sql)).toEqual(statement!.params.map((_, i) => i + 1));
}

describe('file-claim census', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    test(`${platform}: every bound placeholder is referenced`, () => {
      expectEveryBindReferenced(fileClaimCandidatesQuery({
        sourceId: 'default', pageId: 1, afterId: 0, maxId: 10, fileName: 'example.md', uriNames: ['example.md'],
      }, platform));
    });
  }
});
