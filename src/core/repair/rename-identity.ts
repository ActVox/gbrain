/**
 * `gbrain repair rename-identity [--source <id>]` (#6729): carry a page's identity across an inexact Git rename that
 * sync split into a delete plus an add because it could not confirm the pair (sync-rename-identity.ts). Explicit-only
 * and preview-bound: the preview lists each open downgrade (inside its 72-hour window, old page still soft-deleted, new
 * page live) with what stays on the old slug, and saves the set under a hash; `--apply --expect <hash>` carries exactly
 * that set with the sync rename lane's own carrier (`carryRenameIdentity`: an `old -> new` slug redirect, slug-keyed
 * facts, aliases and withdrawals, and page-id-keyed links, timeline and versions move onto the new page) and closes
 * each record. A pair that is no longer open, or whose new page moved, is kept and counted.
 */
import { carryRenameIdentity } from '../../commands/sync/renames.ts';
import { OperationError } from '../ops/contract.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { clearIdentityDowngrade, identityDowngradeReasonText, listIdentityDowngrades, type IdentityDowngrade } from '../sync-identity-downgrades.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

type Approved = IdentityDowngrade & { selection: string[] };
type CarryItem = RepairItem & { record: IdentityDowngrade; hash: string; last: boolean };

const previewCommand = (scope: RepairScope) => `gbrain repair rename-identity${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;

function item(record: IdentityDowngrade, index: number, hash: string, last: boolean): CarryItem {
  return { cursor: { phase: 0, id: index + 1 }, source_id: record.source_id, slug: record.old_slug, chars: 0, action: 'carry_identity',
    change: { from: record.old_slug, to: record.new_slug! }, record, hash, last };
}

const describe = (record: IdentityDowngrade) => `${record.from} -> ${record.to} (git similarity ${record.similarity}%; ${identityDowngradeReasonText(record.reason)}): `
  + `${record.facts} fact(s), ${record.links} link(s), ${record.aliases} alias(es) move from ${record.old_slug} to ${record.new_slug}; window ends ${record.expires_at}`;

export const renameIdentityRepair = {
  kind: 'rename-identity' as const,
  publication: 'projection' as const,
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (!opts?.apply) {
      const open = (await listIdentityDowngrades(engine, scope.source_ids)).filter(record => record.new_slug !== null);
      const hash = previewHash({ kind: 'rename-identity-v1', brain_id: scope.brain_id, selection: scope.source_ids,
        pairs: open.map(record => [record.source_id, record.old_page_id, record.old_slug, record.new_slug, record.recorded_at]) });
      if (open.length) await saveApprovedSet<Approved>(engine, { command: 'rename-identity', hash }, open.map(record => ({ ...record, selection: scope.source_ids })));
      const unimported = (await listIdentityDowngrades(engine, scope.source_ids)).length - open.length;
      return { items: open.map((record, index) => item(record, index, hash, index === open.length - 1)), preview_hash: hash,
        residuals: unimported ? { new_file_not_imported: unimported } : {},
        listing: open.map(record => ({ item: `${record.source_id}:${record.old_slug}`, class: record.reason, detail: describe(record) })) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair rename-identity --apply carries only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`, 'docs/guides/live-sync.md#renaming-a-page');
    }
    const approved = await loadApprovedSet<Approved>(engine, { command: 'rename-identity', hash: opts.expect, previewCommand: command });
    if (approved.items.some(entry => JSON.stringify(entry.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map(({ selection: _selection, ...record }, index) => item(record, index, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { record, hash, last } = entry as CarryItem;
    try {
      const open = (await listIdentityDowngrades(ctx.engine, [record.source_id])).find(candidate => candidate.old_page_id === record.old_page_id);
      const [fresh] = await ctx.engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [record.source_id, record.new_slug]);
      if (!open || !fresh || open.old_slug !== record.old_slug) return { applied: false, outcome: 'kept', reason: 'no_longer_open' };
      await carryRenameIdentity(ctx.engine, record.source_id, record.old_slug, record.new_slug!);
      await clearIdentityDowngrade(ctx.engine, record.old_page_id);
      return { applied: true, outcome: 'carried', detail: { from: record.old_slug, to: record.new_slug, facts: record.facts, links: record.links, aliases: record.aliases } };
    } finally {
      if (last) await clearApprovedSet(ctx.engine, { command: 'rename-identity', hash });
    }
  },
} satisfies Omit<RepairHandler, 'kind'> & { kind: 'rename-identity' };
