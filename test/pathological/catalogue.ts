/**
 * The pathological catalogue (GBRA-130): for every per-item site in
 * src/core/item-failure.ts ISOLATE_SITES, the test file and the titles of its
 * item case (the bad item is held and the unit continues) and its run case (a
 * run-scoped failure at the same site still stops the unit and holds nothing).
 * The `Record<IsolateSite, …>` type makes a site without cases a compile error;
 * ./sites.test.ts checks that each named file holds each named title.
 */
import type { IsolateSite } from '../../src/core/item-failure.ts';

export interface SiteCases {
  /** Repo-relative test file. */
  file: string;
  /** Title (substring) of the case where one bad item is held and the rest continue. */
  item: string;
  /** Title (substring) of the case where a run-scoped failure stops the unit. */
  run: string;
}

export const CATALOGUE: Record<IsolateSite, SiteCases> = {
  'repair.apply_items': { file: 'test/pathological/a9-repair-core.test.ts', item: 'item case: an item whose apply throws', run: 'run case: a run-scoped' },
  'repair.all_kinds': { file: 'test/pathological/a45-repair-all-kinds.test.ts', item: 'item case: a kind whose plan throws', run: 'run case: a run-scoped' },
  'repair.content_lane_kinds': { file: 'test/pathological/a46-content-lane-kinds.test.ts', item: 'item case: fences throwing is recorded', run: 'run case: a run-scoped' },
};
