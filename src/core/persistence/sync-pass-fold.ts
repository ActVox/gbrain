/**
 * #6712 PR 4b: the pass checkpoint folded into the publication of the round's last import (#6926, folded into 4b; GBRA-108
 * approved it under decision A's flip clause). The stamp rides that import's intent (sync-pass-run.ts `foldStamp`) and
 * commits in the import's own transaction, after its page and record, only when the database there proves what the next
 * round would have: every path at the target is settled. It is as conservative as the checkpoint request:
 * - the checkpoint's own checks: the drain lease (`FOR SHARE`, the pass's token), the pass row still naming this pass, no
 *   recovery row and no other open managed-sync request of the worktree (`findOpenPassWork`), and the commit checkpoint
 *   (`last_commit`, the slug-root pin) still where the pass found it; and no refused checkpoint of the source that no later
 *   checkpoint superseded (#6834): the stamp path's checkpoint request supersedes it, a folded stamp would leave it listed;
 * - `U_db` as the checkpoint records it: the converged watermark and `open_at_stamp` (`readConvergedWatermark`), read in
 *   the same transaction; this import publishes no file, so no Git effect of its own is left out of them;
 * - since the round's mark (S1), every change the level reads is this round's own write (sync-pass-confirm.ts
 *   `proveConfirm`, with this request's uncommitted page admitted): exactly one page per import of the round, the pages
 *   past S1's largest id the round's new ones, the counts S1's plus the round's new pages and records, and no hold at S1
 *   or now (a hold at the target keeps the stamp path);
 * - every page the round wrote classifies `matched` at the level its request froze (sync-pass.ts `passWritesMatched`);
 *   the rest of the level settled in the round's classification (the pass folds only a round whose only unsettled paths
 *   were its imports, sync-pass-run.ts).
 * Anything else publishes the import alone (`pass_stamp_skipped` names why) and the pass stamps by its checkpoint request
 * as before. The fold never fails the import on its own account: it runs under a savepoint, and a statement that fails
 * there (a validation timeout, a lost race) rolls back to it and skips the stamp, as one it cannot prove is skipped. A publication that rolls back takes the stamp with it; one that commits leaves the stamp and the pages
 * consistent for the next run.
 */
import type { BrainEngine } from '../engine.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { syncLockId } from '../db-lock.ts';
import { pipelined } from '../page-state/transactions.ts';
import { findOpenPassWork } from './checkpoint-validation.ts';
import { countsMatch, proveConfirm, type LevelMark } from './sync-pass-confirm.ts';
import { passWritesMatched } from './sync-pass.ts';
import { readConvergedWatermark } from './sync-pass-batch.ts';
import { OPEN_AT_STAMP_CAP, readPassRow, type ManagedSyncPassValue } from './sync-pass-row.ts';
import { emptySyncScope } from './sync-slug-mode.ts';
import { faultPoint } from './fault-points.ts';
import { supersessionSql } from './terminal-classify.ts';
import { publishPassStamp, syncGitTopLevel, type SyncIntent } from './sync-prepare.ts';

/** What a folded stamp's proof needs of its round: S1's mark, page count and largest page id, and the round's imports. */
export interface PassFold {
  base: LevelMark; pages: number; maxId: string;
  /** The round's imports, those that create a page, and those whose page had no import record at S1. */
  imports: number; newPages: number; newRecords: number;
  episodeFullId: string | null; scope: string;
  /** The pass row's obligations when the import was frozen: the stamp writes them, as the checkpoint request reads the row's. */
  obligations?: ManagedSyncPassValue['obligations'];
}

/** `prepared` (the round's last import) with the stamp folded into its apply; a file write keeps the stamp path. */
export function foldPassCheckpoint<T extends PreparedMutation>(prepared: T, input: { row: WriteRequest; p: SyncIntent; root: string }): T {
  if (prepared.file || prepared.noop) return prepared;
  const apply = prepared.apply.bind(prepared);
  prepared.sourceExclusive = true;
  prepared.apply = async (tx, preimage) => {
    const outcome = await apply(tx, preimage);
    const skipped = await foldedStamp(tx, input, outcome);
    return { ...outcome, ...(skipped ? { pass_stamp_skipped: skipped } : { pass_stamp: 'folded' }) };
  };
  return prepared;
}

