# Changelog

All notable changes to GBrain will be documented in this file.

Historical entries use generic identifiers for the retired hosted provider
and its removed commands.
Those identifiers and any sample command containing them are non-executable
archival labels, not supported configuration. Dates, measurements and contributor
credits are retained; no result has been reassigned to another provider. Original
identifiers and attribution are available in the pre-removal Git revision
`6040075c6cb95be5881cc2e1b76ef7d71f4e5d29` (retained on 2026-09-23).

## [0.60.425.0] - 2026-10-24

**A darwin-x64 native-locks cell that wedges now leaves a record of what it was running: its last suite, how long it had run, and the machine's memory, swap, load and busiest processes.**

### What changed

| Situation | Before | Now |
|---|---|---|
| A darwin-x64 native-locks cell wedges until the job timeout | GitHub stored no job log and dropped the step annotations, so nothing showed which suite hung or why | the cell posts the commit status `diag/native-heartbeat` every 30 s and on each suite change, naming the suite, its elapsed seconds, free memory, swap, load and the top three process names; GitHub keeps every status, so the last one before the wedge survives |
| A darwin-x64 cell that ends, passed, failed or cancelled | nothing posted | a terminal `success` status names the job result, so nothing is left pending |

The status is posted only from this repository's own branches and pull requests, never from a fork's pull request. It needs `statuses: write` on the native job alone. It never includes the environment or the token.

### What to watch for after you upgrade

- Nothing changes for gbrain users: this is CI only. Nothing is rewritten on upgrade, and there is no schema migration.
- `diag/native-heartbeat` is not a required check. A `pending` heartbeat that never turned `success` means the darwin runner died, and its last description shows where.

## [0.60.424.0] - 2026-10-24

**Background Git backups of your brain keep moving when another gbrain process is busy with the same checkout.** gbrain writes page files into a managed Git checkout and commits them in the background. When a second process (a long sync, a serve pass) kept taking and releasing that checkout many times a second, the background committer in another process lost every race for it. Its backlog of Git work then never ran, and it retried four times a second forever. Now a waiting committer gets its turn within about a second, a busy retry backs off, and doctor tells you when a backlog has not moved for ten minutes.

### What changed

| Situation | Before | Now |
|---|---|---|
| Another process keeps the managed checkout busy | the background Git committer tried once between that process's writes and almost never won | it waits up to 5 s per pass, and after 1 s the other process yields until it has had its turn |
| The checkout is still busy after that wait | retried as `writer_busy` every 250 ms, without end | retried with a backoff from 250 ms doubling to 60 s; it never parks on contention |
| A backlog of effects has waited on a busy checkout for over 10 minutes | nothing reported it | doctor `parked_effects` warns "Catch-up not progressing" and `gbrain sources writer status` lists `stalled_catchups` |

### How to use it

- `gbrain doctor --json`: `parked_effects.details.stalled_catchups` lists per source the stalled effects, when their wait began (`busy_since`), the longest busy streak (`busy_retries`) and the read-only fix.
- `gbrain sources writer status --source <id> --json` shows the same `stalled_catchups` and the processes holding the checkout.

### What to watch for after you upgrade

- A process waiting for the checkout leaves a small marker beside the checkout's coordination lock (`<lock>.waiters/<pid>`), outside the checkout itself. Markers from processes that exited, or that stopped refreshing them, are ignored.
- Nothing is rewritten on upgrade, and there is no schema migration.

### Itemized changes

- `src/core/persistence/worktree-lease.ts`: waiter markers (`noteWaiting`, `clearWaiting`, `foreignWaiterAhead`); lane leases drain and lane takes yield to a foreign waiter that has waited 1 s.
- `src/core/persistence/ownership.ts`: a no-wait `acquireWorktree` yields to a foreign waiter; new `acquireWorktreeWaiting` for the effect worker.
- `src/core/persistence/effects.ts`, `effect-journal.ts`, `effect-model.ts`: effects wait for a contended worktree once per root per pass; `writer_busy` backs off (`retryBusyEffect`) and records `busy_retries`, `busy_since` and `busy_at` while the effect waits; completion drops them, so a receipt's size never depends on contention.
- `src/core/persistence/effect-catchup.ts` (new): `readStalledCatchups`, used by doctor `parked_effects` and writer status.
- `src/core/hardened-git.ts`: a Git stream that has settled no longer keeps its caller's options and chunk handler reachable through its idle timer.

## [0.60.423.0] - 2026-10-24

