/**
 * Result-time collapse (#4612, #7153, #7154): one document takes one slot.
 *
 * Runs on the deduped candidate pool before the reranker, so the slots it
 * frees go to other pages, and on both keyword-only return paths. Three kinds
 * of page fold into the best-ranked member of their group, which lists the
 * others in `collapsed`:
 *   - twin: the same slug in another source. Page identity stays
 *     (source_id, slug) everywhere else in search (dedup.ts); only result
 *     slots fold, and the twin stays named on the row.
 *   - redirect: a page that hands its identity to another page of its source:
 *     frontmatter `redirect_to` / `redirect` / `merged_into` (or an
 *     alias/redirect `status` with `superseded_by`), a `*-redirect` page
 *     type, or a short body that says it was merged or moved into a linked
 *     page. The target takes the stub's slot. A target missing from the pool
 *     is read in under the alias hop's read policy (its own source, the
 *     private and exclude predicates re-applied); a bare-word target resolves
 *     only when exactly one page of the source ends in that word. A stub
 *     whose target can't be returned stays, stamped `redirect_to`, and the
 *     rank priors demote it.
 *   - family: copies of one document: pages whose bodies are identical, or,
 *     in one source and outside entity types, slugs whose last segment
 *     differs only by a derivative suffix (-summary, -transcript, ...) or
 *     extends the other's last segment while both carry the same document
 *     date (a meeting and its transcript).
 * Only rows already in the pool are folded, so no page outside the caller's
 * results is named. `search.collapse false` turns it off.
 */
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { pageLeadSource, projectedLead } from '../page-window/bounded-lead.ts';
import { type IdentityTierOpts, isExcludedIdentity } from './alias-hop.ts';
import { isPrivatePage } from './private-visibility.ts';

export type CollapseReason = 'twin' | 'redirect' | 'family';
export interface CollapsedRef { slug: string; source_id?: string; reason: CollapseReason }

export interface CollapseDecision { twins: number; redirects: number; families: number; redirect_reads: number }

/** A stub body: "This page has been merged into [[target]]" / "... moved to [Target](/companies/target)". */
const REDIRECT_BODY = /\b(?:has been|was|is now|been)\s+(?:merged|moved|redirected|consolidated|folded)\s+(?:in)?to\s+(\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]+\))/i;
/** A page that also carries real content is not a redirect by its body text alone. */
const REDIRECT_BODY_MAX_CHARS = 600;
const REDIRECT_TYPE = /(?:^|-)redirect$/i;
const DERIVATIVE_SUFFIX = /-(?:summary|summarized|summarised|transcript|transcription|verbatim|diarized|diarised|raw|clean|cleaned|full|copy)$/;
const ENTITY_TYPES = new Set(['person', 'company', 'organization', 'deal', 'yc', 'civic', 'project']);
const DATED_SOURCES = new Set(['date', 'published', 'filename', 'event_date']);
/** Pages compared pairwise for families: the head the reranker and the caller read. */
const FAMILY_HEAD = 40;
/** Identical bodies shorter than this (empty templates, one-line stubs) say nothing about a shared document. */
const IDENTICAL_BODY_MIN_CHARS = 200;
const INJECTED_LEAD_CHARS = 1500;

const pageKey = (r: Pick<SearchResult, 'source_id' | 'slug'>) => `${r.source_id ?? 'default'}:${r.slug}`;
const leaf = (slug: string) => (slug.split('/').pop() ?? slug).replace(/\.(md|mdx|txt)$/i, '').toLowerCase();
const dir = (slug: string) => slug.includes('/') ? slug.slice(0, slug.lastIndexOf('/')) : '';

/** A redirect value as a slug: `[[people/x|X]]`, `[X](/people/x.md#a)`, `people/x.md` and `/people/x` are `people/x`. */
export function redirectTargetSlug(value: string): string | null {
  let v = value.trim();
  const md = v.match(/^\[[^\]]*\]\(([^)]+)\)$/);
  if (md) v = md[1];
  v = v.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].split('#')[0].trim();
  v = v.replace(/^<|>$/g, '').replace(/^\.?\/+/, '').replace(/\.md$/i, '').trim();
  return v && !/^[a-z]+:\/\//i.test(v) ? v : null;
}

