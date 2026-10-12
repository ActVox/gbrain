/**
 * get_backlinks' entity-recall parameters (`type`, `group`, `limit`,
 * `cursor`). With none of them the op is today's bare `Link[]` read
 * (ops/links.ts readLinkEdges). `type` filters by the referring page's type
 * in both modes (a pack-canonical type, or any stored type observed on a
 * referrer; `untyped` for untyped pages). `group: "page"` returns
 * `{rows, total, truncated, cursor, coverage}`: one row per referring page,
 * newest first by `(date DESC, source_id, slug)`, read through the same
 * helper as the entity card's `referenced_by`, so a card group's `next` call
 * continues it exactly. `group: "known_as"` pages the card's owner windows
 * (`known_as.next`) with the same `{rows, total, truncated, cursor}` shape.
 */

import { opError, type OperationContext } from './contract.ts';
import type { Link, PageReadPolicy } from '../types.ts';
import type { Notice } from '../agent-output.ts';
import { canonicalTypeOf, loadSourcePack } from '../mentions/policy.ts';
import {
  decodeCursor, readReferrerPage, referrerTypes, PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT, type ReferenceRow, type ReferrerScope,
} from '../mentions/referrers.ts';
import { mentionCoverageNotice, readMentionCoverage, type MentionCoverage } from '../mentions/coverage.ts';
import { decodeKnownAsCursor, readKnownAsPage, type KnownAsRow } from '../mentions/owner-phrase/known-as.ts';

export interface BacklinkPage {
  rows: ReferenceRow[];
  total: number;
  truncated: boolean;
  cursor: string | null;
  coverage: MentionCoverage;
}

/** True when the call uses any entity-recall parameter. */
export function wantsPagedBacklinks(p: Record<string, unknown>): boolean {
  return p.type !== undefined || p.group !== undefined || p.limit !== undefined || p.cursor !== undefined;
}

function parseLimit(p: Record<string, unknown>, fallback: number | undefined): number | undefined {
  if (p.limit === undefined) return fallback;
  const n = typeof p.limit === 'string' ? Number(p.limit) : p.limit;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > PAGE_MAX_LIMIT) {
    throw opError('invalid_params', `get_backlinks: limit must be an integer from 1 to ${PAGE_MAX_LIMIT}.`,
      `Pass limit between 1 and ${PAGE_MAX_LIMIT}; page through the rest with group: "page" and the returned cursor.`);
  }
  return n;
}

