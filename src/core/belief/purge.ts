/**
 * Purge redaction of the belief ledger (docs/designs/BELIEF_LEDGER.md section
 * 6.5), run inside the purge transaction after its projections:
 *
 * 1. purged keys: every event of a purged claim fingerprint (fact and take
 *    events carry the claim-only fingerprint in `claim_fp`, so kind, holder,
 *    subject and the rename chain cannot evade it) and every event of the purged
 *    page's lifetimes loses its value and is marked `purged`;
 * 2. carrying fields: every event in the source whose value contains a purge
 *    needle has each carrying field that quotes a claim replaced by the
 *    redaction marker, its value_hash recomputed and the field listed in
 *    `redacted_fields`; each replacement is registered in `belief_redactions`
 *    so later appends keep the marker until an owner release (append.ts);
 * 3. derived keys: each row the derivation walk hides gets one `derived.hidden`
 *    event naming the purge request; `readBeliefHistory` hides the key's events
 *    up to it (and its backfill events at any id).
 *
 * The scans are keyset batches over the source's events; a statement timeout
 * propagates (57014) and the caller refuses the whole purge with the typed
 * `purge_lookup_timeout`, never a partial one. Nothing runs when the source has
 * no ledger events.
 */
import { readManagedMode } from '../persistence/managed-mode.ts';
import type { BrainEngine } from '../engine.ts';
import { escapeFenceCell } from '../fence-shared.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { parseTakesFence } from '../takes-fence.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import type { DerivedRow } from '../facts/derivation-inputs.ts';
import { CARRYING_FIELDS, REDACTION_MARKER, canonicalJson, fieldHash, pageKey, valueHash } from './keys.ts';
import { readBeliefState } from './state.ts';
import { keyedSubjects, pageNeeds } from './subjects.ts';
import { resolveLifetimes } from './lifetimes.ts';
import { appendBeliefEvents, type BeliefEventDraft } from './append.ts';
import { coverageActive, readLedgerSource } from './ledger.ts';

const SCAN_BATCH = 1000;

export type PurgeRedactionFault = 'skip_purged_keys' | 'skip_carrying_fields' | 'skip_live_carriers' | 'skip_derived_hidden' | 'bounded_inventory';
let redactionFault: PurgeRedactionFault | null = null;
/** Forced-probe seam (section 11): a deliberately broken redaction pass the probe that covers it must catch. Null restores it. */
export function __setPurgeRedactionFaultForTests(fault: PurgeRedactionFault | null): void { redactionFault = fault; }

