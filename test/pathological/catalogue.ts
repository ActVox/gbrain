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
  'backfill.rows': { file: 'test/pathological/a47-backfill-poison-row.test.ts',
    item: 'item: a row whose UPDATE violates a CHECK is skipped, recorded and passed; its siblings land',
    run: 'run: a run-scoped failure (' },
  'purge.recorded_tombstones': { file: 'test/pathological/a49-unmanaged-purge-tombstones.test.ts',
    item: 'item: a tombstone whose delete is refused is reported and kept; the other tombstones and the bulk delete still purge',
    run: 'run: a run-scoped failure (' },
  'retention.expired_sources': { file: 'test/pathological/a50-unmanaged-expired-sources.test.ts',
    item: 'item: a source whose delete times out is blocked with its code and the manual purge; the other expired sources purge',
    run: 'run: a run-scoped failure (' },
};
