/**
 * Entity references on compact `entity names` rows and record-type
 * enrollment: the one reader for both keys, shared by the names-mode verb and
 * the MCP instruction builder, so the served brief clause names only fields
 * the agent actually receives.
 *
 * - `entity.names_references` (boolean, default on): every found `names` row
 *   (and each identity sibling) carries `referenced_by_count` and a row-level
 *   `next` to the full card (`{tool: 'entity', arguments: {name}}`).
 * - `entity.record_types` (comma-separated page types, default empty): the
 *   page types whose referring pages are listed as `records` on `names` rows,
 *   the full card and `context_pack` cards (verbs/entity-references.ts); a
 *   stored type alias is read as its pack type. Empty means no records.
 *
 * Fail-closed: a read error yields the defaults (names rows on, no records),
 * never a field the agent would not receive.
 */

export const ENTITY_NAMES_REFERENCES_KEY = 'entity.names_references';
export const ENTITY_RECORD_TYPES_KEY = 'entity.record_types';

export interface EntityReferencesConfig {
  namesRow: boolean;
  recordTypes: string[];
}

const OFF_VALUES: ReadonlySet<string> = new Set(['false', 'off', '0', 'no']);

/** Off only for an explicit falsy value; unset or anything else keeps the default (on). */
export function parseNamesReferences(raw: string | null | undefined): boolean {
  return !OFF_VALUES.has((raw ?? '').trim().toLowerCase());
}

/** Comma-separated page types: trimmed, empty entries dropped, first occurrence kept, case preserved. */
export function parseRecordTypes(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map(t => t.trim()).filter(t => t.length > 0))];
}

export async function readEntityReferencesConfig(engine: { getConfig(key: string): Promise<string | null> }): Promise<EntityReferencesConfig> {
  try {
    const [names, types] = await Promise.all([engine.getConfig(ENTITY_NAMES_REFERENCES_KEY), engine.getConfig(ENTITY_RECORD_TYPES_KEY)]);
    return { namesRow: parseNamesReferences(names), recordTypes: parseRecordTypes(types) };
  } catch {
    return { namesRow: true, recordTypes: [] };
  }
}
