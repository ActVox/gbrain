/**
 * GBRA-156: a transaction opted in with `pipelineFirst: isPersistenceDeclaration` sends its first statement with
 * BEGIN, before BEGIN's answer. If BEGIN fails that statement runs in autocommit, so the test must accept the
 * declarations protocol.ts sends (transaction-local set_config, the brain row FOR SHARE) and nothing else. The
 * driver behaviour is proven through PgBouncer by test/e2e/pgbouncer-transaction-pipeline-6930.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { declareDurablePersistence, declarePersistenceProtocol, isPersistenceDeclaration } from '../src/core/persistence/protocol.ts';
import { declarePublication } from '../src/core/persistence/publication-deadline.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type postgres from '#postgres';
import { reservedTransactions } from '../src/core/postgres-engine/reserved-transactions.ts';

function recorder(kind = 'postgres'): { engine: BrainEngine; sent: string[] } {
  const sent: string[] = [];
  const engine = { kind, executeRaw: async (sql: string) => { sent.push(sql); return [{ brain: null }]; } } as unknown as BrainEngine;
  return { engine, sent };
}

describe('isPersistenceDeclaration', () => {
  test('accepts every declaration protocol.ts and the publication send', async () => {
    const { engine, sent } = recorder();
    await declarePersistenceProtocol(engine);
    await declareDurablePersistence(engine);
    await declareDurablePersistence(engine, '100ms', '5000ms', '30000ms');
    await declarePublication(engine);
    expect(sent.length).toBe(4);
    expect(sent.map(isPersistenceDeclaration)).toEqual([true, true, true, true]);
  });

  test('refuses writes, session settings, other locks and anything after the declaration', () => {
    const share = '(SELECT brain_id::text FROM persistence_brain WHERE singleton=1 FOR SHARE) AS brain';
    for (const statement of [
      'INSERT INTO persistence_requests DEFAULT VALUES',
      "SELECT set_config('gbrain.persistence_protocol','2',false)",
      "SELECT set_config('gbrain.persistence_protocol','2',true); DELETE FROM persistence_requests",
      "SELECT set_config('gbrain.persistence_protocol','2',true),(SELECT brain_id::text FROM persistence_brain WHERE singleton=1 FOR UPDATE) AS brain",
      "WITH gone AS (DELETE FROM persistence_requests RETURNING 1) SELECT set_config('lock_timeout','1s',true)",
      "SELECT set_config('lock_timeout',(SELECT 'x'),true)",
      "SELECT set_config('lock_timeout','1s;',true)",
      "SELECT set_config('lock_timeout','1s',true);",
      `SELECT set_config('gbrain.persistence_protocol','2',true),${share},(SELECT 1)`,
      'SELECT 1',
    ]) expect({ statement, accepted: isPersistenceDeclaration(statement) }).toEqual({ statement, accepted: false });
  });
});

describe('pipelineFirst call sites', () => {
  // Each of these opens its transaction with a protocol declaration (journal admitWrite and claimNextWrite, the effect
  // claims and source guards, the receipt true-up, the single publication, the consumer's lent lane transactions) and
  // needs nothing to happen only after BEGIN's answer (a lane group's begun mark does, so group publication passes none).
  // A new opt-in is reviewed here first.
  test('only the reviewed persistence call sites opt in, and only with isPersistenceDeclaration', () => {
    const root = join(import.meta.dir, '..', 'src');
    const found: Record<string, number> = {};
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!name.endsWith('.ts')) continue;
        const text = readFileSync(path, 'utf8');
        const uses = text.match(/pipelineFirst:\s*[^,}\s]+/g) ?? [];
        if (uses.length) found[relative(root, path)] = uses.length;
        for (const use of uses) expect({ path, use }).toEqual({ path, use: 'pipelineFirst: isPersistenceDeclaration' });
      }
    };
    walk(root);
    expect(found).toEqual({
      'core/persistence/consumer.ts': 1,
      'core/persistence/coordinator.ts': 1,
      'core/persistence/effect-journal.ts': 2,
      'core/persistence/effects.ts': 2,
      'core/persistence/journal.ts': 3,
      'core/persistence/receipt-true-up.ts': 1,
    });
  });
});

/**
 * A reserved connection on a non-pipelining pool whose queries are lazy like postgres.js's: created by the tagged call or
 * `unsafe`, sent through their `handler` when executed. Records each send with whether BEGIN had been answered.
 */
