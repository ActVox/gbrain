/**
 * Coverage intervals and the activation baseline (docs/designs/BELIEF_LEDGER.md
 * section 7.1). `enableBeliefLedger` appends `coverage.started`, then baselines
 * each page under its own page key (one snapshot `baseline` event, or one per
 * subject for a page over 1 MiB) and each database-only subject under its slug
 * key, then appends `coverage.complete`, whose recorded_at is the source's
 * watermark. A run is resumable: a page whose baseline for the current run
 * exists is skipped. `disableBeliefLedger` appends `coverage.stopped`; the next
 * enable starts a new interval with a new baseline.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { COVERAGE_KEY, pageKey } from './keys.ts';
import { appendBeliefEvents, markBeliefCommits, type BeliefEventDraft } from './append.ts';
import { coverageActive, currentStateHash, readLedgerSource } from './ledger.ts';
import { keyedSubjects, type Subject } from './subjects.ts';

export interface CoverageRun { runId: string; resumed: boolean; pages: number; dbOnlySubjects: number; complete: boolean; certified: boolean }
const BASELINE_BATCH = 200;

/** The latest coverage event of the source's current incarnation. */
export async function latestCoverage(engine: BrainEngine, sourceId: string): Promise<{ type: string; run: string | null; recorded_at: string; id: number } | null> {
  const [row] = await engine.executeRaw<{ event_type: string; run: string | null; recorded_at: string; id: number }>(`SELECT e.event_type, e.cause->>'run' AS run, e.recorded_at, e.id
    FROM belief_events e JOIN sources s ON s.id = e.source_id AND s.incarnation = e.source_incarnation
    WHERE e.source_id = $1 AND e.subject_kind = 'coverage' AND e.subject_key = $2 ORDER BY e.id DESC LIMIT 1`, [sourceId, COVERAGE_KEY]);
  return row ? { type: row.event_type, run: row.run, recorded_at: new Date(row.recorded_at).toISOString(), id: Number(row.id) } : null;
}

async function appendCoverage(engine: BrainEngine, sourceId: string, eventType: string, cause: Record<string, unknown>): Promise<void> {
  const publicationId = randomUUID();
  await engine.transaction(async tx => {
    const source = await readLedgerSource(tx, sourceId);
    if (!source) throw new Error(`source not found: ${sourceId}`);
    await tx.executeRaw('SELECT id FROM sources WHERE id = $1 FOR UPDATE', [sourceId]);
    await appendBeliefEvents(tx, [{ sourceId, incarnation: source.incarnation, lifetime: null, slug: '', subjectKind: 'coverage', subjectKey: COVERAGE_KEY,
      eventType, trustTier: 'unknown', tierBasis: 'unknown', visibility: 'world', value: null, stateHash: '', cause: { op: eventType, ...cause } }],
    { publicationId, origin: 'live', purgesPossible: false });
  });
  await markBeliefCommits(engine, [publicationId]);
}

