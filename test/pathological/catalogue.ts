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
  'autopilot.global_maintenance': {
    file: 'test/pathological/a10-global-maintenance-stamp.test.ts',
    item: 'a phase failing the same way in three passes stops withholding the stamp',
    run: 'a run-scoped failure at the phase loop stops the job and records no streak',
  },
  'synthesize.postprocess': {
    file: 'test/pathological/a4-synthesize-postprocess.test.ts',
    item: 'A-4 item: a carried output whose postprocess request ended revision_conflict',
    run: 'A-4 run: a run-scoped error while reading a carried output stops the pass',
  },
  'synthesize.triage_verdict_cache': {
    file: 'test/pathological/b6-triage-verdict-surrogate.test.ts',
    item: 'B-6 item: a verdict the database refuses is not cached',
    run: 'B-6 run: a run-scoped error writing a verdict stops the pass',
  },
};
