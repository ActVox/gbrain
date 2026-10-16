import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import { requireConsent, type ConsentRequest } from '../consent.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { submitPageMutation } from './page-mutations.ts';
import { withBeliefBatch } from '../belief/ledger.ts';
import { markBeliefCommits } from '../belief/append.ts';
import { linkStreamSlugs } from './page-purge.ts';
import { identityDowngradePurgeHold } from '../sync-identity-downgrades.ts';
import { writerOnboardingPreflight } from './onboarding.ts';
import { clearPurgePark, notePurgeSourceWriter, PURGE_PARK_LIMIT, purgeParkKey, prunePurgeParks, readPurgeParks, recordPurgeFailure } from './purge-parks.ts';

/** A tombstone that moved under a concurrent writer; the next run retries it. */
const DEFERRAL_CODES = new Set(['revision_conflict', 'page_not_found', 'page_identity_changed']);

export interface DeletedPagePurge {
  slugs: string[];
  count: number;
  /** Every expired tombstone not purged this run, with its reason. Empty on an unmanaged brain. */
  blocked: Array<{ source_id: string; slug: string; reason: string; code: string | null; binding_state?: string }>;
  /** Tombstones restored, changed or removed by a concurrent writer; retried next run. */
  deferred: number;
  /** Operational failures (owner, binding, storage, protocol). */
  failed: number;
  /** #6741 C: tombstones not submitted because their source's writer is not active (in `blocked`, code `writer_not_active`). */
  inactive: number;
  /** #6741 C: tombstones not submitted after PURGE_PARK_LIMIT failures (in `blocked`, code `purge_parked`); doctor purge_parked_pages names them. */
  parked: number;
  /** Present when `failed > 0`, so the caller cannot report success. */
  error?: { class: string; code: string; message: string };
}

/**
 * D6 (#6114): the one consent request for a manual hard purge, used by
 * `gbrain pages purge-deleted` and by the `purge_deleted_pages` op (reached
 * through `gbrain call`), so no manual entry point purges without it. The
 * approved command is always the gated `pages purge-deleted --yes`. The
 * autopilot purge phase calls `purgeDeletedPagesCoordinated` directly.
 */
export function purgeConsentRequest(count: number, olderThanHours: number, json: boolean, args: readonly string[], retryParked = false): ConsentRequest {
  const retry = retryParked ? ['--retry-parked'] : [];
  return {
    command: 'pages purge-deleted', effects: ['destructive'], actor: 'agent',
    what: `Permanently purge ${count} soft-deleted page(s)`,
    why: 'A hard purge removes soft-deleted pages, their chunks and links, from every source of this brain.',
    risk: 'Purged pages cannot be restored with `gbrain restore`.',
    user_message: `Permanently delete ${count} page(s) soft-deleted more than ${olderThanHours}h ago, across every source in this brain? They cannot be restored afterwards.`,
    argv: ['gbrain', 'pages', 'purge-deleted', '--older-than', `${olderThanHours}h`, ...retry, ...(json ? ['--json'] : []), '--yes'],
    preview_argv: ['gbrain', 'pages', 'purge-deleted', '--older-than', `${olderThanHours}h`, ...retry, '--dry-run', '--json'],
    args,
  };
}

/** The `purge_deleted_pages` op (`gbrain call`): the D6 consent first (`yes` is `--yes`); an empty purge set needs none. */
export async function consentedPurgeDeletedPages(engine: BrainEngine, olderThanHours: number, yes: boolean) {
  const preview = await engine.purgeDeletedPages(olderThanHours, { dryRun: true });
  if (preview.count === 0) return { status: 'purged', count: 0, slugs: [] };
  await requireConsent(purgeConsentRequest(preview.count, olderThanHours, false, yes ? ['--yes'] : []));
  const result = await purgeDeletedPagesCoordinated(engine, olderThanHours);
  return { status: result.failed ? 'partial' : 'purged', count: result.count, slugs: result.slugs, ...(result.blocked.length ? { blocked: result.blocked } : {}) };
}

/**
 * W1 (BELIEF_LEDGER.md 6.5): on an unmanaged brain, each expired tombstone of a source the belief ledger records is
 * removed under its page key inside a belief batch, which appends `page.expired` (retention, never a purge: no
 * tombstone, nothing redacted) and a `link.retracted` for each link the delete cascades away, in its own stream. The bulk delete then takes the rest.
 */
async function expireRecordedTombstones(engine: BrainEngine, olderThanHours: number): Promise<string[]> {
  const hours = String(Math.max(0, Math.floor(olderThanHours)));
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string }>(`SELECT p.id, p.source_id, p.slug FROM pages p
    WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - ($1 || ' hours')::interval AND ${identityDowngradePurgeHold('p')}
      AND EXISTS (SELECT 1 FROM belief_events e WHERE e.source_id = p.source_id AND e.subject_kind = 'coverage')
    ORDER BY p.deleted_at ASC, p.source_id ASC, p.slug ASC`, [hours]);
  const slugs: string[] = [];
  for (const row of rows) {
    const publicationId = randomUUID(), report = { appended: 0 };
    const deleted = await engine.transaction(async tx => {
      const slugs = [...new Set([row.slug, ...await linkStreamSlugs(tx, row.source_id, row.id)])].sort();
      await tx.lockPageKeys(slugs.map(slug => ({ sourceId: row.source_id, slug })));
      return withBeliefBatch(tx, { sourceId: row.source_id, slugs, publicationId, op: 'purge_deleted_pages', hardDeleteEvent: 'page.expired', report },
        async () => (await tx.executeRaw(`DELETE FROM pages WHERE id = $1 AND deleted_at IS NOT NULL AND deleted_at < now() - ($2 || ' hours')::interval AND ${identityDowngradePurgeHold('pages')} RETURNING id`,
          [row.id, hours])).length > 0);
    });
    if (report.appended) await markBeliefCommits(engine, [publicationId]).catch(() => undefined);
    if (deleted) slugs.push(row.slug);
  }
  return slugs;
}