**`gbrain sync status` tells you what a busy or stuck source is really doing, and a sync that commits nothing says it stalled instead of claiming progress.** On a large brain, status used to print every held file (thousands of rows, megabytes of JSON), so the useful part was buried. A catch-up could also look alive for hours: screening unchanged files counted as progress, so a run that wrote nothing kept extending its deadline. Now status prints a short summary of holds, names the process doing the work, and only counts committed pages as progress.

### What changed

| Situation | Before | Now |
|---|---|---|
| `gbrain sync status --json` on a source with thousands of holds | every hold inline | `holds_summary` counts plus the first 20 holds, needs-human first; `--detail` pages them |
| Who is syncing this source right now? | not shown | `live` names the drain-lease holder (serve pass, sync job, CLI sync or cycle) with heartbeat and `stalled` |
| An old error after a later pass moved past it | still drove `state` and `next` | reads `superseded` with `by` and `age_seconds`, and no longer drives `state` or `next` |
| A sync that reaches its deadline having committed nothing | extended as "still progressing" | stops with `sync_deadline_stalled` and a read-only status fix, once at least one progress window has passed since it started |
| A drain holder that has committed nothing for 5 minutes | the commit notifier deferred silently | counted as a failed attempt (`drain_holder_stalled`), so status and doctor show the sync-now fix |
| A pass checkpoint whose pass already ended | `revision_conflict`, recorded as a failure | `sync_pass_superseded`, not a failure |
| A pooler's client cap (`EMAXCONNSESSION`, "too many clients already") during a managed write | terminal `storage_error` | released as contention and retried, like SQLSTATE 53300 |

### How to use it

- `gbrain sync status --source <id> --json` shows `holds_summary`, the first 20 holds, `last_commit`, `last_sync_at`, `last_committed_at`, `live` and `freshness.waiting_commits`.
- `gbrain sync status --source <id> --detail` pages holds 100 at a time; `--limit <n>`, `--cursor <next_cursor>`, `--all` and `--hold-state needs_human|actionable|held` narrow it.
- A managed pass prints `[sync] pass round N: read ...` and `... importing N file(s) ...` before its import walk, and a serve pass that stops short names why on its `[serve-sync] done` line (`stop=<reason>`) with a `next` line.

### What to watch for after you upgrade

- Scripts that read every hold from plain `sync status --json` should page with `--detail --all` or follow `holds_page.next_command`. A source whose holds fit on one page prints them as before.
- A sync that used to run on while committing nothing now stops with `sync_deadline_stalled` and exits non-zero. Read `gbrain sync status --source <id> --json` for the cause.
- Nothing is rewritten on upgrade, and there is no schema migration.

### Itemized changes

- New codes `sync_deadline_stalled`, `drain_holder_stalled` and `sync_pass_superseded`, and reason `owner_restart_required` on `drain_stalled`; `docs/reference/error-codes.md` is regenerated.
- `gbrain sync status` adds `holds_summary`, `holds_page`, `live`, `last_commit`, `last_sync_at`, `last_committed_at`, `convergence.converged_target`, `freshness.waiting_commits` and `last_error.superseded`; the notifier block adds `recorded_resident`.
- A governor-stopped drain drops the abandoned pass's late progress events; a stop whose head owner reports restart_required reads `owner_restart_required` with the owner's heartbeat row.
- The commit notifier counts a resumable sync that committed pages as progress before `last_commit` moves.
- A resident notifier's background runs write their lines to the serve log (`[serve-sync] job=<id> ...`).

## [0.60.422.0] - 2026-10-24

**The Postgres crash-robot ceilings are tightened now that a dead owner's effect claim is released early: 620 s on pull requests and 880 s on every other event.**

### What changed

| Situation | Before | Now |
|---|---|---|
| Crash robot, Postgres, pull requests and merge queue | 1020 s ceiling, sized around one to three 2-minute effect-claim lease waits per cell (567–785 s) | 620 s; after #7454 the cells measured 357–475 s with no lease wait |
| Crash robot, Postgres, every other event | 1800 s ceiling, sized around lease waits (slowest cell 1,290 s) | 880 s; a full-scope run after #7454 measured 391 s and 679 s |

PGLite ceilings are unchanged (820 s on pull requests, 1200 s elsewhere). Each ceiling is the slowest measured cell plus about 30%, and a run past it still fails with `over_budget` and prints its share of the ceiling. The measurements are in `docs/ci-event-parity.md`.

### What to watch for after you upgrade

- Nothing changes at runtime: this release only changes CI ceilings and their docs. Nothing is rewritten on upgrade, and there is no schema migration.

