/**
 * #7013: atoms a managed re-extraction retired that `gbrain repair atoms-restore` can bring back, as one SQL
 * predicate shared by the repair (preview, apply recheck and coordinated preparer), the
 * `atom_retirements_restorable` doctor check and the purge hold. Static strings over a `pages` alias only, so
 * `engine-sql/pages.ts` may import it.
 *
 * A page `a` is restorable when every part holds:
 *   - `reextractRetiredAtomSql`: a soft-deleted, non-imported atom stamped `retired_by: managed-reextract`;
 *   - `atomOriginLiveSql`: its origin is a live page of the same source (`source_slug`), or a transcript
 *     (`source_path`, whose file SQL cannot check);
 *   - `atomReplacedSql` is false: no live, non-imported atom of the same source and origin carries a different
 *     source hash (a `pending:` prefix stripped), so no later generation replaced it;
 *   - `atomLatestGenerationSql`: its hash is the hash of the origin's most recently retired `managed-reextract`
 *     atom, so an older generation that a later extraction replaced is never revived.
 *
 * The purge (engine bulk delete and preview, the belief-ledger expiry, the managed selection) holds a restorable
 * atom for `ATOM_RESTORE_HOLD_DAYS` after its `deleted_at`; an explicit `gbrain delete --purge` is not held.
 */

/** The stamp `prepareManagedAtomMutation` writes on a re-extraction retirement (`ATOM_RETIRED_BY_REEXTRACT`). */
export const ATOM_REEXTRACT_RETIRED_BY = 'managed-reextract';

/** Days after `deleted_at` that the purge keeps a restorable atom. */
export const ATOM_RESTORE_HOLD_DAYS = 30;

const strippedHash = (alias: string) => `regexp_replace(COALESCE(${alias}.frontmatter->>'source_hash',''),'^pending:','')`;

/** `other` is bound to the same origin as `alias`: the same `source_slug`, or for a transcript atom the same `source_path`. */
const sameOrigin = (other: string, alias: string) => `((NULLIF(${alias}.frontmatter->>'source_slug','') IS NOT NULL
      AND ${other}.frontmatter @> jsonb_build_object('source_slug',${alias}.frontmatter->'source_slug'))
    OR (NULLIF(${alias}.frontmatter->>'source_slug','') IS NULL
      AND ${other}.frontmatter @> jsonb_build_object('source_path',${alias}.frontmatter->'source_path')))`;

export function reextractRetiredAtomSql(alias: string): string {
  return `(${alias}.type='atom' AND ${alias}.deleted_at IS NOT NULL
    AND ${alias}.frontmatter->>'retired_by'='${ATOM_REEXTRACT_RETIRED_BY}'
    AND NULLIF(${alias}.frontmatter->>'imported_from','') IS NULL)`;
}

export function atomOriginLiveSql(alias: string): string {
  return `((NULLIF(${alias}.frontmatter->>'source_slug','') IS NOT NULL AND EXISTS (SELECT 1 FROM pages ao
      WHERE ao.source_id=${alias}.source_id AND ao.slug=${alias}.frontmatter->>'source_slug' AND ao.deleted_at IS NULL))
    OR (NULLIF(${alias}.frontmatter->>'source_slug','') IS NULL AND NULLIF(${alias}.frontmatter->>'source_path','') IS NOT NULL))`;
}

export function atomReplacedSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM pages ar WHERE ar.source_id=${alias}.source_id AND ar.type='atom' AND ar.deleted_at IS NULL
      AND NULLIF(ar.frontmatter->>'imported_from','') IS NULL AND ${sameOrigin('ar', alias)}
      AND ${strippedHash('ar')}<>${strippedHash(alias)})`;
}

export function atomLatestGenerationSql(alias: string): string {
  return `${strippedHash(alias)}=(SELECT ${strippedHash('ag')} FROM pages ag WHERE ag.source_id=${alias}.source_id AND ag.type='atom'
      AND ag.deleted_at IS NOT NULL AND ag.frontmatter @> jsonb_build_object('retired_by','${ATOM_REEXTRACT_RETIRED_BY}')
      AND NULLIF(ag.frontmatter->>'imported_from','') IS NULL AND ${sameOrigin('ag', alias)}
      ORDER BY ag.frontmatter->>'retired_at' DESC NULLS LAST, ag.id DESC LIMIT 1)`;
}

/** SQL: the page aliased `alias` is an atom `gbrain repair atoms-restore` restores. */
export function restorableAtomRetirementSql(alias: string): string {
  return `(${reextractRetiredAtomSql(alias)} AND ${atomOriginLiveSql(alias)} AND NOT ${atomReplacedSql(alias)} AND ${atomLatestGenerationSql(alias)})`;
}

/** SQL predicate for a purge scan over `pages` aliased `alias`: the page is not a restorable atom inside its hold. */
export function atomRetirementPurgeHold(alias: string): string {
  return `NOT (${alias}.deleted_at > now() - interval '${ATOM_RESTORE_HOLD_DAYS} days' AND ${restorableAtomRetirementSql(alias)})`;
}
