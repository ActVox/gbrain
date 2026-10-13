import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import postgres from '#postgres';
import pkg from '../package.json';

describe('vendored Postgres driver packaging', () => {
  test('all supported imports use checked-in source, not node_modules patch installation', () => {
    expect(pkg.imports['#postgres']).toEqual({
      types: './vendor/postgres/types/index.d.ts',
      require: './vendor/postgres/cjs/src/index.js',
      default: './vendor/postgres/src/index.js',
    });
    expect('postgres' in pkg.dependencies).toBe(false);
    expect('patchedDependencies' in pkg).toBe(false);
    expect(import.meta.resolve('#postgres')).toContain('/vendor/postgres/src/index.js');
    expect(createRequire(import.meta.url).resolve('#postgres')).toContain('/vendor/postgres/cjs/src/index.js');
    expect(typeof postgres).toBe('function');
    expect(typeof createRequire(import.meta.url)('#postgres')).toBe('function');
  });

  test('preserves pinned upstream metadata and actual license', () => {
    const upstream = JSON.parse(readFileSync(new URL('../vendor/postgres/package.json', import.meta.url), 'utf8'));
    expect(upstream.name).toBe('postgres');
    expect(upstream.version).toBe('3.4.9');
    expect(upstream.license).toBe('Unlicense');
    expect(readFileSync(new URL('../vendor/postgres/UNLICENSE', import.meta.url), 'utf8')).toContain('free and unencumbered software');
  });

  test('all shipped runtime exports carry the cancellation ownership patch', () => {
    for (const path of ['src', 'cjs/src', 'cf/src']) {
      const index = readFileSync(new URL(`../vendor/postgres/${path}/index.js`, import.meta.url), 'utf8');
      expect(index).toContain('async function reserve({ signal } = {})');
      expect(index).toContain('sql.discard = reservation.discard');
      expect(index).toContain('completed.cancelPromise');
      expect(index).toContain('return poisoned(c)');
      expect(index).toContain('cancelActive(query, resolve, reject, Math.min(delay * 2, 1000))');
      expect(index).toContain('function ondesync(c, info)');
      const connection = readFileSync(new URL(`../vendor/postgres/${path}/connection.js`, import.meta.url), 'utf8');
      expect(connection).not.toContain('while (sent.length && (query = sent.shift()) && (query.active = true, query.cancelled))');
      expect(connection).toContain('} else if (query.cancelled) {');
      expect(connection).toContain('function answersStatement(xs, x)');
    }
  });

  test('#6543: all three shipped copies carry the A1 close reset, the A2 build-failure pipelining gate and the A7 parameter index (offline; update-postgres.sh --check is the networked proof)', () => {
    for (const path of ['src', 'cjs/src', 'cf/src']) {
      const connection = readFileSync(new URL(`../vendor/postgres/${path}/connection.js`, import.meta.url), 'utf8');
      // A1: a closed socket's ErrorResponse and partial result never reach the replacement connection's first statement.
      expect(connection).toContain('query = errorResponse = results = null');
      expect(connection).toContain('result = new Result()');
      // A2: a build failure obeys max_pipeline and onexecute (stock: `write(Unbuildable)` then `return true`); onexecute runs only after build.
      expect(connection).toContain('let mayPipeline = !q.options.onexecute');
      expect(connection).toMatch(/build\(q\)\n\s+mayPipeline = mayPipeline \|\| q\.options\.onexecute\(connection\)/);
      expect(connection).toMatch(/return write\(Unbuildable\)\n\s+&& sent\.length < max_pipeline\n\s+&& mayPipeline/);
      expect(connection).not.toMatch(/write\(Unbuildable\)\n\s+return true/);
      // A7: onbuilderror names the undefined parameter.
      expect(connection).toContain("statementText(q), error && error.parameter)");
      const types = readFileSync(new URL(`../vendor/postgres/${path}/types.js`, import.meta.url), 'utf8');
      expect(types).toContain('(parameter $');
    }
    expect(readFileSync(new URL('../vendor/postgres/types/index.d.ts', import.meta.url), 'utf8')).toContain('parameter?: number');
  });
});