## [0.60.421.0] - 2026-10-24

**`search.evidence_tail_trim` (default off) trims low-scoring conversation blocks from the tail of an `auto` evidence delivery, and keeps any block that restates the question's terms.** With the key on, `search` and `query` drop whole-conversation blocks past the top 3 whose search score is under half of rank one's. A block that holds at least 80% of rank one's share of the query's terms is kept, because a low-scoring session can carry the earlier value a knowledge-update question needs. Nothing changes unless you turn the key on.

### What changed

| Situation | Before | Now |
|---|---|---|
| `auto` delivery for `search` / `query` with `search.evidence_tail_trim` on | every whole-conversation block in the result list was delivered | blocks past rank 3 scoring under half of rank one are dropped, unless they hold the query's terms nearly as fully as rank one |
| The same call with the key off (the default) | unchanged | unchanged, byte for byte |
| Ranked chunks, saved facts, long pages, a call without a query or without a usable score on every row | delivered | delivered, never trimmed |

### What to watch for after you upgrade

- Turn it on with `gbrain config set search.evidence_tail_trim true`. `delivery.tail_trim` reports `{ dropped, kept_by_query_terms }`, and `dropped_reasons.tail_trim` counts the dropped blocks.
- On LongMemEval-S, a replay of frozen evidence with no paid calls cut delivered tokens by about 36% on the questions the trim touched. Accuracy was not measurably lower on Sonnet 5.5, GPT-6.1 Sol or Opus 5.5. This is development evidence, on data retrieval was tuned on, and the verdict is mirrored in gbrain-evals#186.
- The trim adds about 1 ms of server time per call. The response payload on the touched questions shrinks by about a third.

### Itemized changes

- `src/core/search/evidence-tail-trim.ts`, `src/core/search/evidence-delivery.ts`, `src/core/ops/search.ts`, `src/core/config.ts`: the trim, its delivery meta and the config key. The library `assembleEvidenceForHits` accepts `query` and a per-hit `score`. The `assemble_evidence` op passes neither, so its output is unchanged.
- `docs/evidence-delivery.md`: the new "Tail trim" section. The evidence-date entry moves into `docs/architecture/key-files/core-search-evidence.md`.
- Tests: `test/evidence-tail-trim.test.ts` and the export-surface golden.

## [0.60.420.0] - 2026-10-24

**`gbrain sources writer git-durability --enable` now works when the remote branch has commits the checkout lacks, and a facts write retried under its own `request_id` keeps returning its recorded outcome.** The enable check's read-only `git push --dry-run` refused a remote that had moved, but the Git effect already publishes that case without touching the checkout. A caller retrying a facts write with an explicit request id could get its retained file refusal rechecked rather than receive the outcome it recorded.

### What changed

| Situation | Before | Now |
|---|---|---|
| `--enable` when the remote branch moved since the last fetch (`[rejected] (fetch first)` or `(non-fast-forward)`) | refused with `git_push_unavailable` | enabled, and `push_probe` reports `remote_moved: true`. The Git effect merges the remote commits in memory and pushes the merge without pulling into the checkout. A change to the same file on both sides is held as `integrate_conflict` for the user to choose |
| `--enable` when the push fails on authentication, permission, a protected branch or an unreachable remote | refused | still refused |
| A managed facts write retried with the caller's own `request_id` after a file refusal | could recheck the refusal once the hold cleared | returns that request's recorded outcome. Page-triggered and re-admitted facts batches still recheck once the hold clears |

### What to watch for after you upgrade

- No migration, and nothing is rewritten on upgrade.
- A brain that refused `--enable` only because its remote had moved can rerun the same command.

### Itemized changes