/** Same source, same stem once derivative suffixes are stripped, or one leaf extending the other on the same document date. */
function slugFamily(a: SearchResult, b: SearchResult): boolean {
  if ((a.source_id ?? 'default') !== (b.source_id ?? 'default')) return false;
  if (ENTITY_TYPES.has(a.type) || ENTITY_TYPES.has(b.type)) return false;
  const strip = (s: string) => { for (let prev = ''; prev !== s;) { prev = s; s = s.replace(DERIVATIVE_SUFFIX, ''); } return s; };
  const [la, lb] = [leaf(a.slug), leaf(b.slug)];
  const [sa, sb] = [strip(la), strip(lb)];
  if (sa.length >= 6 && !/^\d{4}(-\d{2}){0,2}$/.test(sa) && sa === sb && (sa !== la || sb !== lb)) return true;
  const [short, long] = la.length <= lb.length ? [la, lb] : [lb, la];
  const sameDate = !!a.effective_date && a.effective_date === b.effective_date
    && DATED_SOURCES.has(a.effective_date_source ?? '') && DATED_SOURCES.has(b.effective_date_source ?? '');
  return sameDate && dir(a.slug) !== dir(b.slug) && short.length >= 6 && long.startsWith(`${short}-`);
}

class Groups {
  private parent = new Map<string, string>();
  private reason = new Map<string, CollapseReason>();
  constructor(private readonly order: Map<string, number>) {}
  find(k: string): string {
    let root = k;
    while (this.parent.has(root)) root = this.parent.get(root)!;
    return root;
  }
  /** Join two pages; the better-ranked root stays the representative. */
  join(a: string, b: string, reason: CollapseReason): void {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra === rb) return;
    const [keep, fold] = this.order.get(ra)! <= this.order.get(rb)! ? [ra, rb] : [rb, ra];
    this.parent.set(fold, keep);
    this.reason.set(fold, reason);
  }
  reasonOf(k: string): CollapseReason | undefined { return this.reason.get(k); }
}

const STATUS_REDIRECT = `lower(COALESCE(frontmatter->>'status', '')) ~ '(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)'`;

export interface PageFacts { target: string | null; body: string | null }

/** Per page id: the frontmatter redirect target and an identity hash of a substantial body. Ids already in `cache` are not read again. */
async function readPageFacts(engine: Pick<BrainEngine, 'executeRaw'>, allIds: number[], bodyIds: number[], cache: Map<number, PageFacts>): Promise<Map<number, PageFacts>> {
  const ids = allIds.filter(id => !cache.has(id));
  if (ids.length === 0) return cache;
  try {
    const rows = await engine.executeRaw<{ id: number; target: string | null; body: string | null }>(
      `SELECT id,
              COALESCE(NULLIF(btrim(frontmatter->>'redirect_to'), ''), NULLIF(btrim(frontmatter->>'redirect'), ''),
                       NULLIF(btrim(frontmatter->>'merged_into'), ''),
                       CASE WHEN ${STATUS_REDIRECT} THEN NULLIF(btrim(frontmatter->>'superseded_by'), '') END) AS target,
              CASE WHEN id = ANY($2::int[]) AND length(btrim(COALESCE(compiled_truth, ''))) >= ${IDENTICAL_BODY_MIN_CHARS} THEN md5(btrim(compiled_truth)) END AS body
         FROM pages WHERE id = ANY($1::int[])`,
      [ids, bodyIds],
    );
    for (const id of ids) cache.set(id, { target: null, body: null });
    for (const r of rows) cache.set(Number(r.id), { target: r.target, body: r.body });
  } catch {
    // fail-open: no frontmatter redirects or body identity this call
  }
  return cache;
}

