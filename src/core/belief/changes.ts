/**
 * W4: what changed in a recorded-time window, as a cited belief diff
 * (docs/designs/BELIEF_LEDGER.md section 15). One entry per belief that ended
 * the window different from how it started: its value before and after, the
 * event that caused the last change and a pointer to the evidence.
 *
 * - Events come from `readBeliefHistory` (the one history reader), so a
 *   remote caller sees only what its privacy rule passes. Backfill and baseline
 *   rows are never changes: they carry source times, or the state a coverage
 *   run found.
 * - Per subject, the window nets out: an edit and its revert, or an assert and
 *   its retraction, report nothing.
 * - `before` is the subject's latest event at or before `since`. A subject with
 *   none was created with its page (one snapshot event, design section 4): it
 *   was absent when the page itself was created inside the window, and
 *   otherwise its value is read from the page body as recorded at `since`
 *   (page-at-time). When no body answers, `before_known` is false.
 * - A page created inside the window is one `added` page change plus one
 *   `added` change per fence fact and take of its creation body; links that
 *   came with it are counted on the page change, not listed.
 * - A link end the nightly relationship check inferred (producer `dream`) is an
 *   upper bound: the relationship ended on or before that date (`upper_bound`).
 */
import type { BrainEngine } from '../engine.ts';
import { readBeliefHistory, type BeliefHistoryRow, type BeliefHistoryQuery } from './history.ts';
import { coverageAt } from './coverage-report.ts';
import { readPageAtTime, remoteMayRead } from './page-at-time.ts';
import { bodySubjects } from './backfill.ts';
import { canonicalJson } from './keys.ts';
import { estimateTokens, packToBudget } from '../search/token-budget.ts';

export type BeliefChangeKind = 'page' | 'fact' | 'take' | 'link' | 'link_transition';
export interface BeliefChange {
  kind: BeliefChangeKind;
  /** The stream page the change was recorded on. */
  slug: string;
  change: 'added' | 'removed' | 'changed' | 'deleted' | 'restored' | 'renamed';
  /** What the belief is about, readable: a claim, a take, a link's type and ends, a transition's kind and date. */
  subject: Record<string, unknown>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  before_known: boolean;
  /** A link end only the nightly check dated: the relationship ended on or before this date. */
  upper_bound?: true;
  cause: { event: string; op: string | null } & Record<string, unknown>;
  evidence: { event_id: number; recorded_at: string; slug: string; row?: number };
  trust_tier: string;
}
export interface BeliefChanges {
  source_id: string; since: string; until: string;
  /** Set when the ledger starts after `since`: earlier changes are unknown, not absent. */
  coverage_from: string | null;
  changes: BeliefChange[];
  truncated: boolean;
  /** The source has no ledger coverage at all. */
  not_recorded?: true;
}
export interface BeliefChangesQuery {
  sourceId: string; since: string; until: string; remote: boolean; entities?: readonly string[]; limit?: number;
  /** Remote callers: the take holders they may read (`readHolders`); `['world']` when absent. */
  takesHolders?: readonly string[];
}

const SUBJECT_EVENTS = new Set(['fact.asserted', 'fact.revised', 'fact.retracted', 'fact.withdrawn', 'fact.superseded', 'fact.transferred', 'fact.purged',
  'take.asserted', 'take.revised', 'take.resolved', 'take.unresolved', 'take.retracted', 'take.transferred', 'take.purged',
  'link.asserted', 'link.revised', 'link.retracted', 'link.transferred', 'link.transition_added', 'link.transition_revised', 'link.transition_removed']);
const REMOVALS = new Set(['fact.retracted', 'fact.withdrawn', 'fact.superseded', 'fact.purged', 'take.retracted', 'take.purged', 'link.retracted', 'link.transition_removed']);
const ADDITIONS = new Set(['fact.asserted', 'fact.transferred', 'take.asserted', 'take.transferred', 'link.asserted', 'link.transferred', 'link.transition_added']);
const PAGE_EVENTS: Record<string, BeliefChange['change']> = { 'page.deleted': 'deleted', 'page.restored': 'restored', 'page.renamed': 'renamed',
  'page.purged': 'removed', 'page.expired': 'removed', 'page.merged': 'removed' };
const CAUSE_FIELDS = ['request', 'replaces', 'replaced_by', 'proposal', 'guard', 'purge_request', 'from_key', 'hold'] as const;
const PAGE_SIZE = 10_000;
const MAX_EVENTS = 50_000;
const DEFAULT_LIMIT = 200;

const iso = (v: unknown) => new Date(v as string).toISOString();
const isCreation = (e: BeliefHistoryRow) => e.event_type === 'page.published' && e.value != null && e.value.revision_before == null;