/** The source's purge counter, incremented in the purge transaction; payloads prepared under an older epoch are refused. */
export async function bumpPurgeEpoch(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<number> {
  const [row] = await tx.executeRaw<{ purge_epoch: string | number }>('UPDATE sources SET purge_epoch = purge_epoch + 1 WHERE id = $1 RETURNING purge_epoch', [sourceId]);
  return Number(row?.purge_epoch ?? 0);
}

export async function sourceHasBeliefEvents(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<boolean> {
  const [row] = await tx.executeRaw<{ present: boolean }>('SELECT EXISTS (SELECT 1 FROM belief_events WHERE source_id = $1) AS present', [sourceId]);
  return row?.present === true;
}

/** A claim as it can appear in stored text: plain, fence-escaped, and each JSON-escaped (event values are matched as JSON text). */
export function purgeNeedles(claims: readonly string[]): string[] {
  const out = new Set<string>();
  for (const claim of claims) {
    const lower = claim.trim().toLowerCase();
    if (!lower) continue;
    for (const form of [lower, escapeFenceCell(lower)]) { out.add(form); out.add(JSON.stringify(form).slice(1, -1)); }
  }
  return [...out];
}

const quotes = (text: string, claims: readonly string[]) => {
  const lower = text.toLowerCase();
  return claims.some(c => { const l = c.trim().toLowerCase(); return !!l && (lower.includes(l) || lower.includes(escapeFenceCell(l))); });
};

/** Pass 1: purged keys lose their values. Returns the events marked. */
export async function redactPurgedKeys(tx: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; claimFps: readonly string[]; lifetimes: readonly string[] }): Promise<number> {
  if ((!input.claimFps.length && !input.lifetimes.length) || redactionFault === 'skip_purged_keys') return 0;
  const rows = await tx.executeRaw(`UPDATE belief_events SET value = NULL, value_hash = NULL, purged = true
    WHERE source_id = $1 AND ((subject_kind IN ('fact','take') AND claim_fp = ANY($2::text[])) OR page_lifetime = ANY($3::uuid[]))
      AND (purged = false OR value IS NOT NULL) RETURNING id`, [input.sourceId, [...input.claimFps], [...input.lifetimes]]);
  return rows.length;
}

export interface RedactedField { subject_key: string; field: string; event_id: number }

/** Pass 2: carrying fields that quote a purged claim become the redaction marker and enter the redaction register. */
export async function redactCarryingFields(tx: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; request: string; claims: readonly string[] }): Promise<RedactedField[]> {
  const needles = purgeNeedles(input.claims);
  if (!needles.length || redactionFault === 'skip_carrying_fields') return [];
  const out: RedactedField[] = [];
  const registered = new Set<string>();
  for (let after = 0; ;) {
    await faultPoint('purge:ledger_redaction', { sourceId: input.sourceId });
    const rows = await tx.executeRaw<{ id: number; subject_kind: string; subject_key: string; value: unknown; redacted_fields: string[] | null }>(`SELECT e.id, e.subject_kind,
        e.subject_key, e.value, e.redacted_fields FROM belief_events e
      WHERE e.source_id = $1 AND e.id > $2 AND e.value IS NOT NULL AND e.subject_kind IN ('fact','take','link')
        AND EXISTS (SELECT 1 FROM unnest($3::text[]) n WHERE strpos(lower(e.value::text), n) > 0)
      ORDER BY e.id LIMIT ${SCAN_BATCH}`, [input.sourceId, after, needles]);
    if (!rows.length) break;
    after = Number(rows[rows.length - 1]!.id);
    for (const row of rows) {
      const value = (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) as Record<string, unknown>;
      const fields = (CARRYING_FIELDS[row.subject_kind] ?? []).filter(f => typeof value[f] === 'string' && quotes(value[f] as string, input.claims));
      if (!fields.length) continue;
      const next = { ...value };
      for (const field of fields) {
        const tag = `${row.subject_key}\u0000${field}\u0000${fieldHash(value[field] as string)}`;
        if (!registered.has(tag)) {
          registered.add(tag);
          await tx.executeRaw(`INSERT INTO belief_redactions (source_id, subject_key, field, purge_request, field_hash)
            SELECT $1, $2, $3, $4::uuid, $5 WHERE NOT EXISTS (SELECT 1 FROM belief_redactions WHERE source_id = $1 AND subject_key = $2 AND field = $3
              AND purge_request = $4::uuid AND field_hash = $5)`, [input.sourceId, row.subject_key, field, input.request, fieldHash(value[field] as string)]);
        }
        next[field] = REDACTION_MARKER(input.request);
        out.push({ subject_key: row.subject_key, field, event_id: Number(row.id) });
      }
      const listed = [...new Set([...(row.redacted_fields ?? []), ...fields])];
      await tx.executeRaw('UPDATE belief_events SET value = $2::text::jsonb, value_hash = $3, redacted_fields = $4::text[] WHERE id = $1',
        [row.id, canonicalJson(next), valueHash(next), listed]);
    }
    if (rows.length < SCAN_BATCH) break;
  }
  return out;
}

