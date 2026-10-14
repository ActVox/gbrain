/**
 * #6696 B1: the ops-tier sections of `gbrain doctor --tier ops` — "what is
 * wrong right now", answered in seconds. Each entry is tagged `tier: 'ops'`, so
 * the default run puts them first (registry order) and `--tier ops` runs only
 * them, under one absolute deadline (./budget.ts).
 *
 * Sections owned here: managed write capacity, terminal write failures, receipt
 * compaction freshness and schema-pack consistency. The other ops sections are
 * tagged where they live: `embedding_state` (embedding coverage),
 * `managed_sync_not_moving` (sync cursor movement and age) and
 * `serve_build_drift` (serve build drift).
 *
 * On PGLite the ops tier reads only counters, config and catalog: an entry with
 * `opsPglite: 'not_applicable'` (it aggregates request or page tables) reports
 * `not_applicable` there instead of running.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkPersistenceCapacity } from './persistence-capacity.ts';
import { terminalFailuresCheck } from './persistence-requests.ts';
import { checkSchemaPackConsistency } from '../schema-pack-checks.ts';
import { LAST_COMPACTION_KEY, readCapacityView } from '../../../core/persistence/capacity-view.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';

/** A consumer that has not compacted receipts for this long, while one is live, warns. */
export const COMPACTION_STALE_HOURS = 24;
const COMPACTION_DOCS = 'docs/guides/troubleshooting.md#receipt-compaction';

async function runPersistenceCapacity(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('persistence_capacity');
  checks.push(await checkPersistenceCapacity(connectedEngine(ctx)));
  return checks;
}

export const persistenceCapacityEntry: DoctorEntry = {
  name: 'persistence_capacity',
  emits: ['persistence_capacity'],
  tier: 'ops',
  run: runPersistenceCapacity,
};

async function runTerminalFailures(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('persistence_terminal_failures');
  const check = await terminalFailuresCheck(connectedEngine(ctx), doctorSourceIds(ctx));
  if (check) checks.push({ ...check, name: 'persistence_terminal_failures' });
  return checks;
}

export const terminalFailuresEntry: DoctorEntry = {
  name: 'persistence_terminal_failures',
  emits: ['persistence_terminal_failures'],
  tier: 'ops',
  opsPglite: 'not_applicable',
  run: runTerminalFailures,
};

/**
 * Receipt compaction freshness: the consumer records its last compaction under
 * `persistence.maintenance.last_compaction`. Nothing recorded is information
 * (a build or brain that has not compacted yet); a record older than 24 h while a
 * persistence consumer heartbeats warns, because receipts then keep their full
 * reservation and capacity only grows.
 */
async function runReceiptCompaction(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('receipt_compaction');
  const engine = connectedEngine(ctx);
  try {
    const { last_compaction: last } = await readCapacityView(engine);
    if (!last) {
      checks.push(infoCheck('receipt_compaction', `No receipt compaction recorded yet (${LAST_COMPACTION_KEY} is unset): the persistence consumer records one after it compacts.`,
        'not_applicable', undefined, { recorded: false, docs: COMPACTION_DOCS }));
      return checks;
    }
    const ageHours = (Date.now() - Date.parse(last.at)) / 3_600_000;
    const live = await engine.executeRaw<{ n: string }>(
      "SELECT count(*)::text AS n FROM persistence_consumers WHERE renewed_at > now() - interval '5 minutes'").catch(() => [{ n: '0' }]);
    const details = { recorded: true, last_compaction: last, age_hours: Math.round(ageHours * 10) / 10, stale_after_hours: COMPACTION_STALE_HOURS, live_consumers: Number(live[0]?.n ?? 0), docs: COMPACTION_DOCS };
    if (ageHours > COMPACTION_STALE_HOURS && details.live_consumers > 0) {
      checks.push({ name: 'receipt_compaction', status: 'warn', details,
        message: `The last receipt compaction ran ${Math.round(ageHours)} h ago (${last.at}${last.host ? ` on ${last.host}` : ''}) while a persistence consumer is live: retained receipts keep their reservation, so write capacity only grows.`,
        fix: agentFix(['gbrain', 'sources', 'writer', 'status', '--json'], 'Read-only: names the live consumer, its version and its last maintenance step.', 'receipt_compaction', { docs: COMPACTION_DOCS }) });
    } else {
      checks.push({ name: 'receipt_compaction', status: 'ok', details,
        message: `Receipts last compacted ${Math.round(ageHours)} h ago (${last.at})${last.compacted !== undefined ? `, ${last.compacted} receipt(s)` : ''}.` });
    }
  } catch (error) {
    checks.push(checkError('receipt_compaction', 'read the last receipt compaction', error, { details: { health: 'unknown', docs: COMPACTION_DOCS } }));
  }
  return checks;
}

export const receiptCompactionEntry: DoctorEntry = {
  name: 'receipt_compaction',
  emits: ['receipt_compaction'],
  tier: 'ops',
  run: runReceiptCompaction,
};

async function runSchemaPackConsistency(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('schema_pack_consistency');
  const sourceIds = doctorSourceIds(ctx);
  checks.push(await checkSchemaPackConsistency(connectedEngine(ctx), sourceIds ? { sourceIds } : {}));
  return checks;
}

export const schemaPackConsistencyEntry: DoctorEntry = {
  name: 'schema_pack_consistency',
  emits: ['schema_pack_consistency'],
  tier: 'ops',
  opsPglite: 'not_applicable',
  run: runSchemaPackConsistency,
};
