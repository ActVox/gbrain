# Changelog

All notable changes to GBrain will be documented in this file.

Historical entries use generic identifiers for the retired hosted provider
and its removed commands.
Those identifiers and any sample command containing them are non-executable
archival labels, not supported configuration. Dates, measurements and contributor
credits are retained; no result has been reassigned to another provider. Original
identifiers and attribution are available in the pre-removal Git revision
`6040075c6cb95be5881cc2e1b76ef7d71f4e5d29` (retained on 2026-09-23).

## [0.60.267.0] - 2026-10-16

**You can ask the brain what a page said at an earlier moment, as the brain knew it then, and it tells you when it can't know.** With the belief ledger on, `get_page` and `get_versions` take `known_as_of`, an exact instant. The answer is the page as the brain had recorded it at that instant: which version was current, whether it was deleted, and how long it stayed that way. When the brain can't vouch for the answer, it says so. The ledger may not have been on yet at that instant, it may not have been recording, or a write may still have been in flight. In those cases you get a refusal with a reason instead of a guess. Purged content never comes back through a past read. A rename and a fact purge now keep the page as it stood before the change, so the history has no holes. A sync stuck behind a recovery only you can fix now stops at once and names the file.

### How to use it

```bash
gbrain beliefs status --source <id> --json   # what the ledger covers
```

Through MCP or the CLI op surface:

- `get_page {slug, known_as_of: "2026-10-01T12:00:00Z"}`: the page as recorded at that instant, with `certified` and the interval it was in.
- `get_versions {slug, known_as_of, diff: true}`: every interval recorded by that instant, newest first, each with a unified diff from the one before.

`known_as_of` is recorded time (when the brain knew it). It is not `as_of` on `get_links`, which is valid time (when it was true in the world, as a date).

### What you'd see

| You ask about | Before | Now |
|---|---|---|
| a page at an instant the ledger covers | no way to ask | the page as recorded then, its revision, whether it was deleted, `recorded_at` and `until`, and `certified` |
| an instant before the ledger was on for the source | n/a | `coverage_from`: earlier times are unknown, not empty |
| an instant while coverage was stopped, or across a backup restore | n/a | `coverage_gap` with the gap's bounds |
| an instant when a write to the page was recorded but not yet provably committed | n/a | `known_as_of_unproven` (retryable), naming the write |
| `known_as_of: "2026-10-01"` | n/a | `clock_mismatch`: a date is valid time; pass an instant |
| a page whose body was later purged | n/a | the interval with `body: unavailable`, `body_reason: purged`; the purged text never returns |
| a body no retained version holds | n/a | `body: unavailable` with its reason; never the neighboring version's body |
| a remote client asking about a page it can't see | n/a | `page_not_found`, the same as for a slug that was never written |
| a page rename or a `purge_fact` rewrite | no version kept the page as it stood before | one more version per rename and per page a fact purge rewrites (the purged claim is stripped from it) |
| a sync queued behind a recovery waiting on you (a page file edited mid-publish) | waited out the 5-minute no-progress window | stops after one governor tick with `drain_stalled`, `cause: head_blocked`, naming the file and the fix |

### Things to watch

- `get_versions` and `gbrain history` list one more snapshot per page rename and per page a `purge_fact` rewrites.
- History is certified only on managed sources. On other sources a read answers with `certified: false` and an `uncertified_reason`.
- Doctor `belief_ledger_coverage` now warns when a page moved to a new revision without a version of the one it left. Such a body shows as `version_missing` in a past read and can't be recovered. `--tier deep` lists every case beyond the last 30 days.
- Scripts that match `drain_stalled` should expect `cause: head_blocked` sooner on a recovery that needs a person.

### Itemized changes

#### Recorded-time reads

- `src/core/belief/page-at-time.ts`: the page-at-time reader. It finds the interval an instant falls in from the ledger's page events, checks coverage (`coverage_from`, `coverage_gap`) and the commit proof (`known_as_of_unproven`), resolves the body (`live`, `version`, `segmented` through `body_ref`, or `unavailable` with `purged`, `expired`, `hard_deleted`, `pruned` or `version_missing`), and collapses a purged lifetime's intervals.
- `src/core/ops/known-as-of.ts`: `get_page {known_as_of}` and `get_versions {known_as_of, diff}` (`src/core/ops/pages.ts`, `src/core/ops/admin.ts`). `diff` and `source_id` on `get_versions` need `known_as_of`. For a remote caller, the source lookup counts only pages it can see now, and a coverage or proof refusal about a page it cannot see becomes `page_not_found`.
- New error codes `coverage_from`, `coverage_gap`, `clock_mismatch` and `known_as_of_unproven` (`src/core/error-registry.ts`, `src/core/error-catalogue.ts`), documented in `docs/guides/repair.md#recorded-time-reads`.

#### History without holes

- `updateSlug` (`src/core/engine-sql/pages.ts`) saves a version of the page before the rename.
- `purge_fact` (`src/core/facts/purge.ts`) saves a version of each page before rewriting it; version redaction then removes the purged claim from that version too.
- `src/core/belief/preimages.ts`: every publication that moves a page's revision must leave a version of the revision it moved off. Test runs enforce it in `finalizeBeliefEvents`. Doctor `belief_ledger_coverage` reports violations from the last 30 days (all of them under `--tier deep`).
- `docs/designs/BELIEF_LEDGER.md` section 14 records the page-at-time rules.