/**
 * Pass 2, live half: a surviving row whose carrying field quotes a purged claim (a fence row's context, a take's
 * resolution evidence, a link's context) is left as it is by the purge, so its key enters the redaction register
 * with the field's current hash; its next event (a confidence edit, a reconcile, a backfill) then writes the marker
 * until the owner releases it. Returns the registered keys, which the receipt names.
 */
export async function registerLiveCarriers(tx: BrainEngine, input: { sourceId: string; request: string; claims: readonly string[] }): Promise<RedactedField[]> {
  const needles = [...new Set(input.claims.map(c => c.trim().toLowerCase()).filter(Boolean).flatMap(c => [c, escapeFenceCell(c)]))];
  const source = await readLedgerSource(tx, input.sourceId);
  if (!needles.length || !source || redactionFault === 'skip_live_carriers') return [];
  await faultPoint('purge:ledger_redaction', { sourceId: input.sourceId });
  const quoting = (column: string) => `EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(COALESCE(${column},'')), n) > 0)`;
  const slugs = (await tx.executeRaw<{ slug: string }>(`SELECT DISTINCT slug FROM (
      SELECT COALESCE(f.source_markdown_slug, f.entity_slug) AS slug FROM facts f WHERE f.source_id = $1 AND f.expired_at IS NULL AND ${quoting('f.context')}
      UNION SELECT p.slug FROM takes k JOIN pages p ON p.id = k.page_id WHERE p.source_id = $1 AND ${quoting('k.resolved_source')}
      UNION SELECT COALESCE(o.slug, f.slug) FROM links l JOIN pages f ON f.id = l.from_page_id LEFT JOIN pages o ON o.id = l.origin_page_id
        WHERE COALESCE(o.source_id, f.source_id) = $1 AND ${quoting('l.context')}) s WHERE slug IS NOT NULL ORDER BY slug`, [input.sourceId, needles])).map(r => r.slug);
  const out: RedactedField[] = [];
  for (let at = 0; at < slugs.length; at += 200) {
    const state = await readBeliefState(tx, input.sourceId, slugs.slice(at, at + 200));
    const lifetimes = await resolveLifetimes(tx, pageNeeds(input.sourceId, source.incarnation, state));
    const subjects = keyedSubjects({ incarnation: source.incarnation, lifetimes, pagesBySlug: new Map(state.pages.map(p => [p.slug, p])) }, state,
      id => state.pages.find(p => p.id === id)?.visible === false ? 'private' : 'world');
    for (const subject of subjects) for (const field of CARRYING_FIELDS[subject.kind] ?? []) {
      const text = subject.value[field];
      if (typeof text !== 'string' || !quotes(text, input.claims)) continue;
      await tx.executeRaw(`INSERT INTO belief_redactions (source_id, subject_key, field, purge_request, field_hash)
        SELECT $1, $2, $3, $4::uuid, $5 WHERE NOT EXISTS (SELECT 1 FROM belief_redactions WHERE source_id = $1 AND subject_key = $2 AND field = $3
          AND purge_request = $4::uuid AND field_hash = $5)`, [input.sourceId, subject.key, field, input.request, fieldHash(text)]);
      out.push({ subject_key: subject.key, field, event_id: 0 });
    }
  }
  return out;
}

/** The lifetimes of one page: its open lifetime at the slug and every lifetime whose page hint is the page (renames keep it). */
export async function pageLifetimesOf(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, pageId: number): Promise<string[]> {
  const rows = await tx.executeRaw<{ page_lifetime: string }>(`SELECT page_lifetime::text AS page_lifetime FROM belief_page_lifetimes
    WHERE source_id = $1 AND (page_id = $3 OR (slug = $2 AND ended_at IS NULL AND page_id IS NULL))`, [sourceId, slug, pageId]);
  return rows.map(r => r.page_lifetime);
}

/**
 * A page purge's exhaustive claim inventory: every fact and take claim on the page, every fence claim
 * in its retained versions, and every claim in its lifetimes' events (keyset batches, no row or length cap).
 */
