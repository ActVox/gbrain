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
  // claims and source guards, the receipt true-up, publicationTransaction). A new opt-in is reviewed here first.
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
      'core/persistence/effect-journal.ts': 2,
      'core/persistence/effects.ts': 2,
      'core/persistence/journal.ts': 3,
      'core/persistence/publication-deadline.ts': 2,
      'core/persistence/receipt-true-up.ts': 1,
    });
  });
});