#### Sync behind a recovery that needs you

- `src/core/persistence/head-blocker.ts`, `sync-drain.ts`: a sync queued behind a fact-withdrawal mirror or page write whose file was edited while it was publishing stops after one governor tick with `drain_stalled`, `cause: head_blocked`, naming the file. A recovery that can still finish keeps the wait. A recovery stuck on `unexpected_staging_bytes` still waits out the window.

## [0.60.266.0] - 2026-10-16

**Managed sync tells the truth about where it stands, and every held file has a way out (#6712 PR 2).** A managed `gbrain sync` returns `synced` the moment its checkpoint commits: link extraction and planner statistics run after the drain lease is released, and a crash between the two is made up by the next sync. `gbrain sync status` stays fast on large brains and never reads a timed-out probe as "nothing pending". Each of the 14 hold codes now leads an agent to a cleared hold or to one decision sentence for the user, and a hold asks a person only after its safe action failed three times over at least a day. Every `gbrain sync` flag lives in one table, and the `sync.*` config keys are split into tunables, rollback keys and retired keys (five retired keys become `GBRAIN_SYNC_*` environment variables, and doctor names any stored value that stopped applying).

### What you'd see

| Situation | Before | Now |
|---|---|---|
| a managed sync's checkpoint commits, then link extraction runs for minutes | the drain lease and the governed pass stayed held through the tail | the run returns `synced` at the commit; the tail runs after the lease is released, bounded, and a second sync can take the lease at once |
| the process dies between the checkpoint commit and the tail | statistics and links for that run were never redone | the checkpoint recorded the tail as owed; the next sync of the source runs it |
| the tail fails, is cut short or the deadline left no time | silent | the run stays `synced` with one `[gbrain notice sync_tail_degraded]` and its fix (`gbrain extract --stale --source-id <id>`, or doctor for statistics); `sync --all` prints it per source and puts `tail` and `notices` in each source's JSON entry |
| a pass admits nothing with no unfinished request | `drain_stalled` / `no_admission`, a pooler warning, and a delegated run's one-time fallback | `drain_stalled` / `no_progress` with the same step and statement; `no_admission` is a retired reason |
| `gbrain sync status` on a large brain | every heavy read on every call | a plain status skips the terminal summary, blocker list and cursor join (`*_read: not_read`, fix `--detail`); `state`, `reason` and bounded oldest-blocker / recovery probes always run (an unfinished write is `resumable` / `request_pending`, never synced); under 30 ms on a 61k-request fixture |
| a short-lived command (`put`, `remember`, `import`) runs while a managed sync drains its source | its consumer could claim and publish the drainer's page requests whenever a lane group backed off | only the drain lease holder publishes them; the command's own write still passes the queued sync rows that do not name its page, and with no live lease nothing changes |
| a status whose probe timed out | could read as nothing pending | `state: resumable`, `reason: status_unknown`, never `synced` |
| a hold, `last_error`, a receipt, `managedWrite` or doctor `sync_failures` | internal codes only | `public_category` (drift, conflict, content_refused, file_missing, permission, storage, config, superseded, transient, defect) beside the unchanged `category` |
| a managed-sync file `write_gate.external_mode=reject` refuses | its receipt failed at preparation and the whole source stopped `blocked_by_failures` | the file is held `write_gate_rejected` (needs a person) and the rest syncs |
| `sync status` shows a `purged_content` or `write_gate_rejected` hold | `Unknown code` (systemic, needs a person) | a page hold with its own sentence (unpurge or edit; switch the gate or edit) |
| you exclude a held file with `sync.exclude` (its printed fix), or multimodal is off for a held image | the hold stayed until some unrelated commit | the next `gbrain sync` releases it, even with nothing new committed |
| you switch `write_gate.external_mode` or `junk_disposition` back, add `gbrain trust allow` for the file, or `gbrain pages unpurge` its content | n/a | the next `gbrain sync` re-screens the held file and imports it |
| a hold is re-held three times within an hour | `needs_human` | still the agent's: `needs_human` needs 3 failed attempts and 24 h since it was first held; a file still being edited (`worktree_dirty`) and an image never escalate |
| `unblock --apply` finds a dirty file still uncommitted, or a repair holds the file again | not counted | counts as a failed attempt toward that rule |
| a `worktree_dirty` edit nobody touched for a day | n/a | `needs_human`: the fix (`sync unblock --apply` behind `ask_user`) runs once the person commits or restores the file; new bytes in the file hand it back to the agent |
| a `source_changed` receipt (`sources writer failures`, `write-request`) | `sources reconcile … --preview` for every reason | by recorded reason: two-sided drift → `repair file-drift --slug … --prefer database`; missing file → `repair ghost-pages`; admission race → retry; binding or unsafe target → writer status |
| many drift receipts | one command per page | `repair file-drift --all-drifted --since <oldest receipt instant>` |
| `gbrain repair file-drift --since 7d` | unknown flag | narrows `--all-drifted` to recent drift; the preview and apply carry one concrete instant |
| a managed sync with live pages whose files are gone | silent | `[sync] N live page(s) … have no canonical file`, with the `repair ghost-pages` preview; sync never deletes them |
| a parked cursor with a non-empty queue and no consumer (#6552) | doctor listed it as parked (info) | doctor `managed_sync_not_moving` fails with the resume sync as its fix |
| `gbrain doctor --json` | no intervention counts | `sync_soak_counters`: interventions and content decisions per day for 7 days |
| `gbrain config set sync.hold_cap 200` | Stored and applied | Warns that the key is retired, names `GBRAIN_SYNC_HOLD_CAP`, writes nothing (exit 0) |
| A brain with `sync.parser_regression=hold` stored | Holds the file | Stops with `sync_parser_regression` until `GBRAIN_SYNC_PARSER_REGRESSION=hold` is set; `gbrain doctor --only sync_config_keys` reports the stored value as unapplied |
| `gbrain config get sync.bulk` with nothing stored | `Config key not found` (exit 1) | `true`, with `default: sync.bulk is a rollback key ...` on stderr |
| `gbrain config set sync.foreground_priority false` | Refused as an unknown key without `--force` | Written, with a note that it is a rollback key honored until at least 2027-01-14 |
| `gbrain sync --no-lanes` while a PGLite serve holds the brain | `Unsupported owner-delegated sync option: --no-lanes` | Runs (PGLite publishes without lanes, so the flag is accepted and not sent) |
| An older sync CLI sends `explicitProcessing` to a newer serve | Silently dropped | Dropped, with one `[gbrain notice]` naming the field and its window in the serve log and the delegated run's progress lines |

### Itemized changes

#### Truthful receipts and fast status

- **Post-checkpoint tail** (`src/core/persistence/sync-tail.ts`, `sync-tail-record.ts`): `recordSyncTail` runs inside the checkpoint's publication transaction; `withSyncTail` runs the owed tail after the outermost drain lease is released (`performManagedBranch`, and `performManagedSync` when it took the lease). The failure clear and the retry-held `writer_yield` check stay in the pass. New fault point `sync:tail_started`, added to the convergence kill loop.
- **`no_admission` retired**: the stall cause, its `drainNext` / `formatDrainSummary` branches, the transaction-pooler warning, the governor's `finish` window and the delegated `serve_no_admission` fallback are gone; `drain_stalled` keeps a `retired_reasons` tombstone. `drain-step.ts` stays: it still fences an abandoned pass at its next step and labels the `no_progress` stop.
- **`sync status`** (`sync-status.ts`, `commands/sync/operator.ts`): `state`, `reason` (`SYNC_STATUS_REASONS`), `oldest_blocker`, `recovery`, `checkpoint_blockers_read`, `cursors_read`, `terminal_failures_read`, `--detail`; every existing field keeps its type. One text headline per state; the drain summary says `resumed run <id> and converged` when a drain finishes a run an earlier invocation started.
- **`public_category`** (`public-category.ts`): a total mapping from `classifyTerminal`'s category and the fault code; `classifyRecordedFault` reads holds, failure rows and run stops as the failed receipt they stand for.
- AGENTS.md and the sync-unblock runbook: the operator loop checks `*_read` and never reads a `not_read` field as "none".
- **One publisher per drained source** (`journal.ts` `claimNextWrite`, approved by Garry on 2026-10-16): while a source's drain lease is live, a non-resident consumer skips that source's managed-sync requests held by another process. Resident consumers (`serve`, `sync`, `jobs`, `autopilot`, `mcp`) and the lease holder claim as before. A lease whose same-host holder is provably dead (a killed sync whose TTL has not lapsed) does not count, so a crash leaves nothing waiting on the TTL. Test: `test/claim-lease-holder-only-6712.test.ts`.

#### Hold exits and escalation

- Fault table: `purged_content` and `write_gate_rejected` rows; `source_changed` reasons (`file_database_drift`, `canonical_file_missing`, `pending_import`, `raw_file_changed`, `source_binding_changed`, `unsafe_file_target`) each get their own row. The runbook table is regenerated.
- Hold escalation: `HOLD_ESCALATE_MS` (24 h) beside `HOLD_ATTEMPTS_NEEDS_HUMAN`; holds record `first_held_at`, `edited_at` and `needs_human_at`. Attempt and edit stamps are guarded on the record they read, so they never overwrite a newer hold.
- Doctor `managed_sync_not_moving` ages a stranded queue from its oldest admitted request when the cursor has never moved (`SourceMovement.admitted_since`).
- `src/core/since.ts`: one `--since` parser for `agent logs` and `repair file-drift`.
- `src/core/persistence/sync-ghosts.ts`: the bounded post-sync ghost count (`SyncResult.ghostPages`).
- `src/core/persistence/soak-counters.ts`: the counters and doctor's `sync_soak_counters`.
- Managed sync's freeze screen applies the write gate as preparation does, owner trust allow rules included (`SyncImportScreenInput.writeGateSource`); a discovery with nothing to write releases holds that left the source (`releaseDiscoveredHolds`).

#### Sync flags and config keys

- `src/core/sync-flags.ts` (new): `SYNC_FLAGS`, every sync flag with its route on the serve and owner hand-offs. `WIRE_BOOL_FLAGS`, `VALUE_FLAGS`, `IGNORED_FLAGS`, the managed pick list (`sync-delegate.ts`), `DELEGATED_SYNC_OPTION_FIELDS` (`sync-ipc.ts`), `SYNC_BOOLEAN_FLAGS` and `SYNC_VALUE_FLAGS` (`sync-wire.ts`) are views of it.
- `src/core/wire-skew.ts`: a retired wire field names the hand-offs that accept it and its shape; both validators accept, drop and report it, and the resident prints `retiredWireNotice`. `CONFIG_ROLLBACK_WINDOWS` records each rollback key's window (calendar date plus version floor).
- `src/core/sync-config-keys.ts` (new): `SYNC_TUNABLE_KEYS`, the rollback keys, `RETIRED_SYNC_KEYS` with replacements, `effectiveSyncKey` (for `config get`) and `syncKeySetNotice` (for `config set`).
- Readers: `readSyncHoldPolicy` reads the hold cap, the escalation thresholds and the parser-regression policy from `GBRAIN_SYNC_*`; `resolveBulkSettings` reads only `GBRAIN_SYNC_BULK_MAX_TXN_MS`.
- Doctor: `sync_config_keys` (meta) reports stored retired keys as unapplied and lists stored rollback keys with their windows.
- Help and printed fixes name only live keys: `--no-bulk` help, the `git_held_files` escalation line, the parser-regression hold and stop messages, the `parser_regression` registry entry.
- Docs: `docs/guides/live-sync.md#sync-config-keys`, `docs/guides/repair.md`, `docs/guides/write-refusals.md`, `docs/guides/troubleshooting.md`; migration note `skills/migrations/v0.60.266.0.md`.

### For contributors

- Crash robot: `consumer:prepared` now counts once per write request, like `consumer:preparing`, and both key on the request row (`FaultDetail.writeId`) rather than the shared request id. A prepared request whose publication was requeued used to count twice, so `caller_bound_replay` counted 4 or 5 and a crash at `#5` could go unreached. Keying on the request id would also have collapsed that schedule's rows, which share one id, from 4 to 2. `test/persistence-crash-robot.test.ts` fails under both the old counting and request-id keying.
- Retire a sync config key in `RETIRED_SYNC_KEYS`; `test/error-registry-retired.test.ts` then fails on any source line, help text or registered fix that still names it.
- Tests: `test/sync-flag-table-6712.test.ts`, `test/sync-config-keys-6712.test.ts`, `test/sync-managed-cron-flags-6712.test.ts`.

## [0.60.265.0] - 2026-10-16

**Your brain can now keep a permanent, append-only record of what it believed and when, so a later question like "what did we think about Acme in March?" has a real answer.** Today a page edit overwrites the old facts, takes and links, and the old version is gone unless a backup happens to hold it. This release adds a belief ledger: every time a page's facts, takes, links or timeline change, the change is written as an event, in the same transaction as the write itself, with who wrote it and how much it was trusted. Nothing is recorded until you switch it on for a source, and a brain that never does pays one tiny lookup per write and stores nothing new. Nothing reads the ledger for answers yet; this release lays the record down so the next one can answer from it.

### How to turn it on

```bash
gbrain beliefs enable --source <id>      # baselines every page (resumable), then records each change
gbrain beliefs status                    # coverage, watermark, certified or not, drift, restore gaps
gbrain beliefs backfill --source <id>    # optional: best-effort history from retained page versions
gbrain beliefs disable --source <id>     # stop recording; enabling again starts a new interval
```

On a managed source the record is certified: every write goes through one coordinator, so a missing event shows up as drift. On an unmanaged source it is recorded but never certified. `gbrain doctor` reports coverage as `belief_ledger_coverage` and offers `gbrain beliefs reconcile` when a source drifts.

### What it costs (in-transaction ledger work, 4-core box)

| Write | PGLite | Postgres |
|---|---|---|
| Typical page edit | about 3 ms of 35 to 45 ms (7 to 8%) | about 3 ms of 31 ms (about 10%) |
| Large page edit | about 14 ms of 160 to 175 ms (8 to 9%) | about 14 ms of 120 to 130 ms (11 to 12%) |
| Large page create | about 6% | about 8% |

Bulk work with recording on, 1000 typical pages, end-to-end:

| Run | PGLite off to on | Postgres off to on |
|---|---|---|
| `gbrain import` | 5.7 to 7.1 s | 7.1 to 9.6 s |
| Re-import, every page edited | 6.3 to 7.6 s | 7.4 to 9.4 s |
| Managed sync, new pages | 24.8 to 27.6 s (+11%) | 15.1 to 18.7 s (+24%) |
| Managed sync, every page edited | 29.2 to 32.7 s (+12%) | within noise |
| `gbrain beliefs enable` | 1.2 s | 1.8 s |
| `gbrain beliefs backfill` (two prior versions per page) | 9.7 s | 7.3 s |

### Things to watch

- **Managed sync on Postgres costs about 24% more for new pages** with recording on. That's above where we want it; a follow-up release targets it.
- **Purging a page now locks its whole source while it publishes**, so other writes to that source wait: on a 10,000-page source, a median of 353 ms on Postgres (1.4 s for a very large page) and 1.25 s on PGLite (3.2 s for a very large page).
- **A purge removes a claim from active memory and from the ledger's history, not from every copy.** The ledger keeps an unsalted fingerprint of a purged claim, as purge tombstones already did, so anyone holding a backup can confirm a guess of its exact text.
- **Retention cleanup is not a purge.** On a managed brain, `gbrain pages purge-deleted` no longer writes purge tombstones; only `gbrain delete <slug> --purge` and `purge_fact` forget content.

## To take advantage of v0.60.265.0

`gbrain upgrade` applies migration v249, which adds the empty ledger tables and one index on facts (built online on Postgres). Nothing records until you run `gbrain beliefs enable`.

1. **If the upgrade did not finish:** `gbrain apply-migrations --yes`.
2. **To start recording:** `gbrain beliefs enable --source <id>`, then `gbrain beliefs status`.
3. **Verify:** `gbrain doctor --json` shows `belief_ledger_coverage` as information (off) or ok (recording).
4. **If any step fails,** file an issue at https://github.com/garrytan/gbrain/issues with the output of `gbrain doctor`, `~/.gbrain/upgrade-errors.jsonl` if it exists, and which step broke.

### Itemized changes

- **Migration v249** adds `belief_events`, `belief_page_lifetimes`, `belief_commit_marks`, `belief_retier_manifest`, `belief_redactions`, `sources.purge_epoch` and `idx_facts_belief_stream`. All tables start empty.
- **One finalization point** (`src/core/belief/ledger.ts` `withBeliefBatch`): single and grouped publication read the touched pages' state before and after the projections, append the difference under the held page keys, and mark the commit. Logical keys survive renames and merges through page lifetimes; a page's first event is one creation snapshot.
- **Trust tiers on every event**: lower-tier destructive rewrites are recorded as contested, tier lowering propagates and is never promoted automatically, and an owner `trust confirm` that releases a redacted field appends `redaction.released`.
- **Purge redaction** (`src/core/belief/purge.ts`, `purge-mirror.ts`): a purge redacts every field that carried the claim, records the request in a register, and writes a purge-mirror line so `gbrain beliefs replay-purges` can re-apply newer purges after a Postgres restore; a restore without them is flagged.
- **Coverage** (`coverage.ts`, `coverage-report.ts`): enable baselines every page under its page key and sets the watermark; disable during an enable ends the run uncertified; a stopped ledger stays stopped across restores.
- **History backfill** (`backfill.ts`) reads `page_versions` only, records historical time separately from recorded time, and is never certified.
- **State read** (`state.ts`) is one statement per batch side, uses indexed link, transition and fact selection, and runs with a transaction-local generic plan so bulk imports stop re-planning it per page.
- **Doctor `belief_ledger_coverage`**: intervals, certification, baseline progress, drift (sampled; complete under `--tier deep`), unmarked publications and partial purge replays; `--fix` reconciles.
- Design and the full list of W1 deviations: `docs/designs/BELIEF_LEDGER.md` (section 13).

### For contributors

- Tests: `test/belief-ledger-*.test.ts` run every probe from the design's section 11 on PGLite and Postgres.

## [0.60.264.0] - 2026-10-16

**A write right after creating a very large page no longer has to wait out a doubled re-index (switch-on behavior only; no change with `pages.segmented_storage` off, the default).** With segmented storage on, creating a page over 1 MiB indexed it twice at once: once right after the write and once from the background job the write queued. Each pass held a database connection for every batch, and on a small connection pool the next write could miss its 5-second wait and come back `write_pending`. Now only one pass per page runs at a time in a process, and a page that's already indexed is skipped. No data was ever at risk: the shrink path versions the old body and demotes the page in one transaction.

### Itemized changes

- **One projection per page per process** (`page-body/projection.ts`): a second call for the same page waits for the first, and a sealed page returns at once.
- **Forced probe** in `test/large-pages/segmented-derived-work.test.ts`: holding the first projection open shows 2 concurrent projections of one page on master and 1 with the fix, on PGLite and Postgres. Fixes the nightly race-hunt failure #6143.

## [0.60.263.0] - 2026-10-16

**A managed source no longer stays blocked forever on a "conflict" with a page that does not exist.** On a managed brain, a sync could end `BLOCKED` with `revision_conflict` on `__managed_sync_checkpoint__`, and every sync after it ended the same way: doctor's `sync_freshness` failed for good, `gbrain sources refresh` refused with `sync_in_progress`, and the printed fix said to read a page that `gbrain get` cannot find (#6834). That slug is the sync's own bookkeeping, not a page. The refusal meant another run (in practice an older gbrain, which kept one cursor per writer and option set, so two cursors of one source could race) had already moved the source's commit checkpoint, so this run's checkpoint could never publish. Now a run whose source already stands at its target finishes on the next plain sync, and one whose source moved anywhere else is named by doctor with a preview-first repair. No page content was ever at risk.

### What you'd see

| Situation | Before | Now |
|---|---|---|
| The source's `last_commit` already equals the stuck run's target (the usual case: two cursors raced to the same commit) | every sync: `Sync BLOCKED ... revision_conflict ... slug: "__managed_sync_checkpoint__"` | the next plain sync finishes the run (`synced`) and clears the failure |
| `last_commit` moved to some other commit | blocked forever; every repair channel reported nothing to repair | still blocked, but `gbrain repair managed-sync-orphans --source <id>` lists the cursor as `checkpoint_moved`; after its apply the next sync discovers from the recorded commit. Doctor `sync_failures` and `sync_freshness` name that repair as their fix |
| The receipt's fix (`gbrain sync` output, `gbrain write-request`) | "Read the current page and review the intended change" | reason `sync_checkpoint_moved`: bookkeeping, not a page, and the step that finishes or retires the run |
| The terminal-failure action for the refused checkpoint receipt | `gbrain get --source <id> -- __managed_sync_checkpoint__` (page_not_found) | `gbrain sync status --source <id> --json`; a later committed checkpoint of the source supersedes the receipt |
| A fact-extraction batch refused on `__managed_facts_complete__` ("Some extracted facts have not committed.") | "Read the current page ..." | reason `facts_batch_incomplete`: the batch's completion record, not a page; the facts that committed stay, and the action inspects the receipt |

### If a source is stuck now

On this release: run `gbrain sync --source <id> --no-pull`. If it still ends blocked on `__managed_sync_checkpoint__`, preview and apply the repair doctor names:

```bash
gbrain repair managed-sync-orphans --source <id>                        # preview: lists the cursor as checkpoint_moved; writes nothing
gbrain repair managed-sync-orphans --source <id> --apply --expect <hash>
gbrain sync --source <id> --no-pull                                      # discovers from the source's recorded commit
```

On v0.60.255.0 through v0.60.262.0 (one cursor per source): `gbrain sync --source <id> --no-pull --retry-failed`, with the options the stuck run used (`resume_argv` in `gbrain sync status --source <id> --json`), rediscovers from the recorded commit and unblocks the source. On older releases, where a writer's sync reads only its own cursor, upgrade first.

### Itemized changes

- **Checkpoint at its target (#6834).** A managed-sync checkpoint refused "The source checkpoint changed during this sync." whose source now records exactly the run's target is revived marked overtaken (the #5522 rule the publication already applies), within the existing per-invocation revival bound. A checkpoint moved to any other commit stays refused: publishing it would move the source's commit backwards or past work nobody imported.
- **`checkpoint_moved` orphans (#6834).** `classifyManagedSyncOrphans` lists an unfinished cursor whose checkpoint is that refusal, whose pages all committed, whose source records a commit other than the run's start and target, and with no open or recovering request under its key; for a path slice short of its target's end (#6349), any commit other than the run's start qualifies, since that checkpoint never moves `last_commit`. `retireManagedSyncOrphan` re-checks the same rule in the delete and binds it to the previewed run and checkpoint request, so a cursor whose source reached its target after the preview, or a run that replaced the previewed one under the same key, is kept (`no_longer_orphaned`). Retiring a path slice clears its slice record too, so the next discovery starts from the recorded commit instead of resuming that slice against it. Bookkeeping rows only (`op_checkpoints`); no page or file changes, nothing at upgrade.
- **Doctor (#6834).** `sync_failures` sets `fix` to `gbrain repair managed-sync-orphans [--source <id>]` whenever it lists orphans. `sync_freshness` sets the same `fix` (and names it in the message) for a stale managed source with a `checkpoint_moved` cursor, instead of a plain sync that would block again.
- **Diagnostics (#6834).** `writeFailureDiagnostic` gives the moved-checkpoint and incomplete-fact-batch refusals their own reasons and suggestions. `classifyTerminal` keeps both in `caller_conflict` but with class `systemic` and an action that reads sync status (checkpoint) or the receipt (fact batch), never `gbrain get` on a bookkeeping slug. The supersession rule counts a later committed checkpoint of the source as superseding a refused one. A page whose slug merely looks like a bookkeeping slug keeps the page diagnosis: the request's own kind (or, once compacted, its operation) decides. Ordinary page conflicts are unchanged.
- `test/persistence-sync-failures.serial.test.ts` produced its checkpoint failure by moving `last_commit` to the run's own target, which now finishes; it moves it to a commit outside the run instead.
- Tests: `test/sync-checkpoint-moved-6834.test.ts` (PGLite and Postgres) builds the race with two older cursor keys, a brain that already carries the refused receipt and failure row, a checkpoint moved elsewhere, a path slice, and a run replaced between preview and apply; it fails on v0.60.262.0 (every plain sync blocked, no orphan listed, the page fix printed) and passes here.
- No schema change.

## [0.60.262.0] - 2026-10-16

**One purged item no longer stops a whole Google sync, a source whose syncs keep dying now says so, and Claude refusals through `claude-cli` stop being retried forever.** If you purged a page that a connector keeps listing (a recurring calendar event whose future occurrences you deleted with `--purge`, while the series stays on the calendar), the next sync that reached it ended there. Every sync after it died the same way, so nothing more from that account was imported: no new mail, contacts or events. And every status surface said the source was fine. Now the purged item is skipped and recorded, as the purge intends, and the rest of the sync goes through. Separately, when Claude refused a prompt under its usage policy through the `claude-cli` model provider, atom extraction counted it as an ordinary error and sent the same page back to the model on every run; it now takes the same bounded give-up path as other providers' refusals.

### What you'd see

| Situation | Before | Now |
|---|---|---|
| A Google or GitHub connector lists an item whose content you purged | the whole sync job dies with `purged_content`, and so does every later one | the item is skipped and listed in `gbrain sources status` ("skipped as purged content"); everything else imports and the cursor moves on |
| A connector source's syncs keep ending on an error | `sync status`: `last_error: null`, `needs_human: false`; doctor `sync_freshness` ok until 24 h passed | `sources status` and `sync status` name the error, the item and a read-only next step; after 3 failed runs in a row the source reads STOPPED in both, and doctor `sync_freshness` warns (fails once the last good sync is past the fail age) |
| `claude-cli` answers "API Error: <model> can't help with this ... https://www.anthropic.com/legal/aup" during `extract_atoms` | counted as a generic error; the page is re-sent on every run and never given up on | treated as a content block (`claude_cli_usage_policy`); after the usual consecutive-failure limit the page is tombstoned and stops costing calls |

### If a Google source is stuck now

Upgrade to this release; the next sync skips the purged occurrence by itself and imports the backlog. Nothing to clear, no flags.

On an older release you can unblock it by hand: `gbrain pages purges list` names the purged slugs, and `gbrain pages unpurge <slug>` for the occurrence the failing job names lets that one occurrence back in so the sync can finish. Each week the next purged occurrence of the series enters the 60-day calendar window and stops the source again, so the lasting fix on an older release is ending the series (or deleting its future occurrences) in Google Calendar itself.

### Itemized changes

- **Per-item purged skip (#6831).** A managed connector page import whose content matches one of the source's page purge tombstones is skipped before admission (`ManagedConnectorSync.carriesPurgedPage`, same content hash the pages guard compares). If the guard still refuses at publication (`failed` / `purged_content`, for example a purge that landed mid-run), that refusal is skipped the same way, wherever it surfaces: the item's own wait, the pending set at the end of the run, or the pending set a previous run left. A skipped item is not a receipt the checkpoint waits on and is not counted as imported. A replayed refusal stays skipped, under `--retry-failed` too, while its tombstone stands; once `gbrain pages unpurge` cleared it, the next run retries the item once by itself. Every other failed receipt still fails the run, as before. Covers every connector on this path: Google contacts, calendar and Gmail, and GitHub.
- **Run failures recorded (#6831).** The connector state row records the error a run ended on (a write refusal, a credential error or any other error, except a lost lease or the caller's own deadline or cancel; `last_failure`: code, message, item slug and request when the run ended on an item's receipt, time, and the count of runs in a row that ended that way); only a complete run clears it. It also keeps the 20 most recent purged skips (`purged_items`) and the run's `last_run.purged_skipped` count.
- **Status surfaces (#6831).** `gbrain sources status` (human and `--json` `connector.last_failure`, `connector.stopped`, `connector.purged_items`); `gbrain sync status --json` gains `connector_last_error` (with `class`, `safe_actions`, `needs_human` and a read-only `fix`). `last_error`, `state`, `next`, the managed-sync cursor and its resume command are unchanged for connector sources. Doctor `sync_freshness` reports a connector source with 3 or more failed runs in a row as STOPPED. A run counts as failed when it ends on any error other than a lost lease or the caller's deadline or cancel; only a complete run clears the record, so a partial or wait-budget stop leaves it as it was. Recording needs managed persistence (`connector_state` exists only there).
- **`claude-cli` refusals (#6816).** `providerContentBlockReason` recognizes the `claude-cli` adapter's usage-policy refusal: the `claude-cli reported error: API Error:` prefix with no API status, the usage-policy link, and one of the refusal phrases Claude Code has used ("can't help with this", "safeguards flagged this", "violate our Usage Policy"). Any other `claude-cli` error is unchanged. With `chat_fallback_on_refusal: false`, such a refusal is no longer sent on to the next model in `chat_fallback_chain`.
- Tests: `test/connector-purged-item-6831.test.ts` (PGLite) and `test/e2e/connector-purged-item-6831.test.ts` (Postgres) fail on v0.60.260.0 with `purged_content` ending the run and pass here; `test/claude-cli-refusal-6816.test.ts` runs the real adapter and gateway against a stub CLI.
- No schema change.

## [0.60.261.0] - 2026-10-16

**Auto-update no longer blocklists the next release.** While master was ahead of the latest published release, the `auto` channel targeted master's unreleased `VERSION`, `bun update` changed nothing, the swap still reported success and relaunched, and the relaunch recorded the unreleased version as known-bad, so that release was never installed automatically once it shipped. Update checks now follow the published release, a swap that installs nothing is not a swap, and one command clears the bad entries an earlier release left behind (#6828, #6718).

### If auto-update skipped a release on your install

`gbrain doctor` shows `self_upgrade_health` warning `Auto-upgrade skips <version> as known-bad, but it was never installed`. On this release:

```bash
gbrain self-upgrade --clear-never-installed           # preview: each entry and the swap that recorded it; changes nothing
gbrain self-upgrade --clear-never-installed --apply   # removes exactly those entries
```

Only an entry proven never installed is listed: the no-op swap's own `last_upgrade` record (same version as `from` and `to`, written during that swap) must still be there, so only the most recent such entry can be proven, and a release that really installed and then crashed stays known-bad. An older entry shows under "Kept"; clear it by hand as below once you have confirmed it. If your install is still on an earlier release, it may be skipping this release as known-bad too: upgrade by hand with `gbrain self-upgrade` (a manual upgrade does not consult the known-bad list), or read the list with `gbrain config get self_upgrade.failed_versions` and, for an entry you have confirmed was never installed (no `v<version>` tag existed when it was recorded), set the list without it with `gbrain config set self_upgrade.failed_versions '[...]'`.

### What you'd see

| Situation | Before | Now |
|---|---|---|
| Master's `VERSION` is ahead of `latest-stable` | `UPGRADE_AVAILABLE` and doctor announced master's version; `auto` tried to install it | the published release is announced; nothing to install until it ships |
| `gbrain upgrade` where the install step changes nothing | `Upgrade complete. Now running: <same version>`; `last_upgrade` overwritten with `<v> -> <v>` | `No newer version was installed: still running gbrain <v>.`; `last_upgrade` kept |
| `auto` swap that installs nothing (a moving tag already at its head, an exact-tag pin) | `swapped; exiting for supervisor relaunch`, then `crash-on-launch ... (recorded known-bad)` for a version never installed | stays up, audits `skipped: nothing newer was installed`, records nothing known-bad, retries after 24 hours |
| A new release installs and does not start | the attempted version recorded known-bad | the installed version recorded known-bad (unchanged when they are the same) |
| Exact-tag pin with no newer published tag | the reinstall hint could name master's unpublished `#v<VERSION>`, and the `upgrade_errors` warn never cleared | the hint moves the install off the pin, and the warn clears once the binary moves past the version it failed from |

### Itemized changes

- `gbrain check-update`, the startup marker refresh, `gbrain self-upgrade` and the `auto` channel read `VERSION` and `CHANGELOG.md` at the `latest-stable` tag (`src/commands/check-update.ts`).
- `gbrain upgrade` compares the version after the install step with the one running; an unchanged version skips `last_upgrade`, `JUST_UPGRADED`, the cache reset and the post-swap smoke. With `GBRAIN_SWAP_RECEIPT` set (the `auto` channel sets it), it writes what it installed (`installed`, `not_installed`, `installed_broken`).
- The `auto` channel reads that receipt (or `gbrain --version` when there is none): nothing installed, or no newer version confirmed, holds without known-bad and sets `self_upgrade.last_check_ts` (one attempt a day); a failure records the installed version, and when that is not the checked version also throttles and drops the update cache; a real swap points the relaunch breadcrumb at the installed version (`src/core/self-upgrade-swap.ts`). Before swapping it checks the version the install would get against the known-bad list.
- The pinned-install fallback no longer reads the update cache for its target, so it never names an unpublished version (#6718).
- `gbrain self-upgrade --clear-never-installed [--apply] [--json]` and the `self_upgrade_health` warn with its fix (`src/core/self-upgrade-recovery.ts`).
- `upgrade_errors` treats a record whose target is not a version as superseded once the binary is newer than its `from` version and the schema is current.
- No schema change.

## [0.60.260.0] - 2026-10-16

**An approved `doctor --remediate --include-repairs` run no longer fails with `preview_changed` because autovacuum analyzed a table between the preview and the run.** Hotfix for LHF wave 2 item 6 (GBRA-107, reported by GBRA-101).

### What you'd see

| Situation | Before | Now |
|---|---|---|
| Postgres autoanalyzes a table (or collects an expression index's statistics) between `doctor --remediation-plan` and the approved `--remediate --include-repairs --expect <plan_hash>` | refused with `preview_changed`; the approval had to be repeated | runs; planner-stats applies whatever is pending at run time |
| A new pending repair appears between preview and run | `preview_changed` | `preview_changed` (unchanged) |

### Itemized changes

- `RepairKindSpec.approval: 'unbound'` leaves a kind out of the remediation approval's plan_hash. planner-stats is the one such kind: it plans from live server statistics that autovacuum changes on its own schedule, and its ANALYZE changes no stored record. Every other repair kind stays bound by its pending count.
- `test/e2e/remediate-planner-stats-approval.test.ts`: an ANALYZE between approval and run fails on v0.60.259.0 with `preview_changed` and passes here; a new orphan connector checkpoint between approval and run still refuses.
- No schema change.

## [0.60.259.0] - 2026-10-16
