/**
 * #6911: tables an applied migration should have created but the live brain lacks. The schema version only says
 * which migrations ran, so a table dropped afterwards (or swallowed by a pooler) stays invisible to
 * `apply-migrations` and `db-repair`. The expected set is the graduation inventory, which
 * test/graduation-inventory.test.ts pins to a fully migrated brain on each engine, so it covers tables that only a
 * migration creates (query_cache is not in schema.sql). Read-only; `gbrain repair missing-tables` recreates the
 * rebuildable ones after a preview.
 */
import type { BrainEngine } from './engine.ts';
import { LATEST_VERSION } from './migrate.ts';
import { GRADUATION_INVENTORY } from './persistence/graduation-inventory.ts';
import { isRebuildableCache } from './persistence/rebuildable-cache.ts';
import { v055 } from './schema-migrations/v055-query-cache-search-lite.ts';
import { v056 } from './schema-migrations/v056-query-cache-knobs-hash.ts';
import { v059 } from './schema-migrations/v059-code-traversal-cache-v0-34.ts';
import { hnswIndexExpected, readExistingEmbeddingShape } from './vector-index.ts';

export interface MissingTable {
  table: string;
  /** The graduation inventory class: `rebuild` tables hold only regenerable cache rows. */
  inventory_class: string;
  /** `gbrain repair missing-tables` can recreate it empty in its head shape. */
  recreatable: boolean;
}

export type MissingTablesReport = { status: 'checked'; checked: number; missing: MissingTable[] } | { status: 'skipped'; reason: 'schema_not_at_head'; version: number; latest: number };

/**
 * Recreate a rebuildable cache table empty, in the shape a fully migrated brain has: its creating migration, then
 * every later column and index statement that targets it (v090 and v091 add one column each to query_cache inside
 * migrations that also rewrite pages, so only those statements run here). Every statement is IF NOT EXISTS.
 * test/schema-missing-tables.test.ts compares the recreated catalog with a fresh brain's, so a later migration that
 * changes one of these tables without a line here fails that test.
 */
export const RECREATE: Readonly<Record<string, (engine: BrainEngine) => Promise<void>>> = {
  query_cache: async engine => {
    // v055 sizes the column from config; an embedding migration since then resized facts and query_cache together, so
    // the live facts column is the shape a never-dropped query_cache would have.
    const shape = await readExistingEmbeddingShape(engine, 'facts');
    if (shape) await engine.runMigration(55, queryCacheDdl(shape.type, shape.dimensions));
    else await v055.handler!(engine);
    await engine.runMigration(56, v056.sql);
    await engine.runMigration(90, "ALTER TABLE query_cache ADD COLUMN IF NOT EXISTS page_generations JSONB NOT NULL DEFAULT '{}'::jsonb;");
    await engine.runMigration(91, 'ALTER TABLE query_cache ADD COLUMN IF NOT EXISTS max_generation_at_store BIGINT NOT NULL DEFAULT 0;');
  },
  code_traversal_cache: async engine => { await engine.runMigration(59, v059.sql); },
};

/** v055's DDL for a known vector shape (the table, its source index and, when pgvector can build one, its HNSW index). */
function queryCacheDdl(type: 'vector' | 'halfvec', dims: number): string {
  const hnsw = hnswIndexExpected(type, dims)
    ? `CREATE INDEX IF NOT EXISTS idx_query_cache_embedding_hnsw ON query_cache USING hnsw (embedding ${type === 'halfvec' ? 'halfvec_cosine_ops' : 'vector_cosine_ops'}) WHERE embedding IS NOT NULL;`
    : '';
  return `CREATE TABLE IF NOT EXISTS query_cache (
      id TEXT PRIMARY KEY, query_text TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT 'default', embedding ${type.toUpperCase()}(${dims}),
      results JSONB NOT NULL DEFAULT '[]'::jsonb, meta JSONB NOT NULL DEFAULT '{}'::jsonb, ttl_seconds INTEGER NOT NULL DEFAULT 3600,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), hit_count INTEGER NOT NULL DEFAULT 0, last_hit_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS idx_query_cache_source_created ON query_cache(source_id, created_at DESC);
    ${hnsw}`;
}

export async function readMissingTables(engine: BrainEngine): Promise<MissingTablesReport> {
  const version = parseInt((await engine.getConfig('version')) || '0', 10);
  if (version !== LATEST_VERSION) return { status: 'skipped', reason: 'schema_not_at_head', version, latest: LATEST_VERSION };
  const expected = GRADUATION_INVENTORY.entries.filter(e => e.kind === 'table' && e.engines[engine.kind]);
  const rows = await engine.executeRaw<{ relation: string }>('SELECT r AS relation FROM unnest($1::text[]) AS r WHERE to_regclass(r) IS NULL ORDER BY r',
    [expected.map(e => e.relation)]);
  const byName = new Map(expected.map(e => [e.relation, e]));
  return { status: 'checked', checked: expected.length, missing: rows.map(({ relation }) => ({ table: relation, inventory_class: byName.get(relation)!.class,
    recreatable: isRebuildableCache(relation) && relation in RECREATE })) };
}