/** Every event matching `q`, paged by id; `truncated` when the cap stopped it. */
async function readAll(engine: BrainEngine, q: BeliefHistoryQuery): Promise<{ rows: BeliefHistoryRow[]; truncated: boolean }> {
  const rows: BeliefHistoryRow[] = [];
  let afterId = 0;
  for (;;) {
    const page = await readBeliefHistory(engine, { ...q, afterId, limit: PAGE_SIZE });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, truncated: false };
    if (rows.length >= MAX_EVENTS) return { rows, truncated: true };
    afterId = page.at(-1)!.id;
  }
}

/** The readable identity of a subject from its key, labels and values. */
function subjectOf(kind: BeliefChangeKind, key: string, label: Record<string, unknown>, values: Array<Record<string, unknown> | null>): Record<string, unknown> {
  const v = values.find(x => x != null) ?? {};
  const slugOf = (end: unknown) => Array.isArray(end) ? String(end[1]) : null;
  if (kind === 'fact') return { claim: v.fact ?? null, subject_slug: label.subject_slug ?? null, ...(label.entity_slug ? { entity_slug: label.entity_slug } : {}) };
  if (kind === 'take') return { claim: v.claim ?? null, holder: v.holder ?? null, kind: v.kind ?? null };
  const parsed = JSON.parse(key) as unknown[];
  const link = (kind === 'link_transition' ? parsed[1] : parsed) as unknown[];
  const out: Record<string, unknown> = { link_type: link[3], from: slugOf(label.from), to: slugOf(label.to) };
  if (kind === 'link_transition') Object.assign(out, { transition: parsed[2], date: parsed[3], producer: parsed[4] });
  return out;
}

function causeOf(e: BeliefHistoryRow): BeliefChange['cause'] {
  const out: BeliefChange['cause'] = { event: e.event_type, op: typeof e.cause.op === 'string' ? e.cause.op : null };
  for (const f of CAUSE_FIELDS) if (e.cause[f] != null) out[f] = e.cause[f];
  return out;
}

const evidenceOf = (e: BeliefHistoryRow): BeliefChange['evidence'] =>
  ({ event_id: e.id, recorded_at: iso(e.recorded_at), slug: e.slug, ...(typeof e.cause.row === 'number' ? { row: e.cause.row } : {}) });