/** Publishes the stamp in `tx` when its checks hold; else why not (`error`: a statement failed, rolled back to the savepoint). */
async function foldedStamp(tx: BrainEngine, input: { row: WriteRequest; p: SyncIntent; root: string }, outcome: Record<string, unknown>): Promise<string | null> {
  await tx.executeRaw('SAVEPOINT gbrain_pass_stamp_fold');
  try {
    const skipped = await provenStamp(tx, input, outcome);
    await tx.executeRaw(skipped ? 'ROLLBACK TO SAVEPOINT gbrain_pass_stamp_fold' : 'RELEASE SAVEPOINT gbrain_pass_stamp_fold');
    return skipped;
  } catch {
    await tx.executeRaw('ROLLBACK TO SAVEPOINT gbrain_pass_stamp_fold');
    return 'error';
  }
}

async function provenStamp(tx: BrainEngine, { row, p, root }: { row: WriteRequest; p: SyncIntent; root: string }, outcome: Record<string, unknown>): Promise<string | null> {
  const stamp = p.stamp!, fold = stamp.fold!, postgres = tx.kind === 'postgres';
  const scope = { worktreeId: row.worktree_id!, sourceId: row.source_id, incarnation: row.source_incarnation };
  await faultPoint('sync:pass_fold', { requestId: row.request_id, writeId: row.id, sourceId: row.source_id });
  const [lease, pass, blocker, watermark, sources, proof, refused] = await pipelined(tx, [
    () => tx.executeRaw('SELECT 1 FROM gbrain_cycle_locks WHERE id=$1 AND acquisition_token=$2::uuid AND ttl_expires_at > now() FOR SHARE', [syncLockId(row.source_id), stamp.leaseToken]),
    () => readPassRow(tx, row.source_id, stamp.incarnation),
    () => findOpenPassWork(tx, row.worktree_id!, row.request_id),
    () => readConvergedWatermark(tx, scope, row.request_id, OPEN_AT_STAMP_CAP),
    () => tx.executeRaw(`SELECT last_commit, config->>'slug_root_mode' AS mode FROM sources WHERE id=$1 AND incarnation=$2::uuid`, [row.source_id, row.source_incarnation]),
    () => proveConfirm(tx, { sourceId: row.source_id, incarnation: row.source_incarnation, passId: p.passId!, base: fold.base, postgres, self: row.id }),
    () => tx.executeRaw(`SELECT 1 FROM persistence_requests r WHERE r.source_id=$1 AND r.slug='__managed_sync_checkpoint__' AND r.intent IS NOT NULL AND NOT r.compacted
      AND r.operation='submit_job' AND r.intent->>'kind'='managed_sync_checkpoint' AND r.state IN ('failed','conflict','cancelled')
      AND NOT EXISTS (SELECT 1 FROM persistence_requests c WHERE ${supersessionSql('r', 'c')}) LIMIT 1`, [row.source_id]),
  ]) as [unknown[], Awaited<ReturnType<typeof readPassRow>>, string | null, Awaited<ReturnType<typeof readConvergedWatermark>>, Array<{ last_commit: string | null; mode: string | null }>,
    Awaited<ReturnType<typeof proveConfirm>>, unknown[]];
  if (!lease.length || !pass || pass.value.lease_token !== stamp.leaseToken || pass.value.telemetry.pass_id !== p.passId) return 'lease';
  if (blocker) return 'open_work';
  if (refused.length) return 'refused_checkpoint';
  const emptyScope = stamp.configured ? emptySyncScope(root, syncGitTopLevel(root, p.passId!)) : undefined;
  const source = sources[0];
  if (stamp.configured && (!source || (source.last_commit !== p.from && source.last_commit !== p.target) || (!emptyScope && source.mode !== null && source.mode !== p.slugMode))) return 'checkpoint_moved';
  if (!proof.ok) return proof.reason;
  if (fold.base.holds.length || proof.mark.holds.length || proof.summary) return 'holds';
  if (proof.pages.length !== fold.imports || proof.pages.filter(id => BigInt(id) > BigInt(fold.maxId)).length !== fold.newPages) return 'pages';
  if (!countsMatch(fold.base, proof, { pages: fold.pages + fold.newPages, newRecords: fold.newRecords })) return 'counts';
  if (!await passWritesMatched(tx, { kind: postgres ? 'postgres' : 'pglite', sourceId: row.source_id, incarnation: row.source_incarnation, pack: stamp.pack, scope: fold.scope,
    slugMode: p.slugMode, episodeFullId: fold.episodeFullId, ids: proof.pages })) return 'unsettled';
  await publishPassStamp(tx, row, p, root, async () => {}, fold.obligations ? { value: { ...pass.value, obligations: fold.obligations } } : pass, { changed: stamp.changed + (outcome.noop === true ? 0 : 1), watermark, ...(emptyScope === undefined ? {} : { emptyScope }) });
  return null;
}
