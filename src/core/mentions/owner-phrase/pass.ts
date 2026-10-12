/**
 * Owner phrases, the pass (docs/guides/owner-phrases.md). Runs inside the
 * mention pass (`mentions/pass.ts`) per source, after the plain reconcile, with
 * the gazetteer that pass built:
 *
 *   1. Off (`mentions.owner_phrases` unset or false, or mention linking off):
 *      owner-phrase links, windows, page state and status of the source go
 *      once, and the pages that held those links are marked mention-due so the
 *      plain reconcile can claim the pair.
 *   2. Scan: pages whose content revision or OWNER_PHRASE_SCAN_VERSION differ
 *      from their `owner_phrase_page_state` row are scanned (`scan.ts`).
 *   3. Build: statements are parsed from every stored scan against the current
 *      names (`statements.ts`), windows are assembled per identity group and
 *      every stored owner phrase is resolved (`windows.ts`).
 *   4. Publish, in one transaction under the source's advisory lock, only when
 *      no page of the source changed since its scan: windows are replaced when
 *      their hash changed, owner-phrase links are diffed (a pair another link
 *      already connects gets none), and the status row records the counters.
 *      A link whose window evidence includes a private page stores that page
 *      as `origin_page_id`, so untrusted readers' link-origin check hides it.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine, LinkBatchInput } from '../../engine.ts';
import type { Gazetteer } from '../../by-mention.ts';
import { executeRawJsonb } from '../../sql-query.ts';
import { privatePagesFilterFragment } from '../../search/private-visibility.ts';
import { normalizeAlias } from '../../search/alias-normalize.ts';
import { canonicalTypeOf, type MentionPolicy, type PackTypes } from '../policy.ts';
import { siblingVerdict } from '../siblings.ts';
import { titleName } from '../aliases.ts';
import { OWNER_PHRASE_SCAN_VERSION, scanPage, type CueLine, type PhraseHit } from './scan.ts';
import { buildNameIndex, findNames, parseStatements, type NameEntry, type Statement } from './statements.ts';
import { accountDescriptors, buildWindows, resolvePhrase, type OwnerWindow } from './windows.ts';

export const OWNER_PHRASE_KEY = 'mentions.owner_phrases';
/** Group key prefix of an account named in a statement that has no page (statements.ts); never stored or linked. */
const PAGELESS = 'pseudo:';
const isPageless = (slug: string) => slug.startsWith(PAGELESS);
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const SCAN_BATCH = 500;

/** The build-time switch; off unless set to a true value. */
export async function readOwnerPhrasesEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  const value = await engine.getConfig(OWNER_PHRASE_KEY).catch(() => null);
  return value != null && TRUE_VALUES.has(value.trim().toLowerCase());
}

export interface OwnerPhraseCounters {
  /** Owner-phrase links stored after the pass. */
  links: number;
  /** Documents holding at least one owner-phrase link. */
  documents: number;
  /** Phrases with no owner window covering the document's date (or no owner at all, or no page date). */
  unresolved: number;
  /** Phrases refused because two or more accounts matched, or the document's readings disagreed. */
  ambiguous: number;
  windows: number;
}

export interface OwnerPhrasePassResult extends OwnerPhraseCounters {
  state: 'off' | 'complete' | 'pending' | 'failed';
  scanned: number;
  created: number;
  removed: number;
  error?: string;
}

export interface OwnerPhrasePassOpts {
  sourceId: string;
  gazetteer: Gazetteer;
  types: string[];
  pack: PackTypes | null;
  policy: MentionPolicy;
  enabled: boolean;
  deadline: number;
  signal?: AbortSignal;
}

interface EntityRow { id: number; slug: string; type: string | null; title: string | null; identity: string | null }
interface StateRow { page_id: number; slug: string; page_date: string | null; readings: string[]; agent: boolean; cues: unknown; descriptors: string[]; hits: unknown }

function json<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function emptyResult(state: OwnerPhrasePassResult['state']): OwnerPhrasePassResult {
  return { state, scanned: 0, created: 0, removed: 0, links: 0, documents: 0, unresolved: 0, ambiguous: 0, windows: 0 };
}