export async function beliefChanges(engine: BrainEngine, q: BeliefChangesQuery): Promise<BeliefChanges> {
  const out: BeliefChanges = { source_id: q.sourceId, since: iso(q.since), until: iso(q.until), coverage_from: null, changes: [], truncated: false };
  const coverage = await coverageAt(engine, q.sourceId, q.until);
  if (!coverage.ok && coverage.code === 'coverage_from' && coverage.from == null) return { ...out, not_recorded: true };
  const startCov = await coverageAt(engine, q.sourceId, q.since);
  if (!startCov.ok && startCov.code === 'coverage_from') out.coverage_from = startCov.from;
  const read = await readAll(engine, { sourceId: q.sourceId, remote: q.remote, takesHolders: q.takesHolders, recordedAfter: out.since, recordedUntil: out.until });
  out.truncated = read.truncated;
  const events = read.rows.filter(e => e.origin !== 'backfill' && e.origin !== 'baseline');

  const created = new Map<string, BeliefHistoryRow>();
  for (const e of events) if (e.subject_kind === 'page' && e.page_lifetime && isCreation(e)) created.set(e.page_lifetime, e);
  const changes: BeliefChange[] = [];
  for (const e of events) {
    if (e.subject_kind !== 'page') continue;
    if (isCreation(e)) {
      changes.push({ kind: 'page', slug: e.slug, change: 'added', subject: { slug: e.slug }, before: null, after: { counts: e.value?.counts ?? null },
        before_known: true, cause: causeOf(e), evidence: evidenceOf(e), trust_tier: e.trust_tier });
      continue;
    }
    const change = PAGE_EVENTS[e.event_type];
    if (!change) continue;
    const renamed = change === 'renamed' && e.value ? e.value : null;
    changes.push({ kind: 'page', slug: e.slug, change, subject: { slug: e.slug },
      before: renamed ? { slug: renamed.old_slug } : null, after: renamed ? { slug: renamed.new_slug } : null,
      before_known: true, cause: causeOf(e), evidence: evidenceOf(e), trust_tier: e.trust_tier });
  }

  const byKey = new Map<string, BeliefHistoryRow[]>();
  for (const e of events) {
    if (!SUBJECT_EVENTS.has(e.event_type)) continue;
    const id = `${e.subject_kind}\u0000${e.subject_key}`;
    byKey.set(id, [...byKey.get(id) ?? [], e]);
  }
  const keys = [...new Set([...byKey.values()].map(rows => rows[0]!.subject_key))];
  const prior = new Map<string, BeliefHistoryRow>();
  if (keys.length) {
    for (const e of (await readAll(engine, { sourceId: q.sourceId, remote: q.remote, takesHolders: q.takesHolders, subjectKeys: keys, recordedUntil: out.since })).rows) {
      if (e.origin === 'backfill' || !SUBJECT_EVENTS.has(e.event_type) && e.event_type !== 'fact.adopted' && e.event_type !== 'link.adopted') continue;
      prior.set(`${e.subject_kind}\u0000${e.subject_key}`, e);
    }
  }

  const bodies = new Map<string, Promise<Map<string, Record<string, unknown>> | null>>();
  const bodyAt = (slug: string, at: string) => {
    const id = `${slug}\u0000${at}`;
    if (!bodies.has(id)) bodies.set(id, readBodySubjects(engine, q, slug, at));
    return bodies.get(id)!;
  };

  for (const [id, rows] of byKey) {
    const first = rows[0]!;
    const last = rows.at(-1)!;
    const kind = first.subject_kind as BeliefChangeKind;
    const after = REMOVALS.has(last.event_type) ? null : last.value;
    let before: Record<string, unknown> | null = null;
    let beforeKnown = true;
    const p = prior.get(id);
    if (p) before = REMOVALS.has(p.event_type) ? null : p.value;
    else if (ADDITIONS.has(first.event_type) || (first.page_lifetime && created.has(first.page_lifetime))) before = null;
    else if (kind === 'fact' || kind === 'take') {
      const subjects = await bodyAt(first.slug, out.since);
      before = subjects?.get(`${kind}\u0000${first.subject_key}`) ?? null;
      beforeKnown = before != null;
    } else before = { present: true };
    if (canonicalJson(before) === canonicalJson(after) && beforeKnown) continue;
    const label = (last.cause.label ?? first.cause.label ?? {}) as Record<string, unknown>;
    const subject = subjectOf(kind, last.subject_key, label, [after, before, ...rows.map(r => r.value)]);
    changes.push({ kind, slug: last.slug, change: before == null && beforeKnown ? 'added' : after == null ? 'removed' : 'changed', subject, before, after,
      before_known: beforeKnown, ...(kind === 'link_transition' && subject.transition === 'end' && subject.producer === 'dream' ? { upper_bound: true as const } : {}),
      cause: causeOf(last), evidence: evidenceOf(last), trust_tier: last.trust_tier });
  }

  for (const creation of created.values()) {
    const subjects = await readCreationSubjects(engine, q, creation, out.until);
    for (const [id, value] of subjects ?? []) {
      if (byKey.has(id)) continue;
      const kind = id.split('\u0000')[0] as 'fact' | 'take';
      changes.push({ kind, slug: creation.slug, change: 'added', subject: subjectOf(kind, id.split('\u0000')[1]!, { subject_slug: creation.slug }, [value]),
        before: null, after: value, before_known: true, cause: causeOf(creation), evidence: evidenceOf(creation), trust_tier: creation.trust_tier });
    }
  }

  const wanted = q.entities?.length ? new Set(q.entities) : null;
  const touches = (c: BeliefChange) => !wanted || wanted.has(c.slug) || [c.subject.subject_slug, c.subject.entity_slug, c.subject.from, c.subject.to].some(s => typeof s === 'string' && wanted.has(s));
  const sorted = changes.filter(touches).sort((a, b) => a.evidence.event_id - b.evidence.event_id || a.kind.localeCompare(b.kind));
  const limit = Math.max(1, q.limit ?? DEFAULT_LIMIT);
  out.changes = sorted.slice(0, limit);
  out.truncated ||= sorted.length > limit;
  return out;
}

/** Fence subjects of a page body, keyed `kind\u0000subject_key`; a remote caller gets them only where it may read the interval, and only world facts and takes of holders it may read. */
async function subjectsOf(engine: BrainEngine, q: BeliefChangesQuery, at: Awaited<ReturnType<typeof readPageAtTime>>, interval: NonNullable<Awaited<ReturnType<typeof readPageAtTime>>['current']>) {
  if (!interval.page || interval.body === 'unavailable' || interval.body === 'segmented' || interval.page.compiled_truth == null) return null;
  if (q.remote && !await remoteMayRead(engine, at.page_id, interval)) return null;
  const { subjects } = await bodySubjects(engine, interval.lifetime, `${interval.page.compiled_truth}\n${interval.page.timeline ?? ''}`, interval.event.visibility);
  const holders = new Set(q.takesHolders ?? ['world']);
  return new Map(subjects.filter(s => !q.remote || s.visibility === 'world' && (s.kind !== 'take' || holders.has(String(s.value.holder))))
    .map(s => [`${s.kind}\u0000${s.key}`, s.value]));
}