type LazyQuery = {
  strings: readonly string[]; args: unknown[]; reject(e: unknown): void; executed: boolean; handler(self: LazyQuery): void; execute(): LazyQuery;
  then(a?: (v: unknown) => unknown, b?: (e: unknown) => unknown): Promise<unknown>; catch(b: (e: unknown) => unknown): Promise<unknown>;
};
function lazyReserved(beginFails: boolean) {
  const sent: Array<{ text: string; beginAnswered: boolean }> = [];
  let beginAnswered = false;
  const query = (strings: readonly string[], args: unknown[]) => {
    let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    promise.catch(() => undefined);
    const text = strings.reduce((a, s, i) => a + '$' + i + s);
    // A thenable, not a native promise: `await` calls its `then`, which executes it, as a postgres.js Query does.
    const q: LazyQuery = {
      strings, args, reject, executed: false,
      handler: self => {
        sent.push({ text, beginAnswered });
        if (text === 'begin') setTimeout(() => { beginAnswered = true; beginFails ? self.reject(Object.assign(new Error('no server connection available'), { code: '08P01' })) : resolve(Object.assign([], { command: 'BEGIN' })); }, 20);
        else resolve(Object.assign([], { command: text.toUpperCase() }));
      },
      execute: () => { if (!q.executed) { q.executed = true; void Promise.resolve().then(() => q.handler(q)); } return q; },
      then: (a, b) => { q.execute(); return promise.then(a, b); },
      catch: b => q.then(undefined, b),
    };
    return q;
  };
  const reserved = Object.assign((strings: TemplateStringsArray, ...args: unknown[]) => query([...strings], args), {
    unsafe: (text: string, args: unknown[] = []) => query([text], args), options: { max_pipeline: 0 }, discard: () => undefined,
  }) as unknown as postgres.ReservedSql;
  return { reserved, sent };
}
type Handle = { unsafe(text: string, args?: unknown[]): Promise<unknown>; savepoint(fn: (child: unknown) => Promise<unknown>): Promise<unknown> }
  & ((strings: TemplateStringsArray, ...args: unknown[]) => Promise<unknown>);
const beginFirst = (reserved: postgres.ReservedSql, body: (sql: Handle) => Promise<unknown>) =>
  (reservedTransactions(reserved) as unknown as { begin(o: object, fn: typeof body): Promise<unknown> }).begin({ first: isPersistenceDeclaration }, body);
const DECLARATION = "SELECT set_config('gbrain.persistence_protocol','2',true)";

describe('reserved transactions: the declaration goes out with BEGIN', () => {
  test('only the accepted declaration is sent before BEGIN\'s answer; the next statement and COMMIT wait', async () => {
    const { reserved, sent } = lazyReserved(false);
    await beginFirst(reserved, async sql => { await sql.unsafe(DECLARATION); await sql.unsafe('insert into t values (1)'); });
    expect(sent).toEqual([{ text: 'begin', beginAnswered: false }, { text: DECLARATION, beginAnswered: false },
      { text: 'insert into t values (1)', beginAnswered: true }, { text: 'commit', beginAnswered: true }]);
  });

  test('a refused BEGIN: the declaration ran alone, no write is sent even when the body swallows its rejection, and begin rejects with BEGIN\'s error', async () => {
    const { reserved, sent } = lazyReserved(true);
    let swallowed: unknown;
    const error = await beginFirst(reserved, async sql => {
      await sql.unsafe(DECLARATION);
      swallowed = await sql.unsafe('insert into t values (1)').then(() => 'sent', (e: { code?: string }) => e.code);
      return 'returned';
    }).then(() => null, (e: { code?: string }) => e.code);
    expect(error).toBe('08P01');
    expect(swallowed).toBe('08P01');
    expect(sent.map(s => s.text).filter(t => t !== 'rollback')).toEqual(['begin', DECLARATION]);
  });

  test('a write first, a fragment argument and a savepoint all wait for BEGIN\'s answer', async () => {
    for (const body of [
      async (sql: Handle) => { await sql.unsafe('insert into t values (1)'); },
      async (sql: Handle) => { await sql`SELECT set_config('lock_timeout',${{ fragment: true }},true)`; },
      async (sql: Handle) => { await sql.savepoint(async () => undefined); },
    ]) {
      const { reserved, sent } = lazyReserved(false);
      await beginFirst(reserved, body);
      expect(sent[0]).toEqual({ text: 'begin', beginAnswered: false });
      expect(sent.slice(1).every(s => s.beginAnswered)).toBe(true);
    }
  });
});

