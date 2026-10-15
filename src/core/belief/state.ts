/**
 * Raw canonical state of belief streams (docs/designs/BELIEF_LEDGER.md sections 3-4).
 *
 * A stream is one slug of one source: its page, the fence facts it projects
 * (`source_markdown_slug`), the database-only facts about it (`entity_slug`
 * with no `source_markdown_slug`), its takes, and the links and link
 * transitions whose origin (else from) page it is. The finalization contract
 * reads it under the publication's page keys before and after the transaction's
 * projections and diffs the two on logical keys, so projection churn (rows
 * rewritten with identical values, renumbered, re-inserted) yields no event.
 */
import type { BrainEngine } from '../engine.ts';
import { pipelined } from '../page-state/transactions.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { PAGE_INLINE_MAX_BYTES } from '../page-size-policy.ts';

export interface RawPage {
  id: number; slug: string; deleted: boolean; revision: string; content_hash: string | null; tier: string;
  visible: boolean; large: boolean; incarnation: string;
}
export interface RawFact {
  id: number; entity_slug: string | null; sms: string | null; entity_page_id: number | null; fact: string; fp: string;
  kind: string; visibility: string; notability: string; context: string | null; confidence: number;
  valid_from: string | null; valid_until: string | null; claim_metric: string | null; claim_value: number | null;
  claim_unit: string | null; claim_period: string | null; event_type: string | null; dimension: string | null;
  value: string | null; value_hash: string | null; row_num: number | null; tier: string;
}
export interface RawTake {
  id: number; page_id: number; row_num: number; claim: string; claim_fp: string; kind: string; holder: string; weight: number;
  since_date: string | null; until_date: string | null; source: string | null; active: boolean;
  resolved_at: string | null; resolved_outcome: boolean | null; resolved_value: number | null; resolved_unit: string | null;
  resolved_source: string | null; resolved_by: string | null; resolved_quality: string | null; tier: string;
}
export interface RawEndpoint { id: number; slug: string; source_id: string; incarnation: string }
export interface RawLink {
  id: number; from: RawEndpoint; to: RawEndpoint; origin: RawEndpoint | null; link_type: string; link_source: string | null;
  context: string; origin_field: string | null; link_kind: string | null; resolution_type: string | null; assertion_tense: string | null;
}
export interface RawTransition {
  id: number; from: RawEndpoint; to: RawEndpoint; origin: RawEndpoint | null; link_type: string; kind: string;
  occurred_on: string; date_precision: string; producer: string; line_hash: string;
}
export interface RawState { pages: RawPage[]; facts: RawFact[]; takes: RawTake[]; links: RawLink[]; transitions: RawTransition[]; writerTier: string | null }

const iso = (value: unknown): string | null => value == null ? null : new Date(value as string).toISOString();
const num = (value: unknown): number | null => value == null ? null : Number(value);

const ENDPOINT = (alias: string, as: string) =>
  `${alias}.id AS ${as}_id, ${alias}.slug AS ${as}_slug, ${alias}.source_id AS ${as}_source, ${as}s.incarnation::text AS ${as}_inc`;
const endpoint = (row: Record<string, unknown>, as: string): RawEndpoint | null => row[`${as}_id`] == null ? null
  : { id: Number(row[`${as}_id`]), slug: String(row[`${as}_slug`]), source_id: String(row[`${as}_source`]), incarnation: String(row[`${as}_inc`]) };

/**
 * One pipeline of five reads. `slugs` select the stream pages and the facts
 * keyed to them; `pageIds` add pages by id (a renamed page is found at its new
 * slug); `factIds`/`takeIds` add rows a guard named that live in another stream.
 */