/** The page's fence subjects as recorded at `at`, or null when no body answers (coverage, proof, pruned or purged bodies). */
async function readBodySubjects(engine: BrainEngine, q: BeliefChangesQuery, slug: string, at: string) {
  const read = await readPageAtTime(engine, { sourceId: q.sourceId, slug, at: new Date(at), withBodies: true }).catch(() => null);
  return read?.current ? subjectsOf(engine, q, read, read.current) : null;
}

/** The fence subjects of the body a creation event published. */
async function readCreationSubjects(engine: BrainEngine, q: BeliefChangesQuery, creation: BeliefHistoryRow, until: string) {
  const read = await readPageAtTime(engine, { sourceId: q.sourceId, slug: creation.slug, at: new Date(until), history: true, withBodies: true }).catch(() => null);
  const interval = read?.intervals.find(i => i.event.id === creation.id);
  return read && interval ? subjectsOf(engine, q, read, interval) : null;
}

const lineCost = (line: string) => estimateTokens(line + '\n');

/**
 * `delta {beliefs: true}`: the window's changes and the wake's `text` with their section appended (under `envelope`
 * when the wake has no text of its own); `text` comes back unchanged when nothing changed. Under a budget the header and each line pack into what pages, facts
 * and threads left (`budget`); a cut sets `truncated`.
 */
export async function deltaBeliefs(engine: BrainEngine, q: BeliefChangesQuery, budget: number | null, text: string, envelope: string): Promise<{ beliefs: BeliefChanges; text: string }> {
  let beliefs = await beliefChanges(engine, q);
  const header = `## Belief changes since ${q.since}`;
  if (budget !== null) {
    const room = budget - lineCost('') - lineCost(header);
    const kept = room > 0 ? packToBudget(beliefs.changes, c => lineCost(renderBeliefChange(c)), room).items : [];
    if (kept.length < beliefs.changes.length) beliefs = { ...beliefs, changes: kept, truncated: true };
  }
  return { beliefs, text: beliefs.changes.length ? [text || envelope, '', header, ...beliefs.changes.map(renderBeliefChange)].join('\n') : text };
}

/** The CLI's text for a whole window: a header, the coverage note, one line per change. */
export function renderBeliefChanges(b: BeliefChanges): string {
  if (b.not_recorded) return `The belief ledger is not recording ${b.source_id}; enable it with gbrain beliefs enable --source ${b.source_id}.`;
  return [`Belief changes on ${b.source_id} from ${b.since} to ${b.until}: ${b.changes.length}${b.truncated ? ' (truncated: more changed than this lists)' : ''}`,
    ...(b.coverage_from ? [`  The ledger starts at ${b.coverage_from}; changes before it are unknown, not absent.`] : []),
    ...b.changes.map(renderBeliefChange)].join('\n');
}

/** One line per change, for `delta`'s text block and the CLI. */
export function renderBeliefChange(c: BeliefChange): string {
  const day = c.evidence.recorded_at.slice(0, 10);
  const show = (v: Record<string, unknown> | null) => v == null ? '(none)' : JSON.stringify(c.kind === 'fact' ? v.fact : c.kind === 'take' ? { claim: v.claim, weight: v.weight, resolved: v.resolved_outcome ?? undefined } : v);
  const what = c.kind === 'page' ? `page ${c.slug}`
    : c.kind === 'link' || c.kind === 'link_transition' ? `${c.subject.link_type} ${c.subject.from} -> ${c.subject.to}${c.kind === 'link_transition' ? ` ${c.subject.transition} ${c.upper_bound ? 'by ' : ''}${c.subject.date}` : ''}`
    : `${c.kind} on ${c.slug}`;
  const delta = c.kind === 'page' && c.change === 'renamed' ? `${c.before?.slug} -> ${c.after?.slug}`
    : c.kind === 'page' || c.kind === 'link' || c.kind === 'link_transition' ? c.change
    : c.change === 'changed' ? `${show(c.before)} -> ${show(c.after)}` : `${c.change} ${show(c.after ?? c.before)}`;
  const why = [c.cause.op ?? c.cause.event, `event ${c.evidence.event_id}`, ...(c.evidence.row != null ? [`row ${c.evidence.row}`] : []),
    ...(c.upper_bound ? ['inferred end, an upper bound'] : []), ...(c.before_known ? [] : ['earlier value unknown'])].join(', ');
  return `- [${day}] ${what}: ${delta} (${why})`;
}
