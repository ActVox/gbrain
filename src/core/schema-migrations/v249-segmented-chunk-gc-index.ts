import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Segmented page storage (v248), follow-up:
// - content_chunks.retired_generation is dropped. Nothing writes it: the flip
//   and the projection delete the rows they retire, and a row awaiting a
//   deferred retirement is hidden by its occurrence's closed manifest range
//   (chunkGenerationFilter), so the predicates that read it were always true.
// - content_chunks_generation_idx serves segment GC's staged-chunk delete
//   (`c.body_generation IS NOT NULL AND c.body_generation > p.body_generation`,
//   engine-sql/page-body.ts sweepSegments), which the resident maintenance
//   worker runs about once a minute: without it every tick scanned the whole
//   table, inline chunks included. Partial, so inline chunks (body_generation
//   NULL) are not in it; built online (CONCURRENTLY on Postgres).
export const CONTENT_CHUNKS_GENERATION_INDEX = {
  name: 'content_chunks_generation_idx',
  table: 'content_chunks',
  sql: 'CREATE INDEX IF NOT EXISTS content_chunks_generation_idx ON content_chunks (page_id, body_generation) WHERE body_generation IS NOT NULL',
};

export const v249: Migration = {
  version: 249,
  name: 'segmented_chunk_gc_index',
  idempotent: true,
  transaction: false,
  sql: 'ALTER TABLE content_chunks DROP COLUMN IF EXISTS retired_generation;',
  handler: async engine => {
    await buildIndexOnline(engine, 249, CONTENT_CHUNKS_GENERATION_INDEX, { notice: migrationNotice });
  },
};
