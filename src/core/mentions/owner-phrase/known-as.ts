/**
 * The entity card's `known_as` rows: each owner of an account with the
 * validity window of its owner phrase ("<owner>'s <descriptor> account"),
 * read from `owner_phrase_windows`. Bounded at KNOWN_AS_MAX rows with the
 * total. Untrusted readers never see a window whose evidence includes a
 * private page. Owner phrases are never aliases: they stay out of `aka`,
 * `page_aliases` and search alias fan-out. Fail-soft: a read error returns
 * nothing.
 */

import type { BrainEngine } from '../../engine.ts';

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

export interface KnownAs { rows: KnownAsRow[]; total: number }

export async function readKnownAs(engine: BrainEngine, sourceId: string, slug: string, opts: { excludePrivate: boolean }): Promise<{ known_as?: KnownAs }> {
  try {
    const rows = await engine.executeRaw<{ owner_name: string; descriptors: string[]; f: string | null; t: string | null; start_known: boolean; evidence: unknown; total: number }>(
      `SELECT owner_name, descriptors, valid_from::text AS f, valid_to::text AS t, start_known, evidence, count(*) OVER ()::int AS total
         FROM owner_phrase_windows
        WHERE source_id = $1 AND (group_key = $2 OR $2 = ANY(account_slugs))${opts.excludePrivate ? ' AND private_page_id IS NULL' : ''}
        ORDER BY valid_from DESC NULLS LAST, owner_name LIMIT $3`, [sourceId, slug, KNOWN_AS_MAX]);
    if (!rows.length) return {};
    return {
      known_as: {
        total: Number(rows[0]!.total),
        rows: rows.map(r => {
          const evidence = (typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence) as Array<{ slug: string; line: number; kind: string }>;
          return { owner: r.owner_name, descriptors: r.descriptors ?? [], from: r.f, to: r.t, start_known: r.start_known,
            evidence: evidence.map(e => ({ slug: e.slug, line: e.line, kind: e.kind })) };
        }),
      },
    };
  } catch {
    return {};
  }
}
