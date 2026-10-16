/**
 * Identity events outside a publication diff (docs/designs/BELIEF_LEDGER.md
 * section 3) and the slug-at-time lookup replay uses.
 *
 * A cheap rename (`updateSlug`) keeps the page row, so the publication's batch
 * pairs the two sides by page id and records `page.renamed` itself. The
 * fallback rename (#5431) materializes the destination as a new row and moves
 * the old row's identity onto it; `recordFallbackRename` gives the destination
 * the old page's lifetime, so the rename is one `page.renamed` and the history
 * stays on one lifetime.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { assertHeldPageKeys } from '../page-state/guards.ts';
import { appendBeliefEvents } from './append.ts';
import { pageKey } from './keys.ts';
import { coverageActive, currentStateHash, readLedgerSource } from './ledger.ts';
import { endLifetime, mintLifetime, readOpenLifetimes, renameLifetime } from './lifetimes.ts';

/**
 * Inside the fallback rename's transaction, after its row moves, with both
 * slugs' page keys held: the destination row takes the stale row's lifetime
 * (the destination's own lifetime, minted by its import, ends) and one
 * `page.renamed` is appended. Returns the publication id when it appended.
 */
export async function recordFallbackRename(tx: BrainEngine, input: { sourceId: string; staleSlug: string; newSlug: string; fromPageId: number; toPageId: number }): Promise<string | null> {
  const source = await readLedgerSource(tx, input.sourceId);
  if (!source || !coverageActive(source.coverage)) return null;
  assertHeldPageKeys(tx, [{ sourceId: input.sourceId, slug: input.staleSlug }, { sourceId: input.sourceId, slug: input.newSlug }]);
  const open = await readOpenLifetimes(tx, [{ incarnation: source.incarnation, slug: input.staleSlug }, { incarnation: source.incarnation, slug: input.newSlug }]);
  const stale = open.get(`${source.incarnation}\u0000${input.staleSlug}`);
  const lifetime = stale && (stale.page_id == null || stale.page_id === input.fromPageId) ? stale.page_lifetime
    : await mintLifetime(tx, { sourceId: input.sourceId, incarnation: source.incarnation, slug: input.staleSlug, pageId: input.fromPageId });
  const absorbed = open.get(`${source.incarnation}\u0000${input.newSlug}`)?.page_lifetime;
  if (absorbed && absorbed !== lifetime) await endLifetime(tx, absorbed);
  await renameLifetime(tx, lifetime, input.newSlug, input.toPageId);
  const [page] = await tx.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE id = $1', [input.toPageId]);
  const { hash, state } = await currentStateHash(tx, input.sourceId, source.incarnation, input.newSlug);
  const visible = state.pages.find(p => p.id === input.toPageId)?.visible !== false;
  const publicationId = randomUUID();
  const appended = await appendBeliefEvents(tx, [{ sourceId: input.sourceId, incarnation: source.incarnation, lifetime, slug: input.newSlug, stream: input.newSlug,
    subjectKind: 'page', subjectKey: pageKey(lifetime), eventType: 'page.renamed', trustTier: page?.trust_tier || 'unknown',
    visibility: visible ? 'world' : 'private', value: { old_slug: input.staleSlug, new_slug: input.newSlug, ...(absorbed && absorbed !== lifetime ? { absorbed_lifetime: absorbed } : {}) },
    stateHash: hash, cause: { op: 'rename_fallback' } }], { publicationId, origin: source.managed ? 'live' : 'unmanaged', purgesPossible: source.purgesPossible });
  return appended ? publicationId : null;
}

/**
 * The slug a page lifetime had at `at`, from its own events (each carries the
 * stream slug at recording time); null when the lifetime had no event by then.
 * Replay resolves a rename this way: before it, the old slug.
 */
export async function lifetimeSlugAt(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, lifetime: string, at: Date): Promise<string | null> {
  const [row] = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM belief_events
    WHERE source_id = $1 AND page_lifetime = $2::uuid AND subject_kind = 'page' AND recorded_at <= $3::timestamptz ORDER BY id DESC LIMIT 1`,
  [sourceId, lifetime, at.toISOString()]);
  return row?.slug ?? null;
}

/**
 * The page lifetime that held `slug` at `at`: the lifetime of the newest page
 * event recorded at that slug by then, unless that lifetime had moved to
 * another slug by then. Null when no page held it.
 */
export async function lifetimeAtSlug(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, at: Date): Promise<string | null> {
  const [row] = await engine.executeRaw<{ lifetime: string }>(`SELECT e.page_lifetime::text AS lifetime FROM belief_events e
    WHERE e.source_id = $1 AND e.slug = $2 AND e.subject_kind = 'page' AND e.page_lifetime IS NOT NULL AND e.recorded_at <= $3::timestamptz
    ORDER BY e.id DESC LIMIT 1`, [sourceId, slug, at.toISOString()]);
  if (!row) return null;
  return await lifetimeSlugAt(engine, sourceId, row.lifetime, at) === slug ? row.lifetime : null;
}