export async function pagePurgeClaims(tx: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; slug: string; pageId: number; lifetimes: readonly string[] }): Promise<{ claims: string[]; fps: string[] }> {
  const claims = new Set<string>();
  const fps = new Set<string>();
  const live = await tx.executeRaw<{ claim: string; fp: string }>(`SELECT fact AS claim, gbrain_fact_fingerprint(fact) AS fp FROM facts WHERE source_id = $1 AND source_markdown_slug = $2
    UNION SELECT claim, gbrain_fact_fingerprint(claim) FROM takes WHERE page_id = $3`, [input.sourceId, input.slug, input.pageId]);
  for (const r of live) { claims.add(r.claim); fps.add(r.fp); }
  for (let after = 0; ;) {
    await faultPoint('purge:ledger_redaction', { sourceId: input.sourceId });
    const versions = await tx.executeRaw<{ id: number; compiled_truth: string; timeline: string | null }>(`SELECT id, compiled_truth, timeline FROM page_versions
      WHERE page_id = $1 AND id > $2 ORDER BY id LIMIT ${SCAN_BATCH}`, [input.pageId, after]);
    if (!versions.length) break;
    after = Number(versions[versions.length - 1]!.id);
    for (const v of versions) for (const body of [v.compiled_truth ?? '', v.timeline ?? '']) {
      parseFactsFence(body).facts.forEach(f => claims.add(f.claim));
      parseTakesFence(body).takes.forEach(t => claims.add(t.claim));
    }
    if (versions.length < SCAN_BATCH) break;
  }
  if (input.lifetimes.length) for (let after = 0; ;) {
    await faultPoint('purge:ledger_redaction', { sourceId: input.sourceId });
    const events = await tx.executeRaw<{ id: number; claim: string | null; claim_fp: string | null }>(`SELECT id, COALESCE(value->>'fact', value->>'claim') AS claim, claim_fp
      FROM belief_events WHERE page_lifetime = ANY($1::uuid[]) AND subject_kind IN ('fact','take') AND id > $2 ORDER BY id LIMIT ${SCAN_BATCH}`, [[...input.lifetimes], after]);
    if (!events.length) break;
    after = Number(events[events.length - 1]!.id);
    for (const e of events) { if (e.claim) claims.add(e.claim); if (e.claim_fp) fps.add(e.claim_fp); }
    if (events.length < SCAN_BATCH) break;
  }
  if (redactionFault === 'bounded_inventory') return { claims: [...new Set([...live.map(r => r.claim)].map(c => c.trim()).filter(c => c.length >= 8))].slice(0, 32), fps: [...fps] };
  return { claims: [...claims].filter(c => c.trim()), fps: [...fps] };
}

/** The stream slug of each derived row (fact: its fence page or entity; take: its page; page: itself). */
export async function derivedStreamSlugs(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, rows: readonly DerivedRow[]): Promise<Map<string, string>> {
  const ids = (table: string) => rows.filter(r => r.table === table && /^\d+$/.test(r.id)).map(r => Number(r.id));
  const found = await tx.executeRaw<{ ref: string; slug: string }>(`SELECT 'facts:' || id AS ref, COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts
      WHERE source_id = $1 AND id = ANY($2::bigint[]) AND COALESCE(source_markdown_slug, entity_slug) IS NOT NULL
    UNION ALL SELECT 'takes:' || k.id, p.slug FROM takes k JOIN pages p ON p.id = k.page_id WHERE p.source_id = $1 AND k.id = ANY($3::bigint[])
    UNION ALL SELECT 'pages:' || id, slug FROM pages WHERE source_id = $1 AND id = ANY($4::int[])`, [sourceId, ids('facts'), ids('takes'), ids('pages')]);
  return new Map(found.map(r => [r.ref, r.slug]));
}

export interface DerivedTarget { ref: string; slug: string; draft: Omit<BeliefEventDraft, 'eventType' | 'cause' | 'value'> }