export async function readBeliefState(tx: BrainEngine, sourceId: string, slugs: readonly string[], pageIds: readonly number[] = []): Promise<RawState> {
  const pageRows = await tx.executeRaw<Record<string, unknown>>(`SELECT p.id, p.slug, p.deleted_at IS NOT NULL AS deleted, p.knowledge_revision::text AS revision,
      p.content_hash, p.trust_tier, (${privatePagesFilterFragment('p')}) AS visible, s.incarnation::text AS incarnation,
      (p.body_storage = 'segmented' OR octet_length(COALESCE(p.compiled_truth,'')) + octet_length(COALESCE(p.timeline,'')) > ${PAGE_INLINE_MAX_BYTES}) AS large,
      current_setting('gbrain.write_trust_tier', true) AS writer_tier
    FROM pages p JOIN sources s ON s.id = p.source_id
    WHERE p.source_id = $1 AND (p.slug = ANY($2::text[]) OR p.id = ANY($3::int[]))`, [sourceId, [...slugs], [...pageIds]]);
  const pages: RawPage[] = pageRows.map(r => ({ id: Number(r.id), slug: String(r.slug), deleted: r.deleted === true, revision: String(r.revision),
    content_hash: (r.content_hash as string | null) ?? null, tier: String(r.trust_tier), visible: r.visible === true, large: r.large === true,
    incarnation: String(r.incarnation) }));
  const ids = pages.map(p => p.id);
  const allSlugs = [...new Set([...slugs, ...pages.map(p => p.slug)])];
  const [facts, takes, links, transitions] = await pipelined(tx, [
    () => tx.executeRaw<Record<string, unknown>>(`SELECT f.id, f.entity_slug, f.source_markdown_slug AS sms, pe.id AS entity_page_id, f.fact,
        gbrain_fact_fingerprint(f.fact) AS fp, f.kind, f.visibility, f.notability, f.context, f.confidence::text AS confidence,
        f.valid_from, f.valid_until, f.claim_metric, f.claim_value::text AS claim_value, f.claim_unit, f.claim_period, f.event_type,
        f.dimension, f.value, f.value_hash, f.row_num, f.trust_tier
      FROM facts f LEFT JOIN pages pe ON pe.source_id = f.source_id AND pe.slug = f.entity_slug
      WHERE f.source_id = $1 AND f.expired_at IS NULL
        AND (f.source_markdown_slug = ANY($2::text[]) OR (f.source_markdown_slug IS NULL AND f.entity_slug = ANY($2::text[])))`, [sourceId, allSlugs]),
    () => ids.length ? tx.executeRaw<Record<string, unknown>>(`SELECT k.id, k.page_id, k.row_num, k.claim, gbrain_fact_fingerprint(k.claim) AS claim_fp,
        k.kind, k.holder, k.weight::text AS weight, k.since_date, k.until_date, k.source, k.active, k.resolved_at, k.resolved_outcome,
        k.resolved_value::text AS resolved_value, k.resolved_unit, k.resolved_source, k.resolved_by, k.resolved_quality, k.trust_tier
      FROM takes k WHERE k.page_id = ANY($1::int[])`, [ids]) : Promise.resolve([]),
    () => ids.length ? tx.executeRaw<Record<string, unknown>>(`SELECT l.id, ${ENDPOINT('f', 'f')}, ${ENDPOINT('t', 't')}, ${ENDPOINT('o', 'o')},
        l.link_type, l.link_source, l.context, l.origin_field, l.link_kind, l.resolution_type, l.assertion_tense
      FROM links l JOIN pages f ON f.id = l.from_page_id JOIN sources fs ON fs.id = f.source_id
        JOIN pages t ON t.id = l.to_page_id JOIN sources ts ON ts.id = t.source_id
        LEFT JOIN pages o ON o.id = l.origin_page_id LEFT JOIN sources os ON os.id = o.source_id
      WHERE l.origin_page_id = ANY($1::int[]) OR (l.origin_page_id IS NULL AND l.from_page_id = ANY($1::int[]))`, [ids]) : Promise.resolve([]),
    () => ids.length ? tx.executeRaw<Record<string, unknown>>(`SELECT x.id, ${ENDPOINT('f', 'f')}, ${ENDPOINT('t', 't')}, ${ENDPOINT('o', 'o')},
        x.link_type, x.kind, x.occurred_on::text AS occurred_on, x.date_precision, x.producer, x.line_hash
      FROM link_transitions x JOIN pages f ON f.id = x.from_page_id JOIN sources fs ON fs.id = f.source_id
        JOIN pages t ON t.id = x.to_page_id JOIN sources ts ON ts.id = t.source_id
        LEFT JOIN pages o ON o.id = x.origin_page_id LEFT JOIN sources os ON os.id = o.source_id
      WHERE x.origin_page_id = ANY($1::int[]) OR (x.origin_page_id IS NULL AND x.from_page_id = ANY($1::int[]))`, [ids]) : Promise.resolve([]),
  ]) as Array<Record<string, unknown>[]>;
  return {
    pages,
    facts: facts.map(toFact),
    takes: takes.map(toTake),
    links: links.map(r => ({ id: Number(r.id), from: endpoint(r, 'f')!, to: endpoint(r, 't')!, origin: endpoint(r, 'o'), link_type: String(r.link_type),
      link_source: (r.link_source as string | null) ?? null, context: String(r.context ?? ''), origin_field: (r.origin_field as string | null) ?? null,
      link_kind: (r.link_kind as string | null) ?? null, resolution_type: (r.resolution_type as string | null) ?? null,
      assertion_tense: (r.assertion_tense as string | null) ?? null })),
    transitions: transitions.map(r => ({ id: Number(r.id), from: endpoint(r, 'f')!, to: endpoint(r, 't')!, origin: endpoint(r, 'o'),
      link_type: String(r.link_type), kind: String(r.kind), occurred_on: String(r.occurred_on), date_precision: String(r.date_precision),
      producer: String(r.producer), line_hash: String(r.line_hash) })),
    writerTier: (pageRows[0]?.writer_tier as string | undefined) || null,
  };
}

