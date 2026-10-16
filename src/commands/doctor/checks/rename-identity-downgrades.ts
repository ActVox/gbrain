/**
 * #6729 `rename_identity_downgrades`: inexact Git renames a sync split into a delete plus an add because their identity
 * could not be confirmed (sync-rename-identity.ts). Each old page keeps its facts, links and aliases on its soft-deleted
 * slug for the 72-hour recovery window, and the purge leaves it alone while the record is open. The finding names every
 * open pair; its fix restores the first old page (with its facts, links and aliases, beside the new page)
 * once the user asks to keep it. Outside the window the check is ok: the pairs are history.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { identityDowngradeReasonText, identityRestoreArgv, identityStatusArgv, listIdentityDowngrades } from '../../../core/sync-identity-downgrades.ts';

const DOCS = 'docs/guides/live-sync.md#renaming-a-page';
const SAMPLE = 5;

async function runRenameIdentityDowngrades(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const open = await listIdentityDowngrades(connectedEngine(ctx));
    const bySource = [...new Set(open.map(record => record.source_id))].map(source_id => ({ source_id, count: open.filter(record => record.source_id === source_id).length }));
    const samples = open.slice(0, SAMPLE).map(record => ({ source_id: record.source_id, from: record.from, to: record.to, old_slug: record.old_slug, new_slug: record.new_slug,
      reason: record.reason, facts: record.facts, links: record.links, aliases: record.aliases, expires_at: record.expires_at }));
    const details = { count: open.length, by_source: bySource, samples, docs: DOCS };
    if (!open.length) {
      checks.push({ name: 'rename_identity_downgrades', status: 'ok', details, message: 'No rename in the last 72 h lost its page identity.' });
      return checks;
    }
    const first = open[0]!;
    checks.push({ name: 'rename_identity_downgrades', status: 'warn', details,
      message: `${open.length} rename(s) synced in the last 72 h did not keep their page identity, so each old page's facts, links and aliases stay on its soft-deleted slug until its window ends `
        + `(e.g. ${samples.map(record => `${record.source_id}:${record.from} -> ${record.to}, ${record.facts} fact(s) and ${record.links} link(s) on ${record.old_slug}`).join('; ')}; `
        + `first: ${identityDowngradeReasonText(first.reason)}). ${identityStatusArgv(first.source_id).join(' ')} lists every pair. To keep an old page, restore it before its window ends; `
        + 'otherwise nothing is needed and the old pages purge after their window.',
      fix: agentFix(identityRestoreArgv(first),
        `Restores ${first.old_slug} with its facts, links and aliases, beside ${first.new_slug ?? 'the new file'}; the record closes and the purge no longer waits for it.`,
        'rename_identity_downgrades', { docs: DOCS, ask_user: true,
          user_message: `Sync did not keep the identity of ${first.old_slug} when ${first.from} became ${first.to}. Restore ${first.old_slug} as its own page so its ${first.facts} fact(s) and ${first.links} link(s) stay live?` }) });
  } catch (error) {
    checks.push(checkError('rename_identity_downgrades', 'read the renames whose identity was not kept', error, { details: { count: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const renameIdentityDowngradesEntry: DoctorEntry = { name: 'rename_identity_downgrades', emits: ['rename_identity_downgrades'], run: runRenameIdentityDowngrades };
