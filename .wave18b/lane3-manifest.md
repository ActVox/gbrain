# Wave 18b lane 3: shared-file manifest

Branch `capy/w18b-lane3`. These are the edits to files other lanes may also touch. The integrator merges these entries into the shared registries and regenerates the generated docs once after merging.

## Registries and generated files

- `src/core/error-registry.ts`: three new codes:
  - `embedding_identity_unqualified` (class `consent`, docs `troubleshooting.md#embedding-identity-unqualified`), 3.4
  - `patterns_min_interval` (class `consent`, fix `gbrain dream --phase patterns` with paid consent, docs `dream-patterns.md#cadence`), 3.2
  - `read_budget_exhausted` (class `caller`, docs `dream-patterns.md#child-read-budget`), 3.2
  - 3.3 reuses the existing `preview_changed` and `invalid_params`.
- `docs/guides/error-codes.md`: regenerated (`bun run build:error-codes`) with the three codes above. The integrator regenerates again after merging.
- `src/commands/doctor/registry.ts`: `embeddingIdentityEntry` registered right after `embeddingEnvOverrideEntry`.
- `src/core/doctor-categories.ts`: category for `embedding_identity_unqualified`.
- Doctor goldens: `test/fixtures/goldens/doctor/json-pglite-degraded.json`, `json-pglite-fresh.json`, `registry-build-checks.json` gain the new check (`GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/doctor-registry-golden.test.ts test/doctor-json-golden.test.ts`).
- `test/fixtures/goldens/trust/help.txt`: the `--repair-unknown-markers` usage block.
- `scripts/serial-files.tsv`: three R2 rows (mock.module): `test/cycle-patterns-timeline-appends.serial.test.ts`, `test/cycle-patterns-cadence.serial.test.ts`, `test/cycle-patterns-read-budget.serial.test.ts`.
- `src/core/config.ts`: known config keys gain `dream.patterns.min_interval_hours` and `dream.patterns.child_read_budget_kb` (one line).
- `scripts/module-size-limits.tsv`: ceiling bumps for `src/core/config.ts` (+1) and `src/core/cycle.ts` (+2).
- `TODOS.md`: the #6113 P2 free-relabel line now says the doctor check ships and the relabel stays parked.

## Docs edits that may collide

- `docs/architecture/key-files/core-cycle-continued.md` (patterns.ts entry), `core-minions-2.md` (brain-allowlist entry + new read-budget.ts entry), `security.md` (new marker-repair.ts entry), `commands-2-continued.md` (embedding-identity check entry).
- `docs/guides/troubleshooting.md` (`#embedding-identity-unqualified`), `docs/guides/memory-trust.md` (`## Repair unknown markers`), `docs/guides/dream-patterns.md` (settings rows, `## Cadence`, `## Child read budget`, `## Timeline appends`, changelog bullets), `docs/guides/facts-relink.md` (CJK section), `docs/mcp/TOOL_REFERENCE.md` (`appended_unverified` deprecation note).

## Existing-test change

- `test/cycle-patterns-evidence-gate.serial.test.ts`: `beforeEach` sets `dream.patterns.min_interval_hours` to `0`, so the evidence-watermark tests keep testing only the watermark and the new 6 h cadence doesn't mask it. No assertion changed.

## Related TODO the integrator may update

- `TODOS.md` P3 "Transcript budget for dream patterns children (#6236)": 3.2 builds the per-job `get_page` read budget in the subagent tool wrapper (`src/core/minions/tools/read-budget.ts`). A whole-transcript budget is still not built, so lane 3 left the entry open.
