/**
 * `gbrain facts relink` storage DDL (#5836): one canonical copy used by the
 * schema migration and, through scripts/build-schema.ts FRAGMENTS, by
 * fresh-install DDL.
 *
 * fact_relink_attempts keeps one row per fact: the latest relink outcome
 * (a model verdict memo, a `linked`/`deduped` record, or a `pending` journal
 * entry the unmanaged path writes before it touches the fence file). Like
 * decide_sweep_deferred it carries no foreign key (facts is created by
 * migrations after this DDL); readers join facts. `journal` is text, not
 * JSONB, so no code path can double-encode it.
 */

const rls = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;

export const FACT_RELINK_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS fact_relink_attempts (
  source_id       TEXT NOT NULL,
  fact_id         BIGINT NOT NULL,
  outcome         TEXT NOT NULL,
  reason          TEXT,
  tier            TEXT,
  model           TEXT,
  target_slug     TEXT,
  planned_row_num INTEGER,
  journal         TEXT,
  run_id          TEXT,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, fact_id)
);
CREATE INDEX IF NOT EXISTS fact_relink_attempts_outcome_idx ON fact_relink_attempts (source_id, outcome, attempted_at);
${rls('fact_relink_attempts')}
`;

/**
 * Keyset index for relink's candidate walk. Migration-only (the facts table is
 * itself created by migrations, after the fresh-install DDL); CONCURRENTLY on
 * Postgres.
 */
export const FACT_UNLINKED_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_facts_unlinked_active ON facts (source_id, id) WHERE entity_slug IS NULL AND expired_at IS NULL;`;

export const FACT_RELINK_SCHEMA_SQL = FACT_RELINK_TABLE_SQL;
