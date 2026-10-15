# Wave 18b lane 2: shared-file manifest

Every edit to a shared registry, golden or generated file in this lane, for the
integrator. All are appends or regenerations; no existing assertion was weakened.

| File | Edit | Why |
|---|---|---|
| `src/core/config.ts` | +1 `KNOWN_CONFIG_KEYS` row `search.keyword_timeout_negative_cache_seconds` | 2.2 config key |
| `test/config-search-registry.test.ts` | +1 `DIRECTLY_READ_SINGLETONS` row for the same key | registry test requires every registered `search.*` key to name its reader |
| `src/commands/config/keyword-timeout-value.ts` | new branch in `refuseInvalidKeywordTimeoutValue` for the new key | `config set` validator (no `src/commands/config.ts` edit; the existing `search.` hook routes to it) |
| `src/core/error-registry.ts` | +1 `CODES` entry `keyword_skipped_after_timeout`; +1 `NOTICE_CODES` entry `facts_calibration_unmeasured` | 2.2 skip code, 2.3 notice |
| `docs/guides/error-codes.md` | regenerated (`bun run build:error-codes`) | so this lane's `verify` passes; integrator regenerates once after merging |
| `src/core/types.ts` | +1 `DEGRADED_REASONS` member `skipped_after_timeout`; +1 `SearchOpts.keywordTimeoutCache`; one doc line on `useCache` | 2.2 |
| `src/core/interop-notices.ts` | `degradedRecallNotice` names `keyword_arm_failed: skipped_after_timeout` with its own why and the `doctor --only keyword_plan` fix | 2.2 reason registered with why/fix |
| `scripts/module-size-limits.tsv` | ceilings: `postgres-engine.ts` 3060 -> 3063, `types.ts` 2315 -> 2319, `config.ts` 1979 -> 1980 (notes appended) | façade growth for 2.2 |
| `test/postgres-unit-arms.txt` | +1 row `test/keyword-timeout-negative-cache-6495.test.ts` | its DATABASE_URL-gated arm runs in a Postgres lane (`check:postgres-lanes`) |
| `llms-full.txt` | regenerated (`bun run build:llms`; it inlines `docs/guides/troubleshooting.md`) | so `check:regen-all` passes; integrator regenerates once after merging |
| `test/fixtures/goldens/exports/types.json` | regenerated | `DEGRADED_REASONS`/`DegradedReason`, `SearchOpts.keywordTimeoutCache`, `PostgresEngine` private `keywordTimeouts` |
| `test/fixtures/goldens/doctor/json-postgres-fresh.json`, `test/fixtures/goldens/doctor/hot-checks-postgres-json.json` | regenerated on Postgres | `keyword_plan.details.negative_cache` (only diff) |

Not touched: doctor `registry.ts`, `doctor-categories.ts` (no new check), `run-verify-parallel.sh` (the 2.1 call-site guard is a unit test, not a verify script), `registry-build-checks.json`, `llms.txt` (unchanged by the regeneration), CHANGELOG, `BEHAVIOR_CHANGES`, VERSION.

Docs edited (not registries): `docs/guides/troubleshooting.md`, `docs/mcp/TOOL_REFERENCE.md`, `docs/protocol/MEMORY_VERBS_v1.md`, `docs/architecture/key-files/engines-2.md`, `docs/architecture/key-files/graph-and-facts.md`.
