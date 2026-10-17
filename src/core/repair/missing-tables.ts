/**
 * `gbrain repair missing-tables` (#6911): recreate, empty, a rebuildable cache table that the applied migrations
 * created but the brain no longer has (`doctor` check schema_missing_tables). The schema version is already at head,
 * so `apply-migrations` never runs the creating migration again. Only tables the graduation inventory classifies
 * `rebuild` and that have a recreate step qualify; any other missing table holds user data and is listed for the
 * operator (restore it from a backup), never recreated empty.
 *
 * Explicit-only and preview-bound: the preview prints the tables and a hash, and `--apply --expect <hash>` recreates
 * exactly that set. It never runs on upgrade, apply-migrations, db-repair or the maintenance cycle. DDL only (IF NOT
 * EXISTS); no journal admission and no user data changes. Brain-wide.
 */
import { OperationError } from '../ops/contract.ts';
import { clearApprovedSet, loadApprovedSet, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { relationExists } from '../persistence/rebuildable-cache.ts';
import { readMissingTables, RECREATE } from '../schema-missing-tables.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairPlan } from './core.ts';

const PREVIEW = 'gbrain repair missing-tables';
const toItem = (table: string, position: number): RepairItem => ({ cursor: { phase: 0, id: position + 1 }, source_id: '(brain)', slug: table, chars: 0,
  action: 'recreate_empty' });

export const missingTablesRepair: RepairHandler = {
  kind: 'missing-tables',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after, opts = { apply: false }): Promise<RepairPlan> {
    if (opts.apply) {
      if (!opts.expect) throw new OperationError('invalid_params', 'gbrain repair missing-tables --apply needs the preview hash.',
        `Preview first: ${PREVIEW} — then run the apply command it prints: ${PREVIEW} --apply --expect <preview-hash>`, 'docs/guides/repair.md#missing-tables');
      const { items: tables } = await loadApprovedSet<string>(engine, { command: 'missing-tables', hash: opts.expect, previewCommand: PREVIEW });
      const items = tables.map(toItem).filter(item => afterCursor(item.cursor, after));
      if (!items.length) await clearApprovedSet(engine, { command: 'missing-tables', hash: opts.expect });
      return { items, preview_hash: opts.expect, residuals: {} };
    }
    const report = await readMissingTables(engine);
    if (report.status === 'skipped') {
      return { items: [], residuals: {}, warnings: [`The schema is at v${report.version}, not v${report.latest}; run gbrain apply-migrations --yes first, then preview again.`] };
    }
    const tables = report.missing.filter(m => m.recreatable).map(m => m.table);
    const kept = report.missing.filter(m => !m.recreatable);
    const hash = previewHash({ kind: 'missing-tables-v1', brain_id: scope.brain_id, tables });
    if (tables.length) await saveApprovedSet<string>(engine, { command: 'missing-tables', hash }, tables);
    return { items: tables.map(toItem), ...(tables.length ? { preview_hash: hash } : {}), residuals: kept.length ? { user_data_tables: kept.length } : {},
      details: { checked: report.checked, recreate: tables, user_data_tables: kept.map(m => m.table) } };
  },
  async apply(ctx, item, opts) {
    const recreate = RECREATE[item.slug];
    if (!recreate) return { applied: false, outcome: 'refused', reason: 'not_rebuildable' };
    const existed = await relationExists(ctx.engine, item.slug);
    // Every statement is IF NOT EXISTS and runs in one transaction, so a rerun finishes a table an interrupted run left without its later columns.
    try {
      await ctx.engine.transaction(tx => recreate(tx));
    } catch (error) {
      if ((error as { code?: string }).code !== '42501') throw error;
      throw new OperationError('schema_owner_required', `This database role may not create ${item.slug}, so nothing was recreated.`,
        `Connect as the role that owns the brain tables (the one apply-migrations uses) and run: ${PREVIEW} --apply --expect ${opts?.expect ?? '<preview-hash>'}`, 'docs/guides/repair.md#missing-tables');
    }
    if (!await relationExists(ctx.engine, item.slug)) {
      throw new OperationError('storage_error', `Recreating ${item.slug} ran, but the table still does not exist.`,
        'Run gbrain doctor --json and report the schema_missing_tables entry.');
    }
    return { applied: true, outcome: existed ? 'completed' : 'recreated' };
  },
  render(details) {
    const d = details as { checked?: number; recreate?: string[]; user_data_tables?: string[] };
    return [
      `  ${d.checked ?? 0} expected table(s) checked`,
      ...(d.recreate ?? []).map(t => `  recreate empty: ${t} (rebuildable cache; it refills on use)`),
      ...(d.user_data_tables ?? []).map(t => `  kept: ${t} holds user data; restore it from a backup, it is never recreated empty`),
    ];
  },
};