/** Rows by id, for a guard event whose row lives outside the batch's streams. */
export async function readFactsById(tx: BrainEngine, ids: readonly number[]): Promise<RawFact[]> {
  if (!ids.length) return [];
  const rows = await tx.executeRaw<Record<string, unknown>>(`SELECT f.id, f.entity_slug, f.source_markdown_slug AS sms, pe.id AS entity_page_id, f.fact,
      gbrain_fact_fingerprint(f.fact) AS fp, f.kind, f.visibility, f.notability, f.context, f.confidence::text AS confidence,
      f.valid_from, f.valid_until, f.claim_metric, f.claim_value::text AS claim_value, f.claim_unit, f.claim_period, f.event_type,
      f.dimension, f.value, f.value_hash, f.row_num, f.trust_tier
    FROM facts f LEFT JOIN pages pe ON pe.source_id = f.source_id AND pe.slug = f.entity_slug WHERE f.id = ANY($1::bigint[])`, [[...ids]]);
  return rows.map(toFact);
}

function toFact(r: Record<string, unknown>): RawFact {
  return { id: Number(r.id), entity_slug: (r.entity_slug as string | null) ?? null, sms: (r.sms as string | null) ?? null,
    entity_page_id: num(r.entity_page_id), fact: String(r.fact), fp: String(r.fp), kind: String(r.kind), visibility: String(r.visibility),
    notability: String(r.notability), context: (r.context as string | null) ?? null, confidence: Number(r.confidence),
    valid_from: iso(r.valid_from), valid_until: iso(r.valid_until), claim_metric: (r.claim_metric as string | null) ?? null,
    claim_value: num(r.claim_value), claim_unit: (r.claim_unit as string | null) ?? null, claim_period: (r.claim_period as string | null) ?? null,
    event_type: (r.event_type as string | null) ?? null, dimension: (r.dimension as string | null) ?? null, value: (r.value as string | null) ?? null,
    value_hash: (r.value_hash as string | null) ?? null, row_num: num(r.row_num), tier: String(r.trust_tier) };
}

function toTake(r: Record<string, unknown>): RawTake {
  return { id: Number(r.id), page_id: Number(r.page_id), row_num: Number(r.row_num), claim: String(r.claim), claim_fp: String(r.claim_fp),
    kind: String(r.kind), holder: String(r.holder), weight: Number(r.weight), since_date: (r.since_date as string | null) ?? null,
    until_date: (r.until_date as string | null) ?? null, source: (r.source as string | null) ?? null, active: r.active === true,
    resolved_at: iso(r.resolved_at), resolved_outcome: (r.resolved_outcome as boolean | null) ?? null, resolved_value: num(r.resolved_value),
    resolved_unit: (r.resolved_unit as string | null) ?? null, resolved_source: (r.resolved_source as string | null) ?? null,
    resolved_by: (r.resolved_by as string | null) ?? null, resolved_quality: (r.resolved_quality as string | null) ?? null, tier: String(r.trust_tier) };
}
