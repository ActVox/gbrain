import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('destructive-guard test environment isolation', () => {
  test('cold-init setup never mutates the shard-wide snapshot env directly', () => {
    const source = readFileSync(resolve(import.meta.dir, 'destructive-guard.test.ts'), 'utf8');

    const forbiddenMutation = ['delete ', 'process', '.env.', 'GBRAIN_PGLITE_SNAPSHOT'].join('');
    expect(source).not.toContain(forbiddenMutation);
    expect(source).toContain('withColdPglite');
  });
});