/** Remove every owner-phrase row of one source; the pages that held links become mention-due. */
async function disableSource(engine: BrainEngine, sourceId: string): Promise<number> {
  return engine.transaction(async tx => {
    const rows = await tx.executeRaw<{ id: number; from_page_id: number }>(
      `DELETE FROM links l USING pages f WHERE f.id = l.from_page_id AND f.source_id = $1 AND l.link_kind = 'owner_phrase'
        RETURNING l.id, l.from_page_id`, [sourceId]);
    if (rows.length) {
      await tx.executeRaw('UPDATE page_mention_state SET mention_revision = NULL WHERE page_id = ANY($1::int[])',
        [[...new Set(rows.map(r => Number(r.from_page_id)))]]);
    }
    await tx.executeRaw('DELETE FROM owner_phrase_windows WHERE source_id = $1', [sourceId]);
    await tx.executeRaw('DELETE FROM owner_phrase_page_state WHERE source_id = $1', [sourceId]);
    await tx.executeRaw('DELETE FROM owner_phrase_status WHERE source_id = $1', [sourceId]);
    return rows.length;
  });
}

async function scanDuePages(engine: BrainEngine, sourceId: string, deadline: number, signal?: AbortSignal): Promise<{ scanned: number; done: boolean }> {
  let scanned = 0;
  let after = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() > deadline) return { scanned, done: false };
    const pages = await engine.executeRaw<{ id: number; slug: string; type: string | null; title: string | null; compiled_truth: string | null;
      timeline: string | null; frontmatter: Record<string, unknown> | null; effective_date: unknown; effective_date_source: string | null; revision: string }>(
      `SELECT p.id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.effective_date, p.effective_date_source,
              p.knowledge_revision::text AS revision
         FROM pages p LEFT JOIN owner_phrase_page_state s ON s.page_id = p.id
        WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.id > $2
          AND (s.page_id IS NULL OR s.revision IS DISTINCT FROM p.knowledge_revision OR s.version IS DISTINCT FROM $3)
        ORDER BY p.id LIMIT $4`, [sourceId, after, OWNER_PHRASE_SCAN_VERSION, SCAN_BATCH]);
    if (!pages.length) return { scanned, done: true };
    after = Number(pages[pages.length - 1]!.id);
    const rows = pages.map(p => {
      const scan = scanPage({ ...p, frontmatter: json<Record<string, unknown> | null>(p.frontmatter) });
      return { id: Number(p.id), rev: p.revision, page_date: scan.date, readings: scan.readings, agent: scan.agent, cues: scan.cues,
        descriptors: scan.descriptors, hits: scan.hits };
    });
    await executeRawJsonb(engine,
      `INSERT INTO owner_phrase_page_state (page_id, source_id, revision, version, page_date, readings, agent, cues, descriptors, hits, scanned_at)
       SELECT x.id, $1, x.rev::uuid, $2, x.page_date::date, ARRAY(SELECT jsonb_array_elements_text(x.readings)), x.agent, x.cues,
              ARRAY(SELECT jsonb_array_elements_text(x.descriptors)), x.hits, now()
         FROM jsonb_to_recordset(($3::jsonb)->'rows') AS x(id int, rev text, page_date text, readings jsonb, agent boolean, cues jsonb, descriptors jsonb, hits jsonb)
       ON CONFLICT (page_id) DO UPDATE SET revision = EXCLUDED.revision, version = EXCLUDED.version, page_date = EXCLUDED.page_date,
         readings = EXCLUDED.readings, agent = EXCLUDED.agent, cues = EXCLUDED.cues, descriptors = EXCLUDED.descriptors, hits = EXCLUDED.hits,
         scanned_at = EXCLUDED.scanned_at`,
      [sourceId, OWNER_PHRASE_SCAN_VERSION], [{ rows }]);
    scanned += rows.length;
  }
}

