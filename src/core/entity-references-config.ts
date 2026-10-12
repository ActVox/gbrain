/**
 * Config for the reference fields on compact entity rows (`entity names`,
 * `context_pack` cards) and the record view they carry.
 *
 * - `entity.names_references` (default on): every found `entity names` row
 *   (and each identity sibling) carries `referenced_by_count` and a row-level
 *   `next` to the full card. `false` leaves the rows as before.
 * - `entity.record_types` (default empty): the canonical page types that
 *   count as records (contracts, amendments, orders, …). When it names a type,
 *   rows list those referring pages under `records`, newest page date first;
 *   empty leaves records off. A stored type alias is read as its pack type.
 *
 * Fail-closed: a read error keeps the defaults (names rows on, records off).
 */
import type { BrainEngine } from './engine.ts';
import { isConfigTruthy } from './config.ts';
import { parseNameList } from './mentions/policy.ts';

export const ENTITY_NAMES_REFERENCES_KEY = 'entity.names_references';
export const ENTITY_RECORD_TYPES_KEY = 'entity.record_types';

export interface EntityReferencesConfig {
  namesRow: boolean;
  recordTypes: string[];
}

export async function readEntityReferencesConfig(engine: Pick<BrainEngine, 'getConfig'>): Promise<EntityReferencesConfig> {
  try {
    const [names, types] = await Promise.all([engine.getConfig(ENTITY_NAMES_REFERENCES_KEY), engine.getConfig(ENTITY_RECORD_TYPES_KEY)]);
    const namesRow = names === null || names === undefined || String(names).trim() === '' ? true : isConfigTruthy(names);
    return { namesRow, recordTypes: [...new Set(parseNameList(types))] };
  } catch {
    return { namesRow: true, recordTypes: [] };
  }
}
