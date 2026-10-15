/**
 * #6712 PR 1: admitted-member identity, kept apart from the resumer's authority. A managed cursor can be adopted by
 * another writer (sync-run.ts `adoptCursor`); every request already admitted keeps the principal frozen in its own
 * intent, so it is read and cancelled under that principal, never under the resumer's, and its payload is never
 * rewritten. Frozen entries no request was admitted for are dropped on a writer change and frozen again under the
 * resumer.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { principalKey, type Principal, type WriteRequest } from './model.ts';
import { cancelWindow, type CursorFence } from './sync-window.ts';

/** A frozen member: its request id and the authority frozen in its intent (absent on members frozen before #6712). */
export interface AdmittedMember { requestId: string; intent: { syncAuthority?: { writer: { principal: Principal } } } }
/** The cursor's own authority: the admitting principal of a member that froze none. */
export interface AdmittingCursor { authority: { writer: { principal: Principal } } }

/** A remote caller met a cursor another principal (or the local CLI) wrote: the host's CLI resumes it. */
export function localResumeRequired(sourceId: string): OperationError {
  return opError('sync_in_progress', `Source ${sourceId} has an unfinished sync run that another writer started.`,
    `A remote caller resumes only its own sync runs, so nothing was synced. The brain host's CLI finishes the run with the command in fix.`,
    { reason: 'local_resume_required', fix: { argv: ['gbrain', 'sync', '--no-pull', '--source', sourceId], consent: [], actor: 'user', requires_exclusive: false,
      why: `Finishes the unfinished sync run of source ${sourceId} under the brain host's CLI writer.`,
      user_message: `Source ${sourceId} has an unfinished sync that another writer started. Please run the command shown in a terminal on the brain host.`,
      verify: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] } } });
}
/** The principal that admitted (or will admit) a frozen member: the authority frozen in its own intent. */
export const admittedBy = (member: AdmittedMember, cursor: AdmittingCursor): Principal => member.intent.syncAuthority?.writer.principal ?? cursor.authority.writer.principal;
/** The rows of admitted members, each read under its own admitting principal (one read per principal, normally one). */
export async function readAdmitted(engine: Pick<BrainEngine, 'executeRaw'>, cursor: AdmittingCursor, members: AdmittedMember[], committedOnly = false): Promise<WriteRequest[]> {
  const byPrincipal = new Map<string, { principal: Principal; ids: string[] }>();
  for (const member of members) {
    const principal = admittedBy(member, cursor), slot = principalKey(principal);
    if (!byPrincipal.has(slot)) byPrincipal.set(slot, { principal, ids: [] });
    byPrincipal.get(slot)!.ids.push(member.requestId);
  }
  const rows: WriteRequest[] = [];
  for (const { principal, ids } of byPrincipal.values()) {
    rows.push(...await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[])${committedOnly ? " AND state='committed'" : ''}`,
      [principal.kind, principal.id, ids]));
  }
  return rows;
}
/** Cancels a window's queued members, each group of them under its own admitting principal. */
export async function cancelAdmittedWindow(engine: BrainEngine, cursor: AdmittingCursor, window: AdmittedMember[][], root: string | null,
  fence?: Omit<CursorFence, 'principal'>): Promise<boolean> {
  const byPrincipal = new Map<string, { principal: Principal; members: AdmittedMember[] }>();
  for (const member of window.flat()) {
    const principal = admittedBy(member, cursor), slot = principalKey(principal);
    if (!byPrincipal.has(slot)) byPrincipal.set(slot, { principal, members: [] });
    byPrincipal.get(slot)!.members.push(member);
  }
  for (const { principal, members } of byPrincipal.values()) {
    if (!await cancelWindow(engine, [members], principal, root, fence && { ...fence, principal })) return false;
  }
  return true;
}
/** Drops (in place) the frozen members of `next` no request was admitted for: the head and its group, or the window groups from the first unadmitted one on. */
export async function withoutUnadmitted(engine: BrainEngine, next: AdmittingCursor & { pending?: AdmittedMember; group?: unknown; window?: AdmittedMember[][] }): Promise<void> {
  const head = next.pending;
  if (!head) return;
  const window = next.window ?? [];
  const admitted = new Set((await readAdmitted(engine, next, [head, ...window.flat()])).map(row => row.request_id));
  if (!admitted.has(head.requestId)) { delete next.pending; delete next.group; delete next.window; return; }
  const kept = window.findIndex(group => !group.every(member => admitted.has(member.requestId)));
  if (kept === -1) return;
  if (kept === 0) delete next.window; else next.window = window.slice(0, kept);
}