/** Identity groups among account pages (contract line 6): the lowest slug of a sibling group, else the page's own slug. */
function groupAccounts(accounts: EntityRow[], pack: PackTypes | null, policy: MentionPolicy): Map<string, string> {
  const bySubject = new Map<string, EntityRow[]>();
  for (const a of accounts) {
    const subject = normalizeAlias(titleName(a.title ?? ''));
    if (!subject) continue;
    const list = bySubject.get(subject) ?? [];
    list.push(a);
    bySubject.set(subject, list);
  }
  const out = new Map<string, string>(accounts.map(a => [a.slug, a.slug]));
  for (const members of bySubject.values()) {
    if (members.length < 2) continue;
    if (siblingVerdict(members, pack, policy) !== 'group') continue;
    const key = members.map(m => m.slug).sort()[0]!;
    for (const m of members) out.set(m.slug, key);
  }
  return out;
}

export interface OwnerPhraseModel {
  windows: OwnerWindow[];
  descriptors: Map<string, Set<string>>;
  links: Array<{ from_id: number; from_slug: string; to_slug: string; context: string; evidence: number[] }>;
  counters: Omit<OwnerPhraseCounters, 'links' | 'documents' | 'windows'>;
}

/** Statements, windows and resolved links of one source from its stored scans (no writes). */
export async function buildOwnerPhraseModel(engine: BrainEngine, opts: Pick<OwnerPhrasePassOpts, 'sourceId' | 'gazetteer' | 'types' | 'pack' | 'policy'>): Promise<OwnerPhraseModel> {
  const { sourceId } = opts;
  const entities = await engine.executeRaw<EntityRow>(
    `SELECT id, slug, type, title, frontmatter->>'identity' AS identity FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND type = ANY($2::text[])`, [sourceId, opts.types]);
  const isPerson = (t: string | null) => canonicalTypeOf(t, opts.pack) === 'person';
  const accounts = entities.filter(e => !isPerson(e.type));
  const accountSlugs = new Set(accounts.map(a => a.slug));
  const personSlugs = new Set(entities.filter(e => isPerson(e.type)).map(e => e.slug));
  const groups = groupAccounts(accounts, opts.pack, opts.policy);
  const groupOf = (slug: string) => groups.get(slug) ?? slug;
  const accountEntries: NameEntry[] = [];
  const personEntries: NameEntry[] = [];
  const names = new Map<string, string[]>();
  for (const bucket of opts.gazetteer.values()) {
    for (const e of bucket) {
      if (e.source_id !== sourceId) continue;
      const entry: NameEntry = { slug: e.slug, title: e.title, tokens: e.tokens, ...(e.caseTokens ? { caseTokens: e.caseTokens } : {}) };
      if (accountSlugs.has(e.slug)) {
        accountEntries.push(entry);
        names.set(e.slug, [...(names.get(e.slug) ?? []), e.matchText ?? e.title]);
      } else if (personSlugs.has(e.slug)) personEntries.push(entry);
    }
  }
  for (const a of accounts) if (!names.has(a.slug) && a.title) names.set(a.slug, [a.title]);
  const accountIndex = buildNameIndex(accountEntries);
  const personIndex = buildNameIndex(personEntries);

  const states = await engine.executeRaw<StateRow>(
    `SELECT s.page_id, p.slug, s.page_date::text AS page_date, s.readings, s.agent, s.cues, s.descriptors, s.hits
       FROM owner_phrase_page_state s JOIN pages p ON p.id = s.page_id
      WHERE s.source_id = $1 AND p.deleted_at IS NULL
        AND (jsonb_array_length(s.cues) > 0 OR jsonb_array_length(s.hits) > 0 OR cardinality(s.descriptors) > 0)
      ORDER BY s.page_id`, [sourceId]);

  const descriptors = new Map<string, Set<string>>();
  const declared = new Map(states.filter(s => accountSlugs.has(s.slug)).map(s => [s.slug, s.descriptors ?? []]));
  for (const a of accounts) {
    const set = accountDescriptors(names.get(a.slug) ?? [], declared.get(a.slug) ?? []);
    const g = groupOf(a.slug);
    descriptors.set(g, new Set([...(descriptors.get(g) ?? []), ...set]));
  }
  const descriptorGroups = new Map<string, Set<string>>();
  for (const [g, set] of descriptors) for (const d of set) descriptorGroups.set(d, new Set([...(descriptorGroups.get(d) ?? []), g]));
  const descriptorAccounts = new Map<string, Set<string>>([...descriptorGroups].map(([d, gs]) => [d, gs.size === 1 ? new Set([[...gs][0]!]) : new Set(gs)]));

  const statements: Statement[] = [];
  for (const s of states) {
    const cues = json<CueLine[]>(s.cues);
    if (!cues.length) continue;
    statements.push(...parseStatements(cues, {
      page: { id: Number(s.page_id), slug: s.slug, date: s.page_date, agent: s.agent },
      selfAccount: accountSlugs.has(s.slug) ? s.slug : null,
      accounts: accountIndex, persons: personIndex, descriptorAccounts,
    }));
  }
  const windows = buildWindows(statements, groupOf);
  const descriptorsOf = (g: string) => descriptors.get(g) ?? (isPageless(g) ? accountDescriptors([g.slice(PAGELESS.length)], []) : new Set<string>());

  const links: OwnerPhraseModel['links'] = [];
  const counters = { unresolved: 0, ambiguous: 0 };
  for (const s of states) {
    const hits = json<PhraseHit[]>(s.hits);
    if (!hits.length) continue;
    const seen = new Set<string>();
    for (const hit of hits) {
      const named = findNames(hit.owner, accountIndex);
      if (named.length && named[0]!.start === 0 && named[0]!.end === hit.owner.length) continue;
      const r = resolvePhrase(hit, s.page_date, s.readings ?? [], windows, descriptorsOf);
      if (r.linked && r.accounts.every(isPageless)) { counters.unresolved++; continue; }
      if (!r.linked) {
        if (r.reason === 'ambiguous' || r.reason === 'readings_disagree') counters.ambiguous++;
        else counters.unresolved++;
        continue;
      }
      const evidence = [...new Set(r.windows.flatMap(w => w.evidence.map(e => e.page_id)))].sort((a, b) => a - b);
      for (const to of r.accounts) {
        if (to === s.slug || seen.has(to)) continue;
        seen.add(to);
        links.push({ from_id: Number(s.page_id), from_slug: s.slug, to_slug: to, context: hit.surface, evidence });
      }
    }
  }
  return { windows: windows.filter(w => !isPageless(w.group)), descriptors, links, counters };
}