async function scopeSources(ctx: OperationContext, policy: PageReadPolicy): Promise<string[]> {
  if (policy.sourceIds?.length) return policy.sourceIds;
  if (policy.sourceId) return [policy.sourceId];
  return (await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id')).map(r => r.id);
}

/** The entity page's source: the first source in scope holding a live page with this slug. */
async function targetSource(ctx: OperationContext, slug: string, sources: string[]): Promise<string | null> {
  const rows = await ctx.engine.executeRaw<{ source_id: string }>(
    'SELECT source_id FROM pages WHERE slug = $1 AND source_id = ANY($2::text[]) AND deleted_at IS NULL', [slug, sources]);
  const found = new Set(rows.map(r => r.source_id));
  return sources.find(s => found.has(s)) ?? null;
}

async function referrerScope(ctx: OperationContext, slug: string, policy: PageReadPolicy): Promise<{ scope: ReferrerScope; sources: string[] } | null> {
  const sources = await scopeSources(ctx, policy);
  const sourceId = await targetSource(ctx, slug, sources);
  if (!sourceId) return null;
  const pack = await loadSourcePack(ctx.engine, sourceId);
  const excludePrivate = policy.excludePrivate === true;
  return { sources, scope: { slug, sourceId, referrerSources: sources, excludePrivate, pack, keepVisibility: excludePrivate ? ['world'] : ['private', 'world'] } };
}

async function assertKnownType(ctx: OperationContext, scope: ReferrerScope, type: string): Promise<void> {
  const declared = (scope.pack?.page_types ?? []).flatMap(pt => [pt.name, ...(pt.aliases ?? [])]);
  if (declared.includes(type) || type === 'untyped') return;
  const observed = await referrerTypes(ctx.engine, scope);
  if (observed.includes(type)) return;
  const canonical = (scope.pack?.page_types ?? []).map(pt => pt.name);
  const valid = [...new Set([...observed, ...canonical, 'untyped'])].sort();
  throw opError('invalid_params', `get_backlinks: unknown type "${type}".`,
    `Use a type this page's referrers have (${observed.join(', ') || 'none yet'}), a schema-pack type or untyped; valid values: ${valid.join(', ')}.`,
    { detail: JSON.stringify({ valid_types: valid, referrer_types: observed }) });
}

/**
 * `group: "page"`: one page of referring pages. A slug with no live page in
 * scope answers like an empty read (no rows, total 0).
 */
export async function readBacklinkPage(ctx: OperationContext, p: Record<string, unknown>, policy: PageReadPolicy): Promise<BacklinkPage | KnownAsPage> {
  if (p.group === 'known_as') return readKnownAsGroup(ctx, p, policy);
  if (p.group !== 'page') {
    throw opError('invalid_params', `get_backlinks: group must be "page" or "known_as".`, 'Pass group: "page" for one row per referring page, group: "known_as" for the card\'s owner windows, or omit group for link rows.');
  }
  const limit = parseLimit(p, PAGE_DEFAULT_LIMIT)!;
  const cursor = p.cursor === undefined ? null : decodeCursor(String(p.cursor));
  if (p.cursor !== undefined && !cursor) {
    throw opError('invalid_params', 'get_backlinks: cursor is not one this tool returned.', 'Pass the cursor from the previous get_backlinks response unchanged, or omit it to start from the newest page.');
  }
  const resolved = await referrerScope(ctx, String(p.slug), policy);
  const coverage = await readMentionCoverage(ctx.engine, resolved?.sources ?? await scopeSources(ctx, policy));
  const notice = mentionCoverageNotice(coverage);
  if (notice) ctx.emitNotice?.(notice);
  if (!resolved) return { rows: [], total: 0, truncated: false, cursor: null, coverage };
  const type = typeof p.type === 'string' && p.type ? p.type : undefined;
  if (type) await assertKnownType(ctx, resolved.scope, type);
  return { ...await readReferrerPage(ctx.engine, resolved.scope, { type, limit, cursor }), coverage };
}

export interface KnownAsPage { rows: KnownAsRow[]; total: number; truncated: boolean; cursor: string | null }

/**
 * `group: "known_as"`: one page of the entity card's owner windows
 * (mentions/owner-phrase/known-as.ts), continuing a card's `known_as.next`.
 * A slug with no live page in scope answers like an empty read.
 */
async function readKnownAsGroup(ctx: OperationContext, p: Record<string, unknown>, policy: PageReadPolicy): Promise<KnownAsPage> {
  if (p.type !== undefined) {
    throw opError('invalid_params', 'get_backlinks: type does not apply to group: "known_as".', 'Omit type with group: "known_as".');
  }
  const limit = parseLimit(p, PAGE_DEFAULT_LIMIT)!;
  const after = p.cursor === undefined ? null : decodeKnownAsCursor(String(p.cursor));
  if (p.cursor !== undefined && !after) {
    throw opError('invalid_params', 'get_backlinks: cursor is not one this tool returned.', 'Pass the cursor from the previous known_as response unchanged, or omit it to start from the newest window.');
  }
  const sourceId = await targetSource(ctx, String(p.slug), await scopeSources(ctx, policy));
  if (!sourceId) return { rows: [], total: 0, truncated: false, cursor: null };
  const page = await readKnownAsPage(ctx.engine, sourceId, String(p.slug), { excludePrivate: policy.excludePrivate === true, limit, after });
  return { rows: page.rows, total: page.total, truncated: page.cursor !== null, cursor: page.cursor };
}

/**
 * Array mode with `type` and/or `limit`: today's link rows, filtered by the
 * referring page's type and cut at `limit` (a cut is reported with a
 * `listing_truncated` notice naming the paged call).
 */
export async function filterBacklinkRows(ctx: OperationContext, p: Record<string, unknown>, policy: PageReadPolicy, links: Link[]): Promise<Link[]> {
  if (p.cursor !== undefined) {
    throw opError('invalid_params', 'get_backlinks: cursor needs group: "page".', 'Pass group: "page" with the cursor, or omit cursor.');
  }
  const limit = parseLimit(p, undefined);
  let rows = links;
  const type = typeof p.type === 'string' && p.type ? p.type : undefined;
  if (type) {
    const resolved = await referrerScope(ctx, String(p.slug), policy);
    if (resolved) await assertKnownType(ctx, resolved.scope, type);
    const keys = [...new Set(links.map(l => `${l.from_source_id}\0${l.from_slug}`))];
    const types = new Map((await ctx.engine.executeRaw<{ source_id: string; slug: string; type: string | null }>(
      `SELECT p.source_id, p.slug, p.type FROM pages p JOIN unnest($1::text[], $2::text[]) AS k(s, g) ON p.source_id = k.s AND p.slug = k.g`,
      [keys.map(k => k.split('\0')[0]), keys.map(k => k.split('\0')[1])])).map(r => [`${r.source_id}\0${r.slug}`, r.type]));
    const packs = new Map<string, Awaited<ReturnType<typeof loadSourcePack>>>();
    const filtered: Link[] = [];
    for (const l of links) {
      if (!packs.has(l.from_source_id)) packs.set(l.from_source_id, await loadSourcePack(ctx.engine, l.from_source_id));
      const stored = types.get(`${l.from_source_id}\0${l.from_slug}`) ?? null;
      if (stored === type || canonicalTypeOf(stored, packs.get(l.from_source_id) ?? null) === type) filtered.push(l);
    }
    rows = filtered;
  }
  if (limit !== undefined && rows.length > limit) {
    const notice: Notice = {
      code: 'listing_truncated', kind: 'info',
      why: `${rows.length} link rows match; ${limit} were returned. For one row per referring page with a cursor, use group: "page".`,
      fix: { mcp: { tool: 'get_backlinks', arguments: { slug: p.slug, ...(p.source_id !== undefined ? { source_id: p.source_id } : {}),
        ...(type ? { type } : {}), group: 'page', limit } }, consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Pages through every referring page, newest first, without dropping rows.' },
    };
    ctx.emitNotice?.(notice);
    rows = rows.slice(0, limit);
  }
  return rows;
}
