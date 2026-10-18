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
  'consolidate.buckets': { file: 'test/pathological/a22-consolidate-buckets.test.ts',
    item: 'a private entity page with world facts fails its bucket and later buckets still consolidate',
    run: 'a run-scoped error inside a bucket still stops consolidate' },
  'extract_facts.expire_deleted': { file: 'test/pathological/a21-facts-expire-deleted.test.ts',
    item: 'a refused deleted-page expiry is reported and the other pages still expire and reconcile',
    run: 'a run-scoped error during a deleted-page expiry still stops extract_facts' },
  'maintain.cycle_sources': { file: 'test/pathological/a41-maintain-sources.test.ts',
    item: 'a source whose cycle throws is blocked with its code and the next source still cycles',
    run: "a run-scoped error in one source's cycle still stops maintain" },
  'patterns.ground_pages': { file: 'test/pathological/a23-patterns-grounding.test.ts',
    item: 'a refused leftover pattern page is reported, the new page grounds and the watermark is stamped',
    run: 'a run-scoped error while grounding a page still fails the phase' },
  'patterns.ground_timeline_appends': { file: 'test/pathological/a23-patterns-grounding.test.ts',
    item: 'a refused timeline-append page is recorded and the other page still grounds',
    run: 'a run-scoped error while grounding timeline appends still stops grounding' },
};