/** Maps each derived row to its logical key, before the walk hides it (an expired fact leaves the stream's state). */
export async function derivedBeliefTargets(tx: BrainEngine, sourceId: string, rows: readonly DerivedRow[]): Promise<DerivedTarget[]> {
  const source = await readLedgerSource(tx, sourceId);
  if (!rows.length || !source) return [];
  const slugs = await derivedStreamSlugs(tx, sourceId, rows);
  const streams = [...new Set(slugs.values())];
  if (!streams.length) return [];
  const state = await readBeliefState(tx, sourceId, streams);
  const lifetimes = await resolveLifetimes(tx, pageNeeds(sourceId, source.incarnation, state));
  const subjects = keyedSubjects({ incarnation: source.incarnation, lifetimes, pagesBySlug: new Map(state.pages.map(p => [p.slug, p])) }, state,
    id => state.pages.find(p => p.id === id)?.visible === false ? 'private' : 'world');
  const out: DerivedTarget[] = [];
  for (const row of rows) {
    const ref = `${row.table}:${row.id}`, slug = slugs.get(ref);
    if (!slug) continue;
    const page = state.pages.find(p => p.slug === slug) ?? null;
    const lifetime = page ? lifetimes.get(page.id) ?? null : null;
    const base = { sourceId, incarnation: source.incarnation, lifetime, slug, stream: slug, stateHash: '', tierBasis: 'row' as const };
    if (row.table === 'pages' && page && lifetime) {
      out.push({ ref, slug, draft: { ...base, subjectKind: 'page', subjectKey: pageKey(lifetime), trustTier: page.tier, visibility: page.visible ? 'world' : 'private' } });
      continue;
    }
    const kind = row.table === 'facts' ? 'fact' : row.table === 'takes' ? 'take' : null;
    const subject = kind ? subjects.find(s => s.kind === kind && s.rowIds.includes(Number(row.id))) : undefined;
    if (subject) out.push({ ref, slug, draft: { ...base, subjectKind: subject.kind, subjectKey: subject.key, trustTier: subject.tier || 'unknown',
      visibility: subject.visibility, claimFp: subject.claimFp } });
  }
  return out;
}

/** Pass 3: one `derived.hidden` per hidden key, appended when coverage is active or the key already has events. */
export async function appendDerivedHidden(tx: BrainEngine, input: { sourceId: string; request: string; publicationId: string; op: string;
  targets: readonly DerivedTarget[]; truncated: boolean; cause?: Record<string, unknown> }): Promise<number> {
  if (!input.targets.length || redactionFault === 'skip_derived_hidden') return 0;
  const source = await readLedgerSource(tx, input.sourceId);
  if (!source) return 0;
  const keys = [...new Set(input.targets.map(t => t.draft.subjectKey))];
  const known = new Set((await tx.executeRaw<{ subject_key: string }>(`SELECT DISTINCT subject_key FROM belief_events WHERE source_id = $1 AND subject_key = ANY($2::text[])`,
    [input.sourceId, keys])).map(r => r.subject_key));
  const active = coverageActive(source.coverage);
  const seen = new Set<string>();
  const drafts: BeliefEventDraft[] = [];
  for (const t of input.targets) {
    if (seen.has(t.draft.subjectKey) || (!active && !known.has(t.draft.subjectKey))) continue;
    seen.add(t.draft.subjectKey);
    drafts.push({ ...t.draft, eventType: 'derived.hidden', value: null, cause: { op: input.op, purge_request: input.request, row: t.ref,
      ...(input.truncated ? { derived_walk: 'truncated' } : {}), ...input.cause } });
  }
  return appendBeliefEvents(tx, drafts, { publicationId: input.publicationId, origin: await readManagedMode(tx) ? 'live' : 'unmanaged', purgesPossible: true });
}

