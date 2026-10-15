# Wave 18b lane 5: shared-file manifest

Every edit this lane made to a shared registry, generated file or ratchet.
Each is a minimal append; resolve merge conflicts by keeping every lane's rows.

| File | Edit |
|---|---|
| `src/core/config.ts` | One `KNOWN_CONFIG_KEYS` row: `loops.updates_require_reciprocity` (with a one-line comment). Validator lives in `src/core/google/loops-reciprocity.ts`, wired in `src/commands/config/loops-values.ts`. |
| `src/core/error-registry.ts` | One entry: `calendar_unreadable` (class `caller`, docs `docs/guides/google-connect.md#unreadable-calendar`, fix argv `gbrain google calendars --json`, verify `gbrain doctor --only google_calendar_readable --json`). |
| `docs/guides/error-codes.md` | Regenerated with `bun run build:error-codes` after the registry append. Regenerate again after merging other lanes' codes. |
| `src/core/doctor-categories.ts` | `google_calendar_readable` appended to the `ops` category. |
| `src/commands/doctor/wave-checks.ts` | One check registration: `google_calendar_readable` (resolution `operator`, registration `wave`, hostOnly). |
| `src/commands/doctor/checks/graph-health.ts` | `google_calendar_readable` appended to the `timelineHistoryEntry` emits list. |
| `test/fixtures/goldens/doctor/registry-build-checks.json` | One golden row `{ category: ops, name: google_calendar_readable }`. |
| `src/core/operation-manifest.generated.ts` | Regenerated (`bun run scripts/build-operation-manifest.ts`) for the new `loops_mute` / `loops_unmute` / `open_loops` descriptions. Regenerate after merging other lanes' op changes. |
| `llms.txt`, `llms-full.txt` | NOT regenerated (integrator's job): `bun run verify` reports them stale from this lane's doc edits; `bun run regen:all` fixes it. |
| `scripts/module-size-limits.tsv` | `src/core/config.ts` 1979 → 1981; `src/commands/config.ts` 1508 → 1509 (each note names lane 5). `src/commands/sources.ts` stays under its existing 2059 ceiling (2052 lines). |
| `src/commands/sources.ts` | `case 'set-calendar'` dispatch and one help row; `runSetCrMode` prints the contextual-mode hint. |
| `skills/google-loops/SKILL.md` → `skills/skills.lock.json`, `plugin/skills/google-loops/SKILL.md` | Runbook lines for mute/unmute/drop sender and `withheld_noise`; lock and plugin tree regenerated (`bun run scripts/generate-skills-manifest.ts`, `bun run scripts/generate-plugin-tree.ts --out plugin --variants-out plugin-variants`). Regenerate after merging if another lane edits skills. |
| `docs/architecture/key-files/{open-loops-engine,google-and-loops,google-and-loops-continued,commands-1,commands-5}.md` | Bullets updated; new bullets for `loops-reciprocity.ts`, `google-calendar-status.ts`, `sources-set-calendar.ts`, `doctor/checks/google-calendar.ts`, `config/contextual-mode-hint.ts`. `google-and-loops-continued.md` is at 59,769 of its 60,000-byte cap. |

Not touched: VERSION, CHANGELOG, `BEHAVIOR_CHANGES` (rows are in `lane5-release-notes.md`), `llms*.txt`, any `persistence/sync*` file.

Connector state additions (no migration): `GoogleSourceState.loop_withheld_senders`, `loop_automated_backfill_done`, `calendar_unreadable`, published by `loopRecoveryState` in `google-source.ts` on partial managed runs. `open_loops.closed_by` gains the values `muted`, `mute_recheck`, `unmuted` (free text column; no schema change).
