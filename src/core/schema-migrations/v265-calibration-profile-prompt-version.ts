import type { Migration } from './types.ts';

export const v265: Migration = {
  // GBRA-177: the pattern-statement prompt version a calibration profile was
  // generated with. calibration_profile skips the paid generate+judge calls
  // when the holder's resolved count, Brier, accuracy, partial rate, model and
  // this prompt version equal the latest stored profile's. Rows written before
  // this column read NULL, which never matches, so the first pass after the
  // upgrade regenerates once. Nullable, no backfill, no index
  // (bootstrap-coverage: column-only). Fresh installs get it from this
  // migration too (not src/schema.sql), so fresh and upgraded brains share
  // calibration_profiles column ordinals.
  version: 265,
  name: 'calibration_profile_prompt_version',
  idempotent: true,
  sql: `
    ALTER TABLE calibration_profiles ADD COLUMN IF NOT EXISTS prompt_version TEXT;
  `,
};