/**
 * #5405: hard-delete tombstones older than the recovery window. An unmanaged
 * brain keeps the engine's bulk delete. A managed brain refuses that bulk
 * delete, so each expired tombstone is purged through the coordinator with the
 * trusted-local `delete_page --purge` protocol, bound to the tombstone's
 * revision. Pages in archived sources are left to the source-lifecycle purge.
 * A tombstone that cannot be purged is reported, never forced.
 *
 * #6741 C: each attempt is a new permanent request id, so a source whose
 * writer is not active (writer status `recovery_required`: worktree not
 * active, physical root unverified) is not submitted at all and its
 * tombstones are reported in `blocked` with that state; a tombstone that
 * failed PURGE_PARK_LIMIT times is parked (purge-parks.ts). `retryParked`
 * (`gbrain pages purge-deleted --retry-parked`) gives each parked tombstone
 * one more attempt.
 */
export async function purgeDeletedPagesCoordinated(engine: BrainEngine, olderThanHours: number, opts: { retryParked?: boolean } = {}): Promise<DeletedPagePurge> {
  if (!await managedPersistenceEnabled(engine)) {
    const recorded = await expireRecordedTombstones(engine, olderThanHours);
    const result = await engine.purgeDeletedPages(olderThanHours);
    return { slugs: [...recorded, ...result.slugs], count: recorded.length + result.count, blocked: [], deferred: 0, failed: 0, inactive: 0, parked: 0 };
  }
  const hours = Math.max(0, Math.floor(olderThanHours));
  const rows = await engine.executeRaw<{ source_id: string; slug: string; cutoff: string; deleted_us: string }>(
    `SELECT p.source_id, p.slug, (now() - ($1 || ' hours')::interval)::text AS cutoff,
      floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text AS deleted_us FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - ($1 || ' hours')::interval AND NOT s.archived AND ${identityDowngradePurgeHold('p')}
      ORDER BY p.deleted_at ASC, p.source_id ASC, p.slug ASC`, [String(hours)]);
  const config = loadConfig() ?? { engine: engine.kind };
  const slugs: string[] = [];
  const blocked: DeletedPagePurge['blocked'] = [];
  let deferred = 0, failed = 0, inactive = 0, parked = 0;
  const writers = new Map<string, { state: string; physical_error?: string }>();
  if (rows.length) for (const source of (await writerOnboardingPreflight(engine)).sources) writers.set(source.source_id, source);
  for (const sourceId of new Set(rows.map(row => row.source_id))) await notePurgeSourceWriter(engine, sourceId, writers.get(sourceId)?.state !== 'recovery_required');
  await prunePurgeParks(engine);
  const parks = rows.length ? await readPurgeParks(engine) : new Map();
  for (const row of rows) {
    const writer = writers.get(row.source_id);
    if (writer?.state === 'recovery_required') {
      inactive++;
      blocked.push({ source_id: row.source_id, slug: row.slug, code: 'writer_not_active', binding_state: writer.state,
        reason: `Source ${row.source_id}'s writer is ${writer.state}${writer.physical_error ? ` (${writer.physical_error})` : ''}, so the purge submitted nothing; it resumes once gbrain sources writer status --source ${row.source_id} shows the writer ready.` });
      continue;
    }
    const key = purgeParkKey(row.source_id, row.slug, row.deleted_us);
    const park = parks.get(key);
    if (park && park.failures >= PURGE_PARK_LIMIT && !opts.retryParked) {
      parked++;
      blocked.push({ source_id: row.source_id, slug: row.slug, code: 'purge_parked',
        reason: `Parked after ${park.failures} failed purges (last: ${park.code ?? 'error'}: ${park.reason}); retry once with gbrain pages purge-deleted --retry-parked.` });
      continue;
    }
    try {
      const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
      if (!snapshot?.page.deleted_at) continue;
      // Restored and deleted again since the scan: its recovery window restarted.
      if (new Date(snapshot.page.deleted_at).getTime() >= new Date(row.cutoff).getTime()) { deferred++; continue; }
      const ctx: OperationContext = { engine, config, remote: false, sourceId: row.source_id, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } };
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: row.slug, source_id: row.source_id,
        purge: true, retention: true, expected_revision: snapshot.revision, request_id: randomUUID() } });
      slugs.push(row.slug);
      if (park) await clearPurgePark(engine, key);
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null;
      const reason = error instanceof Error ? error.message : String(error);
      if (code && DEFERRAL_CODES.has(code)) deferred++;
      else { failed++; await recordPurgeFailure(engine, { source_id: row.source_id, slug: row.slug, deleted_us: row.deleted_us, code, reason }); }
      blocked.push({ source_id: row.source_id, slug: row.slug, code, reason });
    }
  }
  const failures = blocked.filter(b => !b.code || !DEFERRAL_CODES.has(b.code) && b.code !== 'writer_not_active' && b.code !== 'purge_parked');
  const error = failed > 0 ? { class: 'ManagedPurgeFailed', code: 'managed_purge_failed',
    message: `${failed} expired page(s) could not be purged through the coordinator: ${failures.slice(0, 3)
      .map(b => `${b.source_id}/${b.slug}: ${b.reason}`).join('; ')}` } : undefined;
  return { slugs, count: slugs.length, blocked, deferred, failed, inactive, parked, ...(error ? { error } : {}) };
}