/** A bare-word target resolves only to the one page of the source whose slug is that word or ends in it. */
async function resolveBareTarget(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, word: string, pages: Map<string, SearchResult[]>): Promise<string | null> {
  const inPool = [...pages.values()].map(rows => rows[0]).filter(r => (r.source_id ?? 'default') === sourceId && leaf(r.slug) === word.toLowerCase());
  if (inPool.length === 1) return inPool[0].slug;
  try {
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND (slug = $2 OR slug LIKE $3) LIMIT 2`,
      [sourceId, word, `%/${word.replace(/[%_\\]/g, '\\$&')}`],
    );
    return rows.length === 1 ? rows[0].slug : null;
  } catch {
    return null;
  }
}

/** Read a redirect target the arms did not return, under the alias hop's policy; null when it may not be shown. */
async function readTarget(engine: BrainEngine, sourceId: string, slug: string, score: number, opts: IdentityTierOpts): Promise<SearchResult | null> {
  if (isExcludedIdentity(slug, opts)) return null;
  if (opts.sourceIds && !opts.sourceIds.includes(sourceId)) return null;
  if (opts.sourceId && opts.sourceId !== sourceId) return null;
  try {
    const page = await engine.getPage(slug, { sourceId, excludePrivate: opts.excludePrivate });
    if (!page || (opts.excludePrivate && isPrivatePage(page))) return null;
    const lead = await projectedLead(engine, { slug: page.slug, source_id: page.source_id ?? sourceId, compiled_truth: await pageLeadSource(engine, page) });
    if (!lead.trim()) return null;
    return {
      page_id: page.id, slug: page.slug, title: page.title, type: page.type, source_id: page.source_id ?? sourceId,
      chunk_text: lead.slice(0, INJECTED_LEAD_CHARS), chunk_source: 'compiled_truth', chunk_id: 0, chunk_index: 0,
      score, base_score: score, stale: false,
    };
  } catch {
    return null;
  }
}

/**
 * Fold twins, redirect stubs and document families into one row group each
 * (module comment). Order-preserving: surviving rows keep their relative
 * order, and a redirect target takes its stub's slot when the stub ranked
 * higher. Returns a new array; rows that gain `collapsed` or `redirect_to` are copies.
 */
export async function collapseResults(
  engine: BrainEngine,
  results: SearchResult[],
  opts: IdentityTierOpts & { onDecision?: (d: CollapseDecision) => void; facts?: Map<number, PageFacts> } = {},
): Promise<SearchResult[]> {
  if (results.length < 2) return results;
  const pages = new Map<string, SearchResult[]>();
  const order = new Map<string, number>();
  for (const r of results) {
    const k = pageKey(r);
    if (!pages.has(k)) { pages.set(k, []); order.set(k, order.size); }
    pages.get(k)!.push(r);
  }
  const head = [...pages.keys()].slice(0, FAMILY_HEAD);
  const idOf = (k: string) => pages.get(k)![0].page_id;
  const valid = (id: number) => Number.isSafeInteger(id) && id > 0;
  const facts = await readPageFacts(engine, [...pages.keys()].map(idOf).filter(valid), head.map(idOf).filter(valid), opts.facts ?? new Map());
  const decision: CollapseDecision = { twins: 0, redirects: 0, families: 0, redirect_reads: 0 };

  // Redirect stubs and their targets (same source).
  const targets = new Map<string, string>();
  for (const [k, rows] of pages) {
    const r = rows[0];
    const fm = facts.get(r.page_id)?.target;
    const body = rows.map(x => (x.chunk_text ?? '').trim()).find(t => t.length <= REDIRECT_BODY_MAX_CHARS && REDIRECT_BODY.test(t));
    const raw = fm ?? body?.match(REDIRECT_BODY)?.[1] ?? (REDIRECT_TYPE.test(r.type) ? rows.map(x => x.chunk_text ?? '').join(' ').match(/\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]+\)/)?.[0] : undefined);
    let target = raw ? redirectTargetSlug(raw) : null;
    if (target && !target.includes('/')) target = await resolveBareTarget(engine, r.source_id ?? 'default', target, pages) ?? `\u0000${target}`;
    if (target && target !== r.slug) targets.set(k, target);
  }
  const injected = new Map<string, SearchResult>();
  for (const [stubKey, target] of targets) {
    if (target.startsWith('\u0000')) continue;
    const stub = pages.get(stubKey)![0];
    const targetKey = pageKey({ source_id: stub.source_id, slug: target });
    if (pages.has(targetKey) || injected.has(targetKey)) continue;
    const row = await readTarget(engine, stub.source_id ?? 'default', target, stub.score, opts);
    if (row) { injected.set(targetKey, row); decision.redirect_reads++; }
  }
  for (const [targetKey, row] of injected) { pages.set(targetKey, [row]); order.set(targetKey, Number.MAX_SAFE_INTEGER - order.size); }

  const groups = new Groups(order);
  const redirectStubs = new Set<string>();
  for (const [stubKey, target] of targets) {
    const stub = pages.get(stubKey)![0];
    const targetKey = pageKey({ source_id: stub.source_id, slug: target });
    if (!pages.has(targetKey)) continue;
    redirectStubs.add(stubKey);
    // The target represents the group and takes the stub's slot when the stub ranked higher.
    order.set(targetKey, Math.min(order.get(targetKey)!, order.get(stubKey)! - 0.5));
    groups.join(targetKey, stubKey, 'redirect');
  }

  const bySlug = new Map<string, string>();
  for (const [k, rows] of pages) {
    if (redirectStubs.has(k)) continue;
    const twin = bySlug.get(rows[0].slug);
    if (twin) groups.join(twin, k, 'twin'); else bySlug.set(rows[0].slug, k);
  }
  const family = head.filter(k => !redirectStubs.has(k));
  for (let i = 0; i < family.length; i++) {
    for (let j = i + 1; j < family.length; j++) {
      const [a, b] = [pages.get(family[i])![0], pages.get(family[j])![0]];
      if (groups.find(family[i]) === groups.find(family[j])) continue;
      const bodyA = facts.get(a.page_id)?.body;
      if ((bodyA && bodyA === facts.get(b.page_id)?.body) || slugFamily(a, b)) groups.join(family[i], family[j], 'family');
    }
  }

  const members = new Map<string, CollapsedRef[]>();
  for (const k of pages.keys()) {
    const root = groups.find(k);
    if (root === k) continue;
    const r = pages.get(k)![0];
    // A page an identity tier re-injected after the first pass is already listed on its representative.
    if (pages.get(root)![0].collapsed?.some(c => c.slug === r.slug && c.source_id === r.source_id)) continue;
    const reason = groups.reasonOf(k)!;
    decision[reason === 'twin' ? 'twins' : reason === 'redirect' ? 'redirects' : 'families']++;
    members.set(root, [...members.get(root) ?? [], { slug: r.slug, ...(r.source_id ? { source_id: r.source_id } : {}), reason }]);
  }
  const unresolved = new Map([...targets].filter(([k]) => !redirectStubs.has(k)).map(([k, t]) => [k, t.replace(/^\u0000/, '')]));
  const folded = [...pages.keys()].some(k => groups.find(k) !== k);
  if (!folded && unresolved.size === 0) return results;

  const mark = (r: SearchResult, k: string): SearchResult => {
    const collapsed = members.get(k);
    const redirectTo = unresolved.get(k);
    if (!collapsed && !redirectTo) return r;
    return { ...r, ...(collapsed ? { collapsed: [...(r.collapsed ?? []), ...collapsed] } : {}), ...(redirectTo ? { redirect_to: redirectTo } : {}) };
  };
  const out: SearchResult[] = [];
  const moved = new Set<SearchResult>();
  for (const r of results) {
    const k = pageKey(r);
    const root = groups.find(k);
    if (root !== k) {
      // A redirect stub's slot goes to its target when the stub ranked higher.
      const lead = pages.get(root)![0];
      if (groups.reasonOf(k) === 'redirect' && !moved.has(lead) && !out.some(o => pageKey(o) === root)) {
        out.push(mark(lead, root));
        moved.add(lead);
      }
      continue;
    }
    if (!moved.has(r)) out.push(mark(r, k));
  }
  opts.onDecision?.(decision);
  return out;
}
