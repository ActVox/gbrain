# Wave 18 lane 1, S1 fragment rows (wave 18a; integrator: apply, then delete this file)

Branch `capy/wave18-lane1-s1` (from `cadaf5cd7`) carries only the S1 items, #6757 and #6782. Its last
commit, `INTEGRATOR-ROW: ...`, holds the regenerated output this slice needs; redo it at slot time after
renumbering. The S2 rows are in `lane1.md` on `capy/wave18-lane1`, which merges this branch.

## Slot-time steps

1. [S1] **Migration number (#6757).** `src/core/schema-migrations/v250-persistence-request-id-index.ts`
   (name `persistence_request_id_index`) uses v250 provisionally. Renumber to the next free version at slot
   time (file name and `version` field; `test/migration-persistence-request-id-index.test.ts` imports it by
   path and compares its version against the slug-intent migration, not a literal), then run
   `bun run build:schema-migrations && bun run build:schema`.
2. [S1] **Generated files (#6757).** `src/core/schema-migrations/registry.generated.ts`,
   `src/core/schema-migrations/latest.generated.ts`, `src/core/pglite-schema.generated.ts` (step 1 regenerates
   them; the INTEGRATOR-ROW commit carries v250). `llms-full.txt` changes with docs/guides/cron-schedule.md
   (#6782 docs): `bun run regen:all`.
3. [S1] **Goldens (#6757).** The new index and the `persistence_request_indexes` wording ("Request-table
   indexes are valid.") change these; regenerate after renumbering:
   - `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/doctor-content-golden.test.ts test/doctor-hot-checks-golden.test.ts test/doctor-json-golden.test.ts test/migrations-golden.test.ts test/schema-catalog-golden.test.ts test/pglite-upgrade-replay.test.ts`
   - `GBRAIN_TEST_UPDATE_GOLDENS=1 DATABASE_URL=<test db> bun test --timeout=60000 test/e2e/schema-catalog-golden.test.ts test/e2e/doctor-json-golden.test.ts test/e2e/doctor-hot-checks-golden.test.ts`

## BEHAVIOR_CHANGES rows (`src/core/behavior-change-notice.ts`, `since: '<18a version>'`)

- [S1] **#6757:** "Dream synthesis postprocess finds committed outputs by request id through a new online index (`persistence_requests_request_id`, built concurrently on Postgres, covered by `gbrain repair request-indexes`). A statement timeout on that read now defers the postprocess to a later pass (kept in `dream.synthesize.postprocess_pending`, finished without another synthesis call) instead of failing the pass (the replay runs no child job and verifies the output's quotes against the current transcript; a quote not found goes to `unverified_claims`); three deferrals in a row add a line to doctor `persistence_request_indexes`, whose messages now say \"request-table indexes\"."
- [S1] **#6782:** "`propose_takes` now treats a reply of `[]` followed by prose as an empty extraction and tombstones the page, instead of retrying the paid call every cycle. Pages that were retried forever get a tombstone on their next run. There is no per-page force flag: the tombstone is keyed by a hash of the page body, so any edit to the body re-extracts the page (docs/guides/cron-schedule.md)."

## Notes

- `test/persistence-connector-fencing.test.ts` now orders its request-id reads: the new index is a valid
  plan for `WHERE source_id=$1` and changed the unordered row order on CI.
- No registry (error-registry, FACTS_ABSORB_REASONS, repair registry) rows are needed for S1.