export interface LedgerPurgeReport { purged_events: number; redacted_fields: RedactedField[]; live_carriers: RedactedField[]; derived_hidden: number; derived_walk: 'complete' | 'truncated' }

/** Purge requests whose derivation walk was truncated: the coverage check withholds certification of their source until a complete walk runs. */
export async function truncatedPurgeWalks(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ request: string }>(`SELECT DISTINCT cause->>'purge_request' AS request FROM belief_events
    WHERE source_id = $1 AND cause->>'derived_walk' = 'truncated' AND cause->>'purge_request' IS NOT NULL ORDER BY 1`, [sourceId]);
  return rows.map(r => r.request);
}

/** The logical key of one live fact or take row and its carrying-field values, for an owner release. */
async function rowSubject(engine: BrainEngine, table: 'facts' | 'takes', id: number): Promise<{ sourceId: string; key: string; value: Record<string, unknown> } | null> {
  const [row] = await engine.executeRaw<{ source_id: string; slug: string | null }>(table === 'facts'
    ? 'SELECT source_id, COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts WHERE id = $1'
    : 'SELECT p.source_id, p.slug FROM takes k JOIN pages p ON p.id = k.page_id WHERE k.id = $1', [id]);
  if (!row?.slug) return null;
  const source = await readLedgerSource(engine, row.source_id);
  if (!source) return null;
  const state = await readBeliefState(engine, row.source_id, [row.slug]);
  const lifetimes = await resolveLifetimes(engine, pageNeeds(row.source_id, source.incarnation, state));
  const subject = keyedSubjects({ incarnation: source.incarnation, lifetimes, pagesBySlug: new Map(state.pages.map(p => [p.slug, p])) }, state,
    pageId => state.pages.find(p => p.id === pageId)?.visible === false ? 'private' : 'world')
    .find(s => s.kind === (table === 'facts' ? 'fact' : 'take') && s.rowIds.includes(id));
  return subject ? { sourceId: row.source_id, key: subject.key, value: subject.value } : null;
}

/** Carrying fields of a row under a purge redaction that a confirm would release: the current value is not released yet and is not the redacted value itself. */
export async function suppressedFields(engine: BrainEngine, table: 'facts' | 'takes', id: number): Promise<string[]> {
  const subject = await rowSubject(engine, table, id);
  if (!subject) return [];
  const rows = await engine.executeRaw<{ field: string; field_hash: string; released_hash: string | null }>(`SELECT field, field_hash, released_hash FROM belief_redactions
    WHERE source_id = $1 AND subject_key = $2`, [subject.sourceId, subject.key]);
  return [...new Set(rows.filter(r => typeof subject.value[r.field] === 'string' && r.released_hash !== fieldHash(subject.value[r.field] as string)
    && r.field_hash !== fieldHash(subject.value[r.field] as string)).map(r => r.field))];
}

/**
 * The owner release (section 6.5): the confirm action on a key binds each suppressed field to its current value
 * (`released_hash`), so the next append that writes exactly that value records it; any later change is redacted again.
 * A field still holding the value the purge redacted (`field_hash`) is never released.
 */
export async function releaseSuppressedFields(engine: BrainEngine, table: 'facts' | 'takes', id: number, releasedBy: string): Promise<string[]> {
  const subject = await rowSubject(engine, table, id);
  if (!subject) return [];
  const released: string[] = [];
  for (const field of CARRYING_FIELDS[table === 'facts' ? 'fact' : 'take'] ?? []) {
    const text = subject.value[field];
    if (typeof text !== 'string') continue;
    const rows = await engine.executeRaw(`UPDATE belief_redactions SET released_by = $4::uuid, released_hash = $5 WHERE source_id = $1 AND subject_key = $2 AND field = $3
      AND released_hash IS DISTINCT FROM $5 AND field_hash <> $5 RETURNING id`, [subject.sourceId, subject.key, field, releasedBy, fieldHash(text)]);
    if (rows.length) released.push(field);
  }
  return released;
}
