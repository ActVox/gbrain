/**
 * #6729 `rename_identity_downgrades`: inexact Git renames a sync split into a delete plus an add because their identity
 * could not be confirmed (sync-rename-identity.ts). Each old page keeps its facts, links and aliases on its soft-deleted
 * slug, and the purge leaves it alone until the pair gets a disposition (restored, remedied or closed without merging);
 * there is no time window. The finding names every open pair until then; its fix restores the first old page (with its
 * facts, links and aliases, beside the new page) once the user asks to keep it.
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
      reason: record.reason, facts: record.facts, links: record.links, aliases: record.aliases, recorded_at: record.recorded_at }));
    const details = { count: open.length, by_source: bySource, samples, docs: DOCS };
    if (!open.length) {
      checks.push({ name: 'rename_identity_downgrades', status: 'ok', details, message: 'No rename that lost its page identity is waiting for a disposition.' });
      return checks;
    }
    const first = open[0]!, restorable = open.find(record => record.restore_available !== false);
    const unrestorable = [...new Set(open.filter(record => record.restore_available === false).map(record => record.source_id))];
    checks.push({ name: 'rename_identity_downgrades', status: 'warn', details: { ...details, restore_unavailable_sources: unrestorable },
      message: `${open.length} rename(s) did not keep their page identity, so each old page's facts, links and aliases stay on its soft-deleted slug, held from the purge until the pair is settled `
        + `(e.g. ${samples.map(record => `${record.source_id}:${record.from} -> ${record.to}, ${record.facts} fact(s) and ${record.links} link(s) on ${record.old_slug}`).join('; ')}; `
        + `first: ${identityDowngradeReasonText(first.reason)}). ${identityStatusArgv(first.source_id).join(' ')} lists every pair. `
        + (restorable ? 'To keep an old page, restore it; ' : '')
        + (unrestorable.length ? `A restore is not offered on ${unrestorable.join(', ')} (an unbound Postgres source refuses page writes outside its checkout); those pairs wait for a disposition. ` : '')
        + 'until a pair is restored or settled, its old page stays and this check names it.',
      ...(restorable ? { fix: agentFix(identityRestoreArgv(restorable),
        `Restores ${restorable.old_slug} with its facts, links and aliases, beside ${restorable.new_slug ?? 'the new file'}; the record closes and the purge no longer waits for it.`,
        'rename_identity_downgrades', { docs: DOCS, ask_user: true,
          user_message: `Sync did not keep the identity of ${restorable.old_slug} when ${restorable.from} became ${restorable.to}. Restore ${restorable.old_slug} as its own page so its ${restorable.facts} fact(s) and ${restorable.links} link(s) stay live?` }) } : {}) });
  } catch (error) {
    checks.push(checkError('rename_identity_downgrades', 'read the renames whose identity was not kept', error, { details: { count: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const renameIdentityDowngradesEntry: DoctorEntry = { name: 'rename_identity_downgrades', emits: ['rename_identity_downgrades'], run: runRenameIdentityDowngrades };
