import type { Migration } from './types.ts';
import { migrateConnectorAliasCheckpoints } from '../persistence/connector-checkpoint-migration.ts';

export const v248: Migration = {
  // #6561: v0.60.176.0 hashed Google's new default `contactsDir` into the
  // connector identity, re-keying every Google checkpoint. The identity now
  // elides the default (the pre-field key again) and keeps the interim key as
  // an alias. Carry each source's interim cursor to the stable key when the
  // stable key has none, or when the interim cursor is the newer completed
  // one (the older is kept under the alias). Handler-only, statement-at-a-time
  // (one two-statement transaction per swap), rerun-safe. Placeholder number:
  // the integrator renumbers at merge.
  version: 248, name: 'connector_checkpoint_default_leaf_alias', idempotent: true, sql: '',
  handler: async engine => { await migrateConnectorAliasCheckpoints(engine); },
};
