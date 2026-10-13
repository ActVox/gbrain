/**
 * The entity card's `known_as` rows: each owner of an account with the
 * validity window of its owner phrase ("<owner>'s <descriptor> account"),
 * read from `owner_phrase_windows`. The card shows KNOWN_AS_MAX rows with the
 * total; when rows < total it carries a `next` continuation through the
 * card's existing mechanism: `get_backlinks` with `group: "known_as"` and a
 * keyset cursor, ordered newest window first by (start, owner, account group,
 * end), so the continuation reproduces the card's order exactly. Untrusted
 * readers never see a window whose evidence includes a private page. Owner
 * phrases are never aliases: they stay out of `aka`, `page_aliases` and search
 * alias fan-out. The card read is fail-soft (a read error returns nothing).
 */

import type { BrainEngine } from '../../engine.ts';
import { PAGE_DEFAULT_LIMIT } from '../referrers.ts';

export const KNOWN_AS_MAX = 10;

export interface KnownAsRow {
  owner: string;
  /** The words an owner phrase may use for this account ("freight" in "Alice's freight account"). */
  descriptors: string[];
  /** Inclusive first day, or null when the start is unknown and unbounded. */
  from: string | null;
  /** Inclusive last day, or null while the stint is open. */
  to: string | null;
  start_known: boolean;
  evidence: Array<{ slug: string; line: number; kind: string }>;
}

export interface KnownAsNext { tool: 'get_backlinks'; arguments: Record<string, unknown>; requires_surface?: 'starter' }
export interface KnownAs { rows: KnownAsRow[]; total: number; next?: KnownAsNext }

type Key = [string, string, string, string];
const NO_START = '0001-01-01';
const NO_END = '9999-12-31';

export function encodeKnownAsCursor(key: Key): string {
  return Buffer.from(JSON.stringify(['known_as', ...key])).toString('base64url');
}

export function decodeKnownAsCursor(cursor: string): Key | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 5 && v[0] === 'known_as' && v.slice(1).every(x => typeof x === 'string')) return v.slice(1) as Key;
  } catch { /* invalid */ }
  return null;
}

/** One page of an account's windows, newest first; `cursor` continues after the last row. */
export async function readKnownAsPage(engine: BrainEngine, sourceId: string, slug: string,
  opts: { excludePrivate: boolean; limit: number; after?: Key | null }): Promise<{ rows: KnownAsRow[]; total: number; cursor: string | null }> {
  const params: unknown[] = [sourceId, slug, opts.limit];
  const scope = `source_id = $1 AND (group_key = $2 OR $2 = ANY(account_slugs))${opts.excludePrivate ? ' AND private_page_id IS NULL' : ''}`;
  let keyset = '';
  if (opts.after) {
    params.push(...opts.after);
    keyset = `AND (d < $4 OR (d = $4 AND (owner_key COLLATE "C", group_key COLLATE "C", e) > ($5, $6, $7)))`;
  }
  const rows = await engine.executeRaw<{ owner_name: string; owner_key: string; group_key: string; descriptors: string[]; f: string | null; t: string | null;
    d: string; e: string; start_known: boolean; evidence: unknown; total: number; remaining: number }>(
    `SELECT w.*, count(*) OVER ()::int AS remaining FROM (
       SELECT owner_name, owner_key, group_key, descriptors, valid_from::text AS f, valid_to::text AS t,
              COALESCE(valid_from::text, '${NO_START}') AS d, COALESCE(valid_to::text, '${NO_END}') AS e, start_known, evidence,
              count(*) OVER ()::int AS total
         FROM owner_phrase_windows WHERE ${scope}) w
      WHERE TRUE ${keyset}
      ORDER BY d DESC, owner_key COLLATE "C", group_key COLLATE "C", e LIMIT $3`, params);
  const total = rows.length ? Number(rows[0]!.total)
    : Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM owner_phrase_windows WHERE ${scope}`, [sourceId, slug]))[0]?.n ?? 0);
  const out = rows.map(r => {
    const evidence = (typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence) as Array<{ slug: string; line: number; kind: string }>;
    return { owner: r.owner_name, descriptors: r.descriptors ?? [], from: r.f, to: r.t, start_known: r.start_known,
      evidence: evidence.map(e => ({ slug: e.slug, line: e.line, kind: e.kind })) };
  });
  const last = rows[rows.length - 1];
  const more = last != null && Number(last.remaining) > rows.length;
  return { rows: out, total, cursor: more ? encodeKnownAsCursor([last.d, last.owner_key, last.group_key, last.e]) : null };
}

export async function readKnownAs(engine: BrainEngine, sourceId: string, slug: string,
  opts: { excludePrivate: boolean; surfaceCeiling?: string }): Promise<{ known_as?: KnownAs }> {
  try {
    const page = await readKnownAsPage(engine, sourceId, slug, { excludePrivate: opts.excludePrivate, limit: KNOWN_AS_MAX });
    if (!page.rows.length) return {};
    const next: KnownAsNext | undefined = page.rows.length < page.total && page.cursor ? {
      tool: 'get_backlinks', arguments: { slug, source_id: sourceId, group: 'known_as', limit: PAGE_DEFAULT_LIMIT, cursor: page.cursor },
      ...(opts.surfaceCeiling === 'verbs' ? { requires_surface: 'starter' as const } : {}),
    } : undefined;
    return { known_as: { rows: page.rows, total: page.total, ...(next ? { next } : {}) } };
  } catch {
    return {};
  }
}
