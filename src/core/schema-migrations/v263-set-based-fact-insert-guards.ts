import type { Migration } from './types.ts';
import { FACT_INSERT_GUARD_SQL } from '../facts/insert-guard-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7105: the facts purge refusal and withdrawal stamp run once per INSERT
// statement (one AFTER INSERT ... REFERENCING NEW TABLE trigger,
// facts/insert-guard-schema.ts) instead of once per inserted row. The per-row
// facts_refuse_purged and facts_preserve_withdrawal triggers keep their
// functions and now fire on UPDATE only. Trigger DDL only: no row changes.
export const v263: Migration = {
  version: 263,
  name: 'set_based_fact_insert_guards',
  idempotent: true,
  sql: FACT_INSERT_GUARD_SQL,
};
