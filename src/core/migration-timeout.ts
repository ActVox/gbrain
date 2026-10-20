/**
 * #7108: the last schema migration that used up its statement budget, kept in
 * config so `gbrain apply-migrations` and `gbrain doctor` can name it and the
 * next step that actually helps. Before this, both said "rerun
 * apply-migrations --yes", which repeats the failure when no session is
 * blocking: the migration's own work outlasts the budget on every attempt.
 *
 * runMigrations writes the record when a migration's SQL times out (SQLSTATE
 * 57014, or the retry wrapper exhausting its attempts) and deletes it after a
 * pass applies every pending migration. Readers use it only while the schema
 * is still below the recorded migration.
 */
import type { BrainEngine } from './engine.ts';
import type { Action } from './agent-output.ts';
import { VERSION } from '../version.ts';

export const MIGRATION_TIMEOUT_KEY = 'schema_migration_timeout';

/** The one-run budget the advice offers when a migration times out with nothing blocking it. */
const LONG_BUDGET_MINUTES = 120;

/** Statement budget for one migration transaction on Postgres; it overrides a lower server default (Supabase enforces about 2 minutes). */
const MIGRATION_STATEMENT_TIMEOUT_MS = 600_000;
let statementTimeoutMs = MIGRATION_STATEMENT_TIMEOUT_MS;

export function migrationStatementTimeoutMs(): number {
  return statementTimeoutMs;
}

/** `gbrain apply-migrations --statement-timeout` (operator only; 0 removes the limit) and tests; null restores the default. */
export function setMigrationStatementTimeoutMs(ms: number | null): void {
  statementTimeoutMs = ms ?? MIGRATION_STATEMENT_TIMEOUT_MS;
}

export interface MigrationTimeoutRecord {
  version: number;
  name: string;
  /** Idle-in-transaction sessions seen holding locks after the last attempt. */
  blocker_pids: number[];
  /** The gbrain release that ran the migration. */
  gbrain_version: string;
  at: string;
}

/** Best effort: a failing database must not hide the migration error being reported. */
export async function recordMigrationTimeout(engine: BrainEngine, m: { version: number; name: string }, blockerPids: number[]): Promise<void> {
  const record: MigrationTimeoutRecord = { version: m.version, name: m.name, blocker_pids: blockerPids, gbrain_version: VERSION, at: new Date().toISOString() };
  await engine.setConfig(MIGRATION_TIMEOUT_KEY, JSON.stringify(record)).catch(() => {});
}

export async function clearMigrationTimeout(engine: BrainEngine): Promise<void> {
  await engine.unsetConfig(MIGRATION_TIMEOUT_KEY).catch(() => {});
}

/** The recorded timeout when the schema is still below that migration; null otherwise or when unreadable. */
export async function readMigrationTimeout(engine: BrainEngine, schemaVersion: number): Promise<MigrationTimeoutRecord | null> {
  try {
    const record = JSON.parse((await engine.getConfig(MIGRATION_TIMEOUT_KEY)) ?? 'null') as MigrationTimeoutRecord | null;
    return record && Number.isInteger(record.version) && record.version > schemaVersion ? record : null;
  } catch {
    return null;
  }
}

/**
 * What to tell the user about a recorded timeout, as one sentence and the fix.
 * A different gbrain release recorded it: this one may run the migration
 * differently (v221 backfills in committed batches since #7108), so rerun.
 * A blocking session was seen: ending it (with the user's agreement) and
 * rerunning can work. Otherwise the same release fails the same way, so the
 * fix is one run with a longer budget, after the user agrees (its table locks
 * are held that long).
 */
export function migrationTimeoutAdvice(record: MigrationTimeoutRecord, verify: { argv: string[] }): { message: string; fix: Action } {
  const which = `Migration v${record.version} (${record.name})`;
  const rerun = ['gbrain', 'apply-migrations', '--yes'];
  if (record.gbrain_version !== VERSION) {
    return {
      message: `${which} ran out of its statement budget under gbrain ${record.gbrain_version}; this gbrain (${VERSION}) may apply it, so run gbrain apply-migrations --yes.`,
      fix: { argv: rerun, consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `The timeout was recorded by gbrain ${record.gbrain_version}; this release may run v${record.version} differently (long backfills run in committed batches since #7108). Each batch that commits is kept, so a rerun resumes.` },
    };
  }
  if (record.blocker_pids.length > 0) {
    const pids = record.blocker_pids.join(', ');
    return {
      message: `${which} ran out of its statement budget while idle-in-transaction session(s) ${pids} held locks; end them, then run gbrain apply-migrations --yes.`,
      fix: { ask_user: true, argv: rerun, consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `Session(s) ${pids} were idle in a transaction while v${record.version} waited; the rerun works once they are gone.`,
        user_message: `gbrain migration v${record.version} timed out while database session(s) ${pids} sat idle in a transaction. With your agreement, end them on the database host (SELECT pg_terminate_backend(<pid>)), then run gbrain apply-migrations --yes. Go ahead?` },
    };
  }
  return {
    message: `${which} used its whole statement budget on every attempt under this gbrain (${VERSION}) with no session blocking it, so a plain rerun repeats the failure; with the user's agreement, rerun it with a longer budget.`,
    fix: { ask_user: true, argv: [...rerun, '--statement-timeout', String(LONG_BUDGET_MINUTES)], consent: [], actor: 'agent', requires_exclusive: true, verify,
      why: `v${record.version}'s own work outlasts the default migration statement budget on this brain; the same release fails the same way every run unless the budget is raised for one run.`,
      user_message: `gbrain migration v${record.version} (${record.name}) times out on this brain on every attempt, and nothing is blocking it. A plain rerun fails the same way. It can run once with a ${LONG_BUDGET_MINUTES}-minute budget (gbrain apply-migrations --yes --statement-timeout ${LONG_BUDGET_MINUTES}); while it runs, writes to the table it changes wait. Please also report it at https://github.com/garrytan/gbrain/issues with the output of gbrain doctor --json. Run it now?` },
  };
}
