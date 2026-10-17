import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Large pages flip lane C: a segmented write's publication drops the chunk rows
// a dead preparation staged under its new generation (persistence/segmented-apply.ts,
// `page_id::bigint = $1 AND body_generation = $2`). Every other content_chunks
// index leads with page_id, so for a page created after the table's last ANALYZE
// (its page_id is in no statistic) the planner estimates one row on each of them
// and picks the smallest, idx_chunks_page, walking every chunk row of the page
// inside the publication transaction: 2.4k rows for an 8 MiB page, against the
// ~100 the generation holds. The statement names the page through a cast that only
// this index carries, so it is the one index that can answer it whatever the
// statistics; a plain `page_id =` lookup never uses it. Partial like
// content_chunks_generation_idx (inline chunks have no generation). Built online
// (CONCURRENTLY on Postgres); an interrupted build leaves an INVALID index that
// the next initSchema drops and rebuilds.
export const CONTENT_CHUNKS_STAGED_GENERATION_INDEX = {
  name: 'content_chunks_staged_generation_idx',
  table: 'content_chunks',
  sql: 'CREATE INDEX IF NOT EXISTS content_chunks_staged_generation_idx ON content_chunks ((page_id::bigint), body_generation) WHERE body_generation IS NOT NULL',
};

export const v258: Migration = {
  version: 258,
  name: 'staged_generation_chunk_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 257, CONTENT_CHUNKS_STAGED_GENERATION_INDEX, { notice: migrationNotice });
  },
};
