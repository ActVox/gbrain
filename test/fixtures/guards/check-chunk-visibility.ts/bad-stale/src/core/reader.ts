import { chunkVisibleFilter } from './safe-chunks.ts';

export const visibleSql = `SELECT c.chunk_text FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE ${chunkVisibleFilter('p', 'c')}`;

export const maintenanceSql = `SELECT count(*) FROM content_chunks c -- chunk-visibility-ok: counts every row for a maintenance report
  WHERE c.page_id = $1`;