/** One page's baseline under its key, in the same form as a creation snapshot (or per subject when over 1 MiB). */
async function baselinePage(engine: BrainEngine, sourceId: string, slug: string, runId: string): Promise<boolean> {
  const publicationId = randomUUID();
  const appended = await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const source = await readLedgerSource(tx, sourceId);
    if (!source || !coverageActive(source.coverage)) return 0;
    const { hash, state, lifetimes } = await currentStateHash(tx, sourceId, source.incarnation, slug);
    const page = state.pages.find(p => p.slug === slug);
    const subjects = keyedSubjects({ incarnation: source.incarnation, lifetimes, pagesBySlug: new Map(page ? [[slug, page]] : []) }, state,
      id => state.pages.find(p => p.id === id)?.visible === false ? 'private' : 'world').filter(s => s.stream === slug);
    const lifetime = page ? lifetimes.get(page.id)! : null;
    const cause = { op: 'baseline', run: runId };
    const drafts: BeliefEventDraft[] = [];
    const perSubject = (list: Subject[]) => list.map((s): BeliefEventDraft => ({ sourceId, incarnation: source.incarnation, lifetime: s.dbOnly && !page ? null : lifetime,
      slug, stream: slug, subjectKind: s.kind, subjectKey: s.key, eventType: 'baseline', trustTier: s.kind === 'link' || s.kind === 'link_transition' ? 'unknown' : s.tier,
      tierBasis: s.kind === 'link' || s.kind === 'link_transition' ? 'unknown' : 'row', visibility: s.visibility, value: s.value, stateHash: hash,
      claimFp: s.claimFp, validFrom: s.validFrom, validUntil: s.validUntil, cause: { ...cause, ...(s.rowNum != null ? { row: s.rowNum } : {}), label: s.label } }));
    if (page) {
      const bound = subjects.filter(s => !s.dbOnly);
      const counts = { facts: bound.filter(s => s.kind === 'fact').length, takes: bound.filter(s => s.kind === 'take').length,
        links: bound.filter(s => s.kind === 'link').length, link_transitions: bound.filter(s => s.kind === 'link_transition').length };
      drafts.push({ sourceId, incarnation: source.incarnation, lifetime, slug, stream: slug, subjectKind: 'page', subjectKey: pageKey(lifetime!), eventType: 'baseline',
        trustTier: page.tier, visibility: page.visible ? 'world' : 'private', value: { revision_after: page.revision, snapshot: !page.large, counts, ...(page.deleted ? { deleted: true } : {}) },
        stateHash: hash, cause });
      if (page.large) drafts.push(...perSubject(bound));
    }
    drafts.push(...perSubject(subjects.filter(s => s.dbOnly)));
    return appendBeliefEvents(tx, drafts, { publicationId, origin: 'baseline', purgesPossible: source.purgesPossible });
  });
  if (appended) await markBeliefCommits(engine, [publicationId]);
  return appended > 0;
}

/** Slugs of the source still lacking a baseline in this run: live and soft-deleted pages, then page-less database-only fact subjects. */
async function pendingSlugs(engine: BrainEngine, sourceId: string, runId: string, after: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM (
      SELECT p.slug FROM pages p WHERE p.source_id = $1
      UNION SELECT f.entity_slug FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug IS NULL AND f.expired_at IS NULL AND f.entity_slug IS NOT NULL
      UNION SELECT f.source_markdown_slug FROM facts f WHERE f.source_id = $1 AND f.dimension IS NOT NULL AND f.row_num IS NULL AND f.expired_at IS NULL AND f.source_markdown_slug IS NOT NULL
    ) s WHERE s.slug > $3 AND NOT EXISTS (SELECT 1 FROM belief_events e WHERE e.source_id = $1 AND e.slug = s.slug AND e.event_type = 'baseline' AND e.cause->>'run' = $2)
    ORDER BY s.slug LIMIT ${BASELINE_BATCH}`, [sourceId, runId, after]);
  return rows.map(r => r.slug);
}

export async function enableBeliefLedger(engine: BrainEngine, sourceId: string): Promise<CoverageRun> {
  const latest = await latestCoverage(engine, sourceId);
  const resumed = latest?.type === 'coverage.started' && !!latest.run;
  const runId = resumed ? latest!.run! : randomUUID();
  if (latest?.type === 'coverage.complete' || latest?.type === 'coverage.restored') {
    const source = await readLedgerSource(engine, sourceId);
    return { runId: latest.run ?? '', resumed: true, pages: 0, dbOnlySubjects: 0, complete: true, certified: !!source?.managed };
  }
  if (!resumed) await appendCoverage(engine, sourceId, 'coverage.started', { run: runId });
  let pages = 0;
  let after = '';
  for (;;) {
    const slugs = await pendingSlugs(engine, sourceId, runId, after);
    if (!slugs.length) break;
    for (const slug of slugs) if (await baselinePage(engine, sourceId, slug, runId)) pages++;
    after = slugs[slugs.length - 1]!;
  }
  const source = await readLedgerSource(engine, sourceId);
  await appendCoverage(engine, sourceId, 'coverage.complete', { run: runId, certified: !!source?.managed });
  return { runId, resumed, pages, dbOnlySubjects: 0, complete: true, certified: !!source?.managed };
}

export async function disableBeliefLedger(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const latest = await latestCoverage(engine, sourceId);
  if (!latest || latest.type === 'coverage.stopped') return false;
  await appendCoverage(engine, sourceId, 'coverage.stopped', { run: latest.run });
  return true;
}