- `src/core/persistence/git-durability-administration.ts`: `probeDurabilityPush` passes a moved-remote rejection with `remote_moved`. `src/core/persistence/effect-git.ts` exports the `NON_FAST_FORWARD` match it shares with the push path.
- `src/core/persistence/facts-maintenance.ts`: `fileRefusalRetry` is off under an explicit `request_id`. Contributed by @Masashi-Ono0611 (#7402).
- Tests: `test/git-durability-probe-remote-moved-gbra133.test.ts`, `test/facts-absorb-held-replay-7364.test.ts`.

## [0.60.419.0] - 2026-10-24

**A warm CLI search that a serve can't finish now stops cleanly, and the warm socket refuses fewer callers and says so when it does.** When a search's client disconnects, or the call reaches its round-trip cap, the serve cancels the rest of that search and frees its connections and search slot. At the cap the CLI prints a retryable `timeout` error and exits 124 instead of running the whole call again on the cold path. Idle maintenance sweeps no longer start while warm searches are coming in. Search read transactions open `BEGIN READ ONLY`.

### What changed

| Situation | Before | Now |
|---|---|---|
| A warm search reaches the socket's round-trip cap | the CLI reran the call cold, roughly doubling its time | a retryable `timeout` error (reason `cli_socket_round_trip_cap`), exit 124; the envelope goes to stdout under `--json`, and an [AGENT] block goes to stdout otherwise |
| The client goes away mid-search, or the cap is reached | the serve kept running the search and holding its connections | the request's signal aborts its read transactions and frees its search slot; disconnects are logged |
| The CLI's environment has a routing variable for a provider neither side can call (for example an Azure API version without an Azure endpoint) | refused, so the call quietly took the cold path | answered warm. A provider's routing values still count when either side can call that provider, and credentials are still compared by name |
| A call is refused because of identity | silent unless `GBRAIN_DEBUG=1` | a `socket_identity_mismatch` degraded notice naming the part (never its value); `gbrain doctor --only cli_socket_refusals` counts refusals per part |
| An idle-sweep tick while warm CLI searches are flowing | the sweep could start beside them | the tick counts them as activity and waits, as it already did for MCP stdin |
| The writes a search makes for itself (`page_retrievals`, eval capture, semantic-cache store) | could start before the answer was written | start after the socket writes the answer |
| A search read transaction | `BEGIN READ WRITE` | `BEGIN READ ONLY`, so a write inside one fails instead of committing |

### What to watch for after you upgrade

- The identity check is not an access control. Who may connect to the socket is unchanged: it is bound 0600 in a 0700 directory, and the serve rejects any peer whose kernel uid differs, even when that peer presents the serve's exact identity.
- Migration v269 builds the partial index `idx_links_supersedes_to` concurrently on Postgres.
- The upgrade notice's trust-claim check now runs one existence check per unclaimed source instead of counting every source's rows.
- `GBRAIN_SWEEP_IDLE_INTERVAL_MS` (at least 1000) shortens the idle-sweep interval for benchmarks. Each sweep logs when it starts and how long it took.
- `scripts/bench/production-soak/socket-probe.ts` measures warm CLI searches against a soak fixture. It reports round trips, sequential round trips and stage timings. Its `--sweep` option forces sweeps to run beside searches.
- Measured on a synthetic 50k-page brain at a 58 ms round trip: steady-state warm search latency is unchanged (wall p50 1549 ms on master, 1575 ms here). With forced sweeps beside bursts of 3 and 8 concurrent searches, there were no errors, no search reached the cap, and none was starved.

### Itemized changes

- `src/core/cli-socket/identity.ts`, `refusals.ts`, `server.ts`, `execute.ts`, `protocol.ts`, `src/cli/cli-socket-client.ts`: narrowed identity, refusal counts, cancellation, the round-trip cap error.
- `src/commands/doctor/checks/cli-socket-refusals.ts`: the new doctor check.
- `src/core/request-signal.ts`, `src/core/postgres-engine.ts`, `src/core/engine.ts`, `src/core/search/connection-budget.ts`: request cancellation and `TransactionOptions.readOnly`.
- `src/core/foreground-activity.ts`, `src/commands/serve.ts`: idle-sweep gating and sweep logs.
- `src/core/background-work.ts`, `src/core/last-retrieved.ts`, `src/core/eval-capture.ts`, `src/core/search/hybrid.ts`: writes deferred until after the answer.
- `src/core/schema-migrations/v269-links-supersedes-index.ts`, `src/schema.sql`: the supersedes index. `src/core/trust/claim.ts`: the existence check.
- Tests: `test/cli-socket.test.ts`, `test/e2e/cli-socket-postgres.test.ts`, `test/sweep.test.ts`, `test/trust-claim.test.ts`, `test/response-deferral.test.ts`, `test/e2e/search-read-pipeline-postgres.test.ts`, and the catalog, migration-record and doctor goldens.

## [0.60.418.0] - 2026-10-24

**The drain lease that keeps two `gbrain sync` drainers off one source now has a TLA+ model that CI checks on every change to it, and mutants that tie each guard the model relies on to the code line that implements it and the test that pins it.** No product code changes.

### What changed

| Situation | Before | Now |
|---|---|---|
| A change to the drain lease's fence, takeover, renewal or release | caught only when a hand-written test happened to cover that interleaving | TLC checks every interleaving of two drainers (fenced transactions, the pass stamp, renewal, takeover, release, sleep, crash) at small bounds, and fails the PR on a lost lease or two drainers with fenced work open |
| A guard loses the test that pins it | nothing noticed | its code mutant runs that test with the guard removed and fails the PR when the test still passes |

### What to watch for after you upgrade

- Nothing changes at runtime.
- Contributors: `bun run test:tla` runs TLC on every config and every mutant locally (Java 11 or later; the TLC jar is downloaded and checked against its pinned sha256). `spec/tla/README.md` explains each failure code.

## [0.60.417.0] - 2026-10-24

**A killed gbrain process no longer leaves its Git, embedding or facts effects stuck for two minutes, legacy pages stop being held `file_drift` each time their files are committed, and a pending-import refusal no longer tells agents to start a competing sync.**

### What changed

| Situation | Before | Now |
|---|---|---|
| A gbrain process is killed while it runs a Git, embedding, links, facts or withdrawal-mirror effect (Linux, Postgres) | every other consumer waited out the effect's 2-minute claim lease; replayed crash seeds took 127.5 s, 130.8 s and 4.4 s | a consumer on the same machine that proves the owner dead claims the effect on its next scan; the same seeds took 4.7 s, 8.2 s and 4.8 s |
| A pooled Postgres connection after a transaction (#7358) | `begin`'s close handler kept the transaction's result reachable | the handler is removed when the transaction settles |
| A page an older gbrain imported, whose database copy carries the v0.13.1 grandfather stamp `validate: false` that its file lacks, when its file is committed again | sync could not tell which side changed and held it `file_drift` (unknown side) | sync compares the file as carrying the stamp, as page writes already did (#6429): the commit imports and the page keeps the stamp |
| The message of an unknown-side `file_drift` hold with no database write on record | "page … changed in the database" | it says the page differs from its file and no import record shows which side changed |
| A `remember` or `put_page` refused `pending_import` (a committed Git change sync has not imported yet) | the fix named `gbrain sync --source <source> --no-pull`, which an agent ran beside a live `serve` | the fix is the read-only `gbrain sync status --source <source> --json`; the running owner imports the commit |

### What to watch for after you upgrade

- Migration 268 adds the nullable `persistence_effects.claim_owner` column; nothing is backfilled or rewritten.
- New `file_drift` holds on legacy pages should stop arriving after a cron commit. A hold that is already open stays held: preview it with `gbrain repair file-drift --source <source> --held --side unknown --prefer file` (writes nothing) and apply the set you approve.
- An owner on another machine or in another container, or one whose process this machine cannot inspect, keeps its full 2-minute lease.

## [0.60.416.0] - 2026-10-23

**Every crash-robot run covers the same fixed schedule list, a group put returns only after its publication recovery record is cleared, and tests started from a git hook or an AI agent session no longer write into the caller's repository or fail every passing file.**

### What changed

| Situation | Before | Now |
|---|---|---|
| `sync status` read right after a group put on Postgres | the put could return while its receipt still held a publication recovery record, so `next` named a recovery step | the put returns after the record is cleared, as the single-row path already did, so `next` names the real next step |
| The crash robot (`--robot-seconds`) | it filled a time budget with random sequences, so two runs of one tree covered different schedules | every run executes one fixed list (cross-boundary seams, process faults, fixed seeds); the seconds value is a ceiling that fails loudly with `over_budget`: 820 s PGLite and 1,020 s Postgres on pull requests, 1,200 s and 1,800 s on every other event |
| A test run started from a git hook (#7451) | test git children inherited `GIT_DIR` and friends, so a throwaway repo's `git config` wrote into the caller's repository | the test preload drops every variable production's `gitChildEnv` drops |
| A local test run from an AI agent session (#7448) | Bun printed failure-only output, so the runner census marked every passing file incomplete and exited 1 | the runners set `AGENT=0` and count every passing file |
| `gbrain sync status` with a non-`normal` `sync.admission` | it sent an extra admission probe | the probe rides the source read; a plain status costs the same statements whatever the value |
| A large managed batch build | a loop's last stretch ran on through the next read and the first freeze without a timer turn | it pauses before each read and before it returns |
| Stale-link extraction failures on Postgres | `failed` came back in worker completion order | it comes back in drain order, the same as PGLite |
| A cancelled `ci:ubicloud` gate | it reported infrastructure errors and retired every VM | it reports `interrupted: N item(s) did not run` |
| Windows native-lock probe jobs | a slow "Set up job" could spend the job's whole limit | each step has its own bound |

Test-harness issues reported by @Masashi-Ono0611 (#7448, #7451).

### What to watch for after you upgrade

- Nothing is rewritten on upgrade, and there is no schema migration.
- A crash-robot cell that runs past its ceiling now fails with `over_budget` and names the slow runs instead of covering less.

## [0.60.415.0] - 2026-10-23

**A long-running `gbrain serve` no longer holds every managed sync pass it has run, the drain-lease renewal no longer waits behind a follower, and stuck `file_drift` holds on deleted pages are released.**

### What changed

| Situation | Before | Now |
|---|---|---|
| A resident `gbrain serve` on a large managed source, after each pass that follows a commit (#7358) | each kept tree listing's drop timer kept the whole pass reachable, so heap grew about 31 MB per pass at 50k pages and about 132 MB at 200k | the timer holds only its own entry; heap stays flat (69 → 77 MB over 30 passes at 50k, 141 → 146 MB over 10 passes at 200k) |
| A follower polling the drain lease while the holder renews it (#7442) | the follower's fence queued the holder's renewal | the fence takes `FOR KEY SHARE`, so the renewal passes (0.2–1.7 ms measured); a takeover still waits |
| A page-triggered facts batch after an agreed reconcile cleared its file hold (#7439) | it replayed its stored `source_changed` refusal | it walks the same guarded follow-up batches as the input-keyed sweep (contributed by @Masashi-Ono0611, #7440) |
| `gbrain repair file-drift --prefer file` on a held `file_gone` page | the page was soft-deleted but its `file_drift` hold stayed | the hold clears in the same publication (`hold_cleared`) |
| A deleted-side `file_drift` hold whose page is no longer live and whose file is gone | it stayed held | the next managed sync pass that stamps releases it |
| An unknown-side `file_drift` hold written before #7340 | it was never screened again | it is screened once more, so a legacy page's Git edit imports |
| A fresh process's first managed pass | it re-probed every candidate's dirtiness | it starts from the clean probes the previous process vouched for (`sync.level_reuse`); fresh-process p50 at 10k pages went from 2,393 to 1,837 ms |

### What to watch for after you upgrade

- `file_drift` hold counts can drop on the first stamping pass, as holds on deleted pages are released.
- Nothing is rewritten on upgrade, and there is no schema migration. `sync.level_reuse false` still turns every reuse off.

## [0.60.414.0] - 2026-10-23

**An autopilot tick reads brain health once instead of twice, and on Postgres that read gives up after 120 seconds instead of holding the tick.**

### What changed

| Situation | Before | Now |
|---|---|---|
| Every autopilot tick | the plan and the adaptive interval each ran the brain health aggregate, a full scan of every chunk on a large brain | the tick reads it once and both use that snapshot |
| The health read is slow on Postgres | it had no bound | it runs in one transaction with `SET LOCAL statement_timeout` (120 s), which holds through a transaction-mode pooler; PGLite stays unbounded |
| The health read times out (57014 or 55P03) | n/a | the tick logs `health_degraded` (an NDJSON event under `--json`) and runs with an unknown score: no healthy sleep, no score-forced full cycle before the 60-minute floor, the base interval, and `brain_score: null`; the timeout does not count toward the 5-failure stop |

### What to watch for after you upgrade

- Dashboards that read `brain_score` from autopilot `--json` output can see `null` on a tick whose health read timed out; any other health read error still fails the cycle.
- Nothing is rewritten on upgrade, and there is no schema migration.
- A new `undici` override, `^6.29.1` (6.29.0 → 6.29.1 in `bun.lock`), is the fixed version for advisories GHSA-xjj6-f33q-929c (high) and GHSA-4qv8-2p9j-2685 (medium).

## [0.60.413.0] - 2026-10-23

**`gbrain pages unsearchable` counts pages vector search misses and files held behind sync, and an image re-embed that rebuilt nothing fails instead of reporting success.**

### What changed

| Situation | Before | Now |
|---|---|---|
| Pages found by keyword search but missed by vector search (`keyword_only`) | `gbrain pages unsearchable` led with `unsearchable`, which leaves them out, so coverage read as complete | it adds `semantic_unsearchable` (`unsearchable` plus `keyword_only`) and the human headline leads with it; `unsearchable` keeps its doctor and `get_brain_health` meaning |
| Files held behind sync, which no embedding state can see yet | not reported | `awaiting_sync` reports `new_files`, `stale_pages` and the source's sync freshness, and the human output points at `gbrain sync status --source <id> --json` |
| An unknown `--source` | a not-found error | the error adds `Did you mean "<id>"?` (exact name, else the only id or name prefix, else the nearest id) |
| `gbrain embed --stale --images` rebuilds none of its candidate pages | it failed only when every source file was missing | it exits 1 with `status: nothing_rebuilt` and a `reason` counting missing files, files the importer left unchanged, pages that need a fresh OCR pass and failures; dry runs and cost-capped runs are unchanged |
| An embed-backfill job ends with chunks remaining | "N chunks remain" left out chunks on large pages held for approval or at their spend cap | the count includes them and names `gbrain embed --held --dry-run` |

### What to watch for after you upgrade

- Scripts that treat an `embed --stale --images` exit code of 0 as "nothing to do" now see exit 1 when candidates exist but none was rebuilt; read `reason` to see why.
- Nothing is rewritten on upgrade, and there is no schema migration.

## [0.60.412.0] - 2026-10-23

**Writes on Postgres no longer fail because a transaction-mode pooler handed gbrain a server connection that another client left read-only, and a job whose phase failed no longer ends `completed`.**

### What changed

| Situation | Before | Now |
|---|---|---|
| A pooled server connection defaults to read-only (another client's session-level `SET default_transaction_read_only = on`, or a role or database default) | sync, page writes, leases and the jobs queue failed with SQLSTATE 25006, reported as `storage_error` or `internal_error` | every transaction gbrain opens declares `READ WRITE`, an autocommit statement refused with 25006 runs once more inside a read-write transaction, and a refusal that persists (a read-only server) is `connection_inherited_read_only` in write receipts, `gbrain sync status` and the error envelope |
| A job handler's result reports a failed phase, or a `failed` / `blocked_by_failures` status | the job ended `completed` | it ends `failed` (no retry); its error names the phase, and its result keeps `job_outcome` (`phase_failed` with `failed_phase`, or `failed`) |
| An `autopilot-cycle` job ends `phase_failed` | n/a | it does not count toward the source failure cooldown; a thrown handler, a timeout or stall and `blocked_by_failures` still do |

### What to watch for after you upgrade

- A persistent `connection_inherited_read_only` means the database operator must act: reset the pooler's server connections, stop the client that issues session-level `SET` through the pooler, and check role and database defaults. gbrain never issues a session-level `SET` of its own to undo it.
- Jobs that used to end `completed` with a failed phase now end `failed`; dashboards counting completed jobs can drop.
- Deliberately read-only transactions stay read-only, a hot standby still serves reads, nothing is rewritten on upgrade, and there is no schema migration.
- The `body-parser` override moves to `^2.4.0` (2.3.0 → 2.4.0 in `bun.lock`), the fixed version for advisory GHSA-27r3-jxmh-p828 (high), and the `fast-uri` override to `^3.1.9` (3.1.8 → 3.1.9), the fixed version for advisories GHSA-333x-w4r6-6crp, GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr and GHSA-xhq7-xmqj-769h (medium and low).

## [0.60.411.0] - 2026-10-23

**`gbrain doctor` no longer scores a large brain at 0 because its checks did not finish within the budget, and `derived_visibility` runs as its own entry.** An unfinished check used to count as a warning at 5 points each, so a brain where the default 90 s budget left most checks unfinished scored 0 whatever its real state.

### What changed

| Situation | Before | Now |
|---|---|---|
| A check that did not finish within the budget (`health: unknown`, `reason: budget`) | charged as a warning in `health_score`, `brain_checks_score` and the category scores | left out of the scores and counted in `unknown_count`; the status stays at warnings, never healthy |
| A category with no finished check | scored 100 | listed in `unknown_scores`; the text report prints "unknown (no check finished within the budget)" and one `Unknown:` line |
| `derived_visibility` | one of about 35 checks sharing the `timeline_history` entry's 15 s budget, late in the run | its own entry with its own budget, right after the ops sections and the cheap incident checks |

### What to watch for after you upgrade

- `health_score` can rise on a large brain: unknown checks no longer subtract. Read `unknown_count` before treating a high score as a clean bill.
- `derived_visibility` appears earlier in the check list.
- Nothing is rewritten on upgrade, and there is no schema migration.

### Itemized changes

- `src/commands/doctor/budget.ts` (`scoredChecks`), the report's scores and text headline: unknowns left out of the scores (#7276; `test/doctor-unknown-score-7276.test.ts`).
- The doctor registry: `derived_visibility` as its own entry. Doctor goldens differ from before only in line order.

## [0.60.410.0] - 2026-10-23

**A page write onto a file that differs from the database no longer freezes the write owner while Git runs, the preparation deadline now ends that Git check, and a stall in it says `waiting_on=git`.** Before such a write is refused as an uncoordinated edit, gbrain checks whether the file holds a committed Git change that sync hasn't imported yet. That check ran its Git commands synchronously, each with a 30 s timeout, so on a slow checkout `serve` (the managed write owner) stopped for as long as Git took: lease renewals and every other preparation waited. The deadline didn't end the check either, and the stall line blamed the database: `step=link_resolution waiting_on=db last_sql=SELECT_sources@25s`. That reproduces exactly with a delayed `git hash-object`.

### What changed

| Situation | Before | Now |
|---|---|---|
| The pending-import check on a drifted page's file | four synchronous Git calls that blocked the whole process | the same Git calls, awaited; the process keeps serving while they run; the answers are unchanged |
| The preparation deadline passes while a check's Git command runs | the command ran to its own 30 s timeout and the preparation went on afterwards | the check rejects at once with the deadline; the command's process group gets SIGTERM, then SIGKILL after 2 s, so no Git process outlives the request |
| A preparation stalled in that check, or in the new-page `.gitignore` check | `waiting_on=db`, and `last_sql` naming the last statement sent before Git started | `waiting_on=git` for the length of the Git call; the step keeps its name |

### What to watch for after you upgrade

- A write onto a drifted file still ends with the drift refusal (`source_changed`, `file_database_drift`), and with `pending_import` when the file holds an unimported commit. A Git call longer than the preparation budget now ends the preparation at the deadline, and the stall line names `git`.

### Itemized changes

- `src/core/persistence/pending-import.ts`: `committedPendingImport` runs each Git command as an awaited child in its own process group and takes the preparation's abort signal; `GIT_KILL_GRACE_MS`.
- `src/core/persistence/claim-phase.ts`: `waitingOnWhile`, a non-database wait inside a step.
- `src/core/persistence/page-prepare.ts`: `prepareFileTarget` takes the preparation clock; its Git checks run under `waiting_on=git`, and the pending-import check gets the clock's signal.
- Tests: `test/pending-import-async-git-7436.test.ts`: a delayed `git` shim with an event-loop tick counter and the stamped wait, and a shim that ignores SIGTERM and leaves a grandchild, killed within the grace at the deadline with no engine call after it.

## [0.60.409.0] - 2026-10-23

**The public eval doc now headlines gbrain's current LongMemEval answer score, 468/500 (93.6%), instead of the invalid 86.6%.** The 433/500 row came from a reader that saw `answer_` session ids pointing at the evidence. With opaque ids it scores 432/500, and gbrain-evals has marked it invalid since September. `docs/eval-bench.md` now cites the current measured row: a Sonnet 5.5 benchmark reader on release retrieval with the official judge, plus Opus 5.5 at 474/500 and GPT-6.1 Sol at 464/500 on frozen retrieval. The old table stays, labeled invalid, with a link to the correction.

### Also recorded

- Five preregistered experiments go into the "Recorded experiments, including negative results" list, each with its gbrain-evals report: absolute date brackets beside relative phrases in delivered conversation turns, reciprocal-rank fusion of the reranker and first-pass orders, titled reranker documents, rank labels with date order, and a protected top-3 tail trim. None of them ships. RRF fusion lost recall (451 → 439 of 470), and the tail trim is noted as a candidate.

Docs only. No code or behavior change.

## [0.60.408.0] - 2026-10-23

**Warm hybrid search on a large brain behind a transaction-mode pooler spends about 500 ms less on the server.** On a synthetic 600k-page brain at a 66 ms round trip (mock embed 200 ms, mock rerank 300 ms), warm p50 went from 1,995 ms wall / 1,891 ms server total to 1,436 / 1,356 ms. Search reads no longer wait a round trip for BEGIN, the title arm reads a small weight-A index, search arms take pool slots ahead of background work, and two reads that only depend on fusion's inputs start beside it. Results are unchanged: the new title predicate returned identical rows and scores to the old one on 405 strict and relaxed queries at 600k.

### What changed

| Situation | Before | Now |
|---|---|---|
| A search read transaction on a pool that pipelines inside a transaction (PgBouncer transaction mode) | each statement waited for BEGIN's answer, one round trip per scoped read | plain `SELECT`/`WITH` reads and the transaction-local settings statement go out behind BEGIN in order; the first statement that is not a plain read and everything after it waits as before; page transactions are unchanged |