function windowsHash(windows: OwnerWindow[], privateIds: Set<number>): string {
  const rows = windows.map(w => [w.group, w.accounts, w.owner, w.ownerName, w.from, w.to, w.startKnown,
    w.evidence.map(e => [e.page_id, e.line, e.kind, e.date]), w.evidence.filter(e => privateIds.has(e.page_id)).map(e => e.page_id)]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

/** Run the owner-phrase pass for one source. Never throws for a build failure: it writes nothing and returns `failed`. */
export async function runOwnerPhrasePass(engine: BrainEngine, opts: OwnerPhrasePassOpts): Promise<OwnerPhrasePassResult> {
  const { sourceId } = opts;
  if (!opts.enabled) {
    const [had] = await engine.executeRaw<{ n: number }>(
      `SELECT (SELECT count(*) FROM owner_phrase_status WHERE source_id = $1)
            + (SELECT count(*) FROM owner_phrase_page_state WHERE source_id = $1)::int AS n`, [sourceId]);
    if (!Number(had?.n ?? 0)) {
      const [links] = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM links l JOIN pages f ON f.id = l.from_page_id WHERE f.source_id = $1 AND l.link_kind = 'owner_phrase'`, [sourceId]);
      if (!Number(links?.n ?? 0)) return emptyResult('off');
    }
    return { ...emptyResult('off'), removed: await disableSource(engine, sourceId) };
  }
  const result = emptyResult('complete');
  try {
    const scan = await scanDuePages(engine, sourceId, opts.deadline, opts.signal);
    result.scanned = scan.scanned;
    if (!scan.done) return { ...result, state: 'pending' };
    const model = await buildOwnerPhraseModel(engine, opts);
    result.unresolved = model.counters.unresolved;
    result.ambiguous = model.counters.ambiguous;
    result.windows = model.windows.length;
    const evidenceIds = [...new Set(model.windows.flatMap(w => w.evidence.map(e => e.page_id)))];
    return await engine.transaction(async tx => {
      await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`gbrain:owner-phrase:${sourceId}`]);
      const [due] = await tx.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM pages p LEFT JOIN owner_phrase_page_state s ON s.page_id = p.id
          WHERE p.source_id = $1 AND p.deleted_at IS NULL
            AND (s.page_id IS NULL OR s.revision IS DISTINCT FROM p.knowledge_revision OR s.version IS DISTINCT FROM $2)`,
        [sourceId, OWNER_PHRASE_SCAN_VERSION]);
      if (Number(due?.n ?? 0) > 0) return { ...result, state: 'pending' as const };
      const privateIds = new Set(evidenceIds.length ? (await tx.executeRaw<{ id: number }>(
        `SELECT p.id FROM pages p WHERE p.id = ANY($1::int[]) AND NOT ${privatePagesFilterFragment('p')}`, [evidenceIds])).map(r => Number(r.id)) : []);
      const hash = windowsHash(model.windows, privateIds);
      const [status] = await tx.executeRaw<{ window_hash: string | null; generation: string }>(
        'SELECT window_hash, generation::text AS generation FROM owner_phrase_status WHERE source_id = $1', [sourceId]);
      const generation = Number(status?.generation ?? 0) + (status?.window_hash === hash ? 0 : 1);
      if (status?.window_hash !== hash) {
        await tx.executeRaw('DELETE FROM owner_phrase_windows WHERE source_id = $1', [sourceId]);
        if (model.windows.length) {
          const rows = model.windows.map(w => ({
            group_key: w.group, account_slugs: w.accounts, owner_key: w.owner, owner_name: w.ownerName,
            descriptors: [...(model.descriptors.get(w.group) ?? [])].sort(), valid_from: w.from, valid_to: w.to, start_known: w.startKnown,
            evidence: w.evidence, evidence_page_ids: [...new Set(w.evidence.map(e => e.page_id))].sort((a, b) => a - b),
            private_page_id: w.evidence.map(e => e.page_id).filter(id => privateIds.has(id)).sort((a, b) => a - b)[0] ?? null,
          }));
          await executeRawJsonb(tx,
            `INSERT INTO owner_phrase_windows (source_id, group_key, account_slugs, owner_key, owner_name, descriptors, valid_from, valid_to,
                                               start_known, evidence, evidence_page_ids, private_page_id, generation)
             SELECT $1, x.group_key, ARRAY(SELECT jsonb_array_elements_text(x.account_slugs)), x.owner_key, x.owner_name,
                    ARRAY(SELECT jsonb_array_elements_text(x.descriptors)), x.valid_from::date, x.valid_to::date, x.start_known, x.evidence,
                    ARRAY(SELECT (jsonb_array_elements_text(x.evidence_page_ids))::int), x.private_page_id, $2
               FROM jsonb_to_recordset(($3::jsonb)->'rows') AS x(group_key text, account_slugs jsonb, owner_key text, owner_name text, descriptors jsonb,
                    valid_from text, valid_to text, start_known boolean, evidence jsonb, evidence_page_ids jsonb, private_page_id int)`,
            [sourceId, generation], [{ rows }]);
        }
      }
      const existing = await tx.executeRaw<{ id: number; from_page_id: number; to_slug: string; origin_page_id: number | null; context: string; kind: string | null }>(
        `SELECT l.id, l.from_page_id, t.slug AS to_slug, l.origin_page_id, l.context, l.link_kind AS kind
           FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
          WHERE f.source_id = $1 AND t.source_id = $1 AND l.from_page_id = ANY($2::int[])`,
        [sourceId, [...new Set([...model.links.map(l => l.from_id),
          ...(await tx.executeRaw<{ id: number }>(`SELECT DISTINCT l.from_page_id AS id FROM links l JOIN pages f ON f.id = l.from_page_id
              WHERE f.source_id = $1 AND l.link_kind = 'owner_phrase'`, [sourceId])).map(r => Number(r.id))])]]);
      const covered = new Set(existing.filter(r => r.kind !== 'owner_phrase').map(r => `${r.from_page_id}\0${r.to_slug}`));
      const slugById = new Map<number, string>();
      if (privateIds.size) for (const r of await tx.executeRaw<{ id: number; slug: string }>('SELECT id, slug FROM pages WHERE id = ANY($1::int[])', [[...privateIds]])) slugById.set(Number(r.id), r.slug);
      const want = new Map<string, { link: OwnerPhraseModel['links'][number]; origin: number | null }>();
      for (const l of model.links) {
        const key = `${l.from_id}\0${l.to_slug}`;
        if (covered.has(key) || want.has(key)) continue;
        want.set(key, { link: l, origin: l.evidence.find(id => privateIds.has(id)) ?? null });
      }
      const current = existing.filter(r => r.kind === 'owner_phrase');
      const keep = new Set<string>();
      const drop: number[] = [];
      for (const r of current) {
        const key = `${r.from_page_id}\0${r.to_slug}`;
        const w = want.get(key);
        if (w && !keep.has(key) && (r.origin_page_id == null ? null : Number(r.origin_page_id)) === w.origin && r.context === w.link.context) keep.add(key);
        else drop.push(Number(r.id));
      }
      if (drop.length) await tx.executeRaw('DELETE FROM links WHERE id = ANY($1::int[])', [drop]);
      const add: LinkBatchInput[] = [...want].filter(([key]) => !keep.has(key)).map(([, w]) => ({
        from_slug: w.link.from_slug, to_slug: w.link.to_slug, link_type: 'mentions', link_source: 'mentions', link_kind: 'owner_phrase',
        context: w.link.context, from_source_id: sourceId, to_source_id: sourceId,
        ...(w.origin != null ? { origin_slug: slugById.get(w.origin)!, origin_source_id: sourceId } : {}),
      }));
      const created = add.length ? await tx.addLinksBatch(add, { auditSite: 'extract.mentions' }) : 0; // gbrain-allow-direct-insert: owner-phrase pass — reconciling write of its own owner_phrase rows
      const documents = new Set([...want.values()].map(w => w.link.from_id)).size;
      await tx.executeRaw(
        `INSERT INTO owner_phrase_status (source_id, state, generation, window_hash, windows, links, documents, unresolved, ambiguous, last_pass_at, error, updated_at)
         VALUES ($1, 'complete', $2, $3, $4, $5, $6, $7, $8, now(), NULL, now())
         ON CONFLICT (source_id) DO UPDATE SET state = 'complete', generation = EXCLUDED.generation, window_hash = EXCLUDED.window_hash,
           windows = EXCLUDED.windows, links = EXCLUDED.links, documents = EXCLUDED.documents, unresolved = EXCLUDED.unresolved,
           ambiguous = EXCLUDED.ambiguous, last_pass_at = EXCLUDED.last_pass_at, error = NULL, updated_at = now()`,
        [sourceId, generation, hash, model.windows.length, want.size, documents, result.unresolved, result.ambiguous]);
      return { ...result, created, removed: drop.length, links: want.size, documents };
    });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await engine.executeRaw(
      `INSERT INTO owner_phrase_status (source_id, state, error, updated_at) VALUES ($1, 'failed', $2, now())
       ON CONFLICT (source_id) DO UPDATE SET state = 'failed', error = EXCLUDED.error, updated_at = now()`, [sourceId, message]).catch(() => {});
    return { ...result, state: 'failed', error: message };
  }
}
