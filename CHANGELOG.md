# Changelog

All notable changes to GBrain will be documented in this file.

Historical entries use generic identifiers for the retired hosted provider
and its removed commands.
Those identifiers and any sample command containing them are non-executable
archival labels, not supported configuration. Dates, measurements and contributor
credits are retained; no result has been reassigned to another provider. Original
identifiers and attribution are available in the pre-removal Git revision
`6040075c6cb95be5881cc2e1b76ef7d71f4e5d29` (retained on 2026-09-23).

## [0.60.323.0] - 2026-10-20

**Agents can now add to a page without rewriting it, and write pages larger than one request.** Before, adding a line to a long conversation log meant sending the whole page back with put_page, which got slower as the page grew, and a remote or thin client could not write a page bigger than its connection's request limit at all. Now `append_page` adds text to the end of a page in time proportional to the text added, upload sessions carry a page of any size up to the page ceiling in parts, and `edit_page` can edit a very large page by rewriting only the stretch it changes.

### What changed

| Situation | Before | Now |
|---|---|---|
| Adding to a conversation log | put_page of the whole page every time | `append_page` (or `gbrain append <slug>`): cost grows with the text added, idempotent by `request_id`; `expected_tail_sha256` refuses `tail_changed` when another writer appended first |
| A remote or thin client writing a page over its request limit (1 MiB on legacy HTTP, 4 MiB on OAuth `/mcp` and stdio) | refused | an upload session: `begin_page_upload`, `upload_page_part`, `commit_page_upload` (`get_page_upload` resumes after a lost reply, `abort_page_upload` discards); `gbrain put --file` and `gbrain capture --file` use it on remote brains |
| Editing a page stored in segments | the edit read the whole page back | only the segments the match touches are rewritten; `within` restricts a match to a range a window read returned |
| A local `put --file` or `capture --file` over 24 MiB | read into memory whole | streamed in |

### What to watch for after you upgrade

- An upload session belongs to the connection, source and page that began it; any other caller gets `upload_not_found`. Staged bytes count against the `persistence.limits` upload quotas (`write_quota_exhausted`), and an idle session expires after an hour.
- Appends, segmented edits and upload commits from agents go through the same write gate as put_page, so the same text gets the same content flag.
- A remote replace upload over 24 MiB of a page that has a takes fence or timeline entries is refused with `upload_protected_content` (pass `drop_timeline` to replace a timeline deliberately).
- `gbrain append` sends one direct call when the text fits the connection's request limit and an upload session above it; `--expect-tail`, `--region` and `--separator` apply only to the direct call and are refused above it.

### Itemized changes

- New operations: `append_page`, `begin_page_upload`, `upload_page_part`, `get_page_upload`, `commit_page_upload`, `abort_page_upload`; new error codes `tail_changed`, `part_too_large`, `part_splits_code_point`, `upload_protected_content`.
- `edit_page` accepts `within`; a stale `within` refuses `revision_conflict`. On a segmented page an ambiguous match reports `match_count_at_least=2`.
- New CLI command `gbrain append <slug> [--file f | stdin]`.
- A `since: 'TBD'` BEHAVIOR_CHANGES row can no longer ship: `bun run check:behavior-since` (in `bun run verify`) refuses one on a stamped tree or master, `bun run release:restamp` stamps them, and the Release workflow refuses one before publishing.

## [0.60.322.0] - 2026-10-20

**The full Ubicloud gate stops oversubscribing its VMs, and every gate now reports how loaded they were.** Each gate slot runs a bun process, its children and its own PostgreSQL and PgBouncer, about 2.5 runnable threads, so one slot per two vCPUs ran a 16-vCPU VM at a 1-minute load of 1.39 per vCPU at p90. Timing-sensitive files then ran up to twice their usual time, and `persistence-sync-options-parity` hit `run-e2e.sh`'s 180 s per-file cap.

### What changed

| Situation | Before | Now |
|---|---|---|
| Slots per standard-16 gate VM | 8 (one per two vCPUs): load p50 1.11, p90 1.39 per vCPU, 45,565 s of test compute, the parity file killed on its PgBouncer pass | 6 (three per eight vCPUs): p50 0.79, p90 0.95, 35,393 s, passed; about the same wall time at eight VMs |
| Seeing VM load | inferred from timing flakes and shard overruns | each item's log ends with the VM's load; the summary prints p50, p90 and max per vCPU and warns above 1.1 at p90 |

## [0.60.321.0] - 2026-10-20

**With Git durability on, a page edit or delete on a source whose root sits below its Git repository's top (a brain in `<repo>/brain`) is now committed and pushed.** Before, the Git effect read file lists from Git with two different bases: `git ls-files` printed paths relative to the source root, while `git status` and `git diff --cached` printed them relative to the repository top. An edit to an already-tracked page, and every page delete, therefore completed as `unchanged`, and nothing was committed or pushed. Writer status and doctor showed nothing pending. A source whose root is the repository top was not affected.

### What changed

| Situation | Before | Now |
|---|---|---|
| A page edit or delete on a durable source whose root is below the repository top | completed `unchanged`; nothing was committed or pushed | committed and pushed like any other change |
| A URL-cloned source (`trackedChanges`, url-clone fence repair) whose root is below its clone's top | modified tracked files could be missed | every listing uses the source root's base (`--relative`) |
| A durable checkout below the repository top that is ahead of its upstream | doctor `git_convergence` never matched it to its binding | warns `stranded`, as #7089 added for a root at the top |
| Tracked files modified under a durable source root with no Git effect queued, running or parked | not reported | doctor `git_convergence` warns (`stranded`, listing them in `uncommitted_pages`); its fix asks you to commit them, then push |

Edits that earlier releases left uncommitted on such a root stay in the working tree. The new doctor warning lists them so you can commit and push them. No schema migration.

Reported by @mje-xyz (#7091), who also traced the mismatched path bases.

## [0.60.320.0] - 2026-10-19

**A managed `gbrain sync` of an ordinary (non-company) source now compares the files at HEAD with what the brain holds, instead of replaying commits, so a reset, a revert, a rewritten history or a lost run can no longer leave pages behind, and one bad file holds only itself.** Each pass reads the committed tree, the index and the database, admits only the files whose page differs, proves nothing moved underneath it, and records the checkpoint inside the last import's own transaction. An idle sync with nothing new returns in well under a second.

### What changed

| Situation | Before | Now |
|---|---|---|
| History rewritten, reset or reverted, or a sync interrupted | replayed `last_commit..HEAD`; pages could be missed or resurrected | every file at HEAD is compared with its page and import record; what differs is admitted |
| An idle sync with nothing new | about 3 s on a large Postgres brain (57 ms round trips) | about 0.75 s: no level read at all |
| One odd file (unreadable, a NUL byte, a broken alias list, a page whose identity changed, a write that fails) | stopped the whole source | that file alone is held with its own code and fix; the rest syncs |
| The checkpoint after an import | its own write request and transactions | carried by the round's last import publication (fewer statements and transactions per run) |
| First sync after activating a classic brain with 100k pages on Postgres | did not finish | converges in one pass (about 45 s) |
| A sync that would delete more than half of a source's pages | ran | refused until confirmed, as `repair ghost-pages` already does |

### New for operators

- `gbrain repair file-drift --held --side <side> [--state <state>]` resolves held file-drift pages one decision at a time.
- `gbrain repair legacy-twins --source <id>` merges page pairs an older gbrain forked from one file (preview first, then `--apply --expect <hash>`).
- `sync.admission` (`normal`, `imports_only`, `classify_only`) narrows what a managed sync admits; doctor warns while it is restricted.
- `gbrain sync status --json` reports `convergence` for a managed source.

No schema migration. Company-brain sources keep their existing sync path.

## [0.60.319.0] - 2026-10-19

**The native data-safety step's per-suite stall bound now fits each target, so Windows stops killing a backup suite that was passing.** v0.60.317.0 bounded every suite at 300 s, which was calibrated on darwin-x64; on Windows `backup-portability-native` legitimately runs 3.5 to 8 minutes, and one run was killed at 301 s with every test passing.

### What changed

| Situation | Before | Now |
|---|---|---|
| A native data-safety suite on win32-x64 or win32-arm64 | killed at 300 s even when healthy (p99 462 s and 303 s) | bounded at 540 s and 390 s |
| The bound on every other target | one 300 s number | the slowest suite's measured p99 plus max(60 s, 15%), rounded to 30 s: 120-180 s on Linux and macOS |
| A matrix target with no bound | n/a | the step fails before running any suite |
| The stall message | said files take "under 60 s" | names the target's bound; the process table and macOS stack sample are unchanged |

## [0.60.318.0] - 2026-10-20

**On large Postgres brains, autovacuum can finish again, and a page delete's Git commit now reaches the remote.** gbrain refreshed `content_chunks` statistics after every embed drain and import. That ANALYZE waited for the table's lock, and Postgres cancels an autovacuum whenever another session waits on it for a second, so on a brain of about 10M chunks no autovacuum of the table ever finished: millions of dead rows stayed in every index, the vector index included. Separately, on a managed brain with Git durability on, a page delete whose first push failed left its removal commit local-only, while writer status and doctor reported nothing pending. Reported by @DaCal90 (#7083) and @MMichot (#7089).

### What changed

| Situation | Before | Now |
|---|---|---|
| An ANALYZE gbrain runs on Postgres (import, sync, reindex and embed refreshes, the search guard, `gbrain repair planner-stats --apply`, the ANALYZE after a migration builds an index) meets a running vacuum | waited up to 2 s, and Postgres cancelled the autovacuum after 1 s | takes the table's lock with `NOWAIT` and defers at once with a warning; the autovacuum keeps running (the repair reports the table `deferred`) |
| An embed drain that embedded a few chunks of a large, already-sampled `content_chunks` | a 2 to 6 s ANALYZE after every drain | skipped below 50 + 10% of the table's chunks; autovacuum's own analyze covers what small drains add up to, and missing statistics still refresh |
| A hot table of at least 100,000 rows whose autovacuum keeps being cancelled | noticed only from the server log | `gbrain doctor` `planner_stats_stale` warns when its dead rows pass the vacuum threshold and no vacuum has completed in 24 h |
| A page delete on a managed brain whose first push failed | the retry found nothing to commit and completed without pushing; the branch stayed ahead | the retry pushes while the checkout is ahead of its upstream; a push that keeps failing stays queued and then parks, visible in writer status |
| A managed checkout with Git durability on that is ahead of its upstream with no Git effect pending | doctor `git_convergence` warned only after 6 h | warns at once (`stranded`), with `gbrain git commit-push --push-only --keep-checkout --path <root>` as the fix |

## [0.60.317.0] - 2026-10-19

**Two CI flakes are closed at their source, and a stuck native safety suite now leaves a log instead of a silent timeout.** `test-reads-source-smell` failed with `ENOENT` when `import-file.test.ts` removed its scratch directory from `test/` mid-walk; scratch now lives in the system temp directory and a lint rule keeps it there. The native data-safety suites no longer wait inside `Bun.spawnSync`, where Bun 1.4.0 to 1.4.2 can poison a process (oven-sh/bun#34069).

### What changed

| Situation | Before | Now |
|---|---|---|
| A unit test needing a scratch directory | `import-file` and `files` made theirs inside `test/`, racing `test-reads-source-smell`'s walk (15 of 82 probe runs failed) | both use `mkdtempSync(join(tmpdir(), ...))` (0 of 79); `check-test-isolation` rule R8 refuses a new scratch path inside the test tree |
| `persistence-sync-origin-native` and `export-publication-native` on Bun 1.4.0 | 21 untimed sync `git` calls and four sync child runs, each a window for the spawnSync poisoning that spins every later test to its 180 s deadline | every child process is awaited, with the same assertions |
| A native data-safety suite that stalls | ran until the 15-minute job timeout, which kept no log | named, its process table and (macOS) a native stack sampled, and killed at 300 s; the step fails |

## [0.60.316.0] - 2026-10-19

**A commit is searchable within about a second whenever any gbrain process is running, and a sync request is never dropped.** Before this, only `gbrain serve` watched for commits: managed sources only, after a 3 s debounce, and a wake could be lost. Classic sources never synced on commit, a lone `gbrain jobs work` took 5 s, and the autopilot daemon waited for its next wall-clock tick (up to 7 minutes). `sync.on_commit` is still off by default.

### What changed

| Situation (10k pages, n=10) | Before (p50 / p95) | Now (p50 / p95) |
|---|---|---|
| `gbrain serve`, managed source, commit to search | 3.7 / 4.1 s | 0.6–0.7 / 0.9–1.1 s |
| `gbrain serve`, classic source | never synced | 0.6–1.1 / 0.7–1.1 s |
| only `gbrain jobs work` running (Postgres) | 5.0–5.3 / 5.1–5.5 s | 0.6–0.7 / 0.8 s |
| only the autopilot daemon (classic, on_commit off) | 266 / 406 s | 84 / 138 s |

The other changes:
- **One commit notifier per host.** It runs in `gbrain serve` (stdio and http), `gbrain jobs work` and the autopilot daemon, with one owner per host and brain. It watches classic sources this host synced as well as managed ones, and starts a sync as soon as the checkout is quiet.
- **Retries instead of drops.** A failed or refused sync is retried at 5 s, 15 s, 1 min and 5 min, then reported as `notifier_stalled` with the fix and a trace file.
- **Requests are recorded first.** `gbrain sync trigger`, webhooks and busy delegated syncs record a wanted marker before they run. Whoever drains the source re-checks it afterwards, so a request is never lost to a sync already running. `sync trigger --json` reports queued, coalesced or nudged, and adds a `no_resident` notice with the fix when no resident runs. A managed push webhook answers 409 `refresh_required`.
- **HEAD-driven autopilot.** The daemon dispatches when a checkout's HEAD moves past the last synced commit, with the wall-clock rule kept as a backstop. Its `--status` grades from a new heartbeat sidecar (#7003).
- **Worker boot.** On Postgres, `gbrain jobs work` starts the persistence consumer at boot through the existing election (#7002). An idle worker wakes on a queued sync, using LISTEN on a direct session and a 1 s poll behind a pooler.
- **Visibility.** `gbrain sync status` and the new doctor check `commit_notifier` name the resident that syncs each source, or say none is running and give the fix. Once a resident has run, or `sync.on_commit` is on, search and query responses carry a per-source `freshness` entry (current, behind, syncing, unknown or not_monitored).
- **Upgrade.** Migration v262 adds `sync_wanted_markers`, `sync_notifier_sources` and `sync_notifier_leases`.

Docs: `docs/guides/on-commit-sync.md`. `GBRAIN_NOTIFIER=0` turns the notifier off for a process.

## [0.60.315.0] - 2026-10-19

**Large pages stored in segments get the last of their hardening: a repair for canonical files older versions left holding withdrawn rows, a bounded retry budget for writes the database interrupts under load, and purges that leave no segment text behind.** Brains that ran a gbrain older than v0.60.299.0 with `pages.segmented_storage` on can now find and rewrite canonical files that still hold a withdrawn or purged row with `gbrain repair segmented-mirror`, preview first. A write the database cancels at a statement timeout, or that the owner cancels past the publication ceiling, now retries with backoff against its own budget instead of failing at the second interruption or retrying without limit. Upgrading adds two columns to `persistence_requests` (migration v261, no rewrite of existing rows). Nothing runs on upgrade.

### What changed

| Situation | Before | Now |
|---|---|---|
| A segmented page's canonical file still holds a row an older gbrain withdrew (the mirror skipped it with `page_body_segmented`) | nothing found or fixed it; upgrading did not rewrite the file | `gbrain repair segmented-mirror [--source <id>]` lists each such file with its SHA-256 and the page's canonical render, `--apply --expect <hash> --yes` rewrites it through the withdrawal mirror with a receipt per page; a file or page that changed since the preview refuses `preview_changed` and is left as it is |
| A statement the database cancels (57014), or a publication cancelled past `persistence.publication_ceiling_ms` | failed `write_interrupted` at the second cancel, or (ceiling) was published again without limit | counted against `persistence.max_transient_retries` (default 5, 0 to 20) with a 1 s, 2 s, 4 s, 8 s, then 15 s backoff stored on the request; `gbrain sources writer status` names the waiting head `transient_backoff`; past the limit it ends `write_interrupted` with the cause and SQLSTATE in its receipt |
| A grouped publication (`put_pages` batch, managed import batch, sync lane group) interrupted as a whole | every member re-formed the same group and could fail together | each member is charged, and a member already charged publishes on its own from then on, so the batch still commits page by page |
| A publication or withdrawal-mirror recovery record of a version this gbrain does not know | could be read as an older record: a mirror recovery published its bytes and cleared the record | refused `recovery_version_unsupported` before anything reads it; the record and files stay as they are and the fix is `gbrain upgrade` on the owner host |
| A withdrawal on a segmented page while a gbrain below the segmented writer floor still writes to the brain | the mirror wrote a version 2 recovery record the older gbrain cannot read, which could wedge the worktree | the mirror refuses `segmented_mirror_writer_gate` and parks; it runs again by itself once the older writer is upgraded and out of the 7-day window |
| A withdrawal in a facts fence of more than 16,384 rows that crosses a forced segment cut | refused `withdrawal_capacity` with a generic message | still refused (the bound is unchanged), with reason `split_fence_rows`, the page, the row count and a fix to split the fence |
| `delete_page purge: true` of a segmented page after a withdrawal and another write | left the old fence text in `page_segment_texts` until the hourly sweep, and the receipt said done | deletes every unreferenced segment text holding one of the page's claims, plain or as a fence cell stores it, in the purge; `purge_fact` of a claim containing `|` does the same; a text an unpublished write still needs is kept |

### For contributors

- New pathological regressions in `test/pathological/`: `lp-a` through `lp-h` and `c22-stuck-recovery-large-file` (the C-22 todo in `inventory-deferred.test.ts` is now a real test), each run on PGLite and Postgres.
- `test/e2e/publication-deadline-group-postgres.test.ts` now waits out the charged backoff before it publishes the cancelled group again.

## [0.60.314.0] - 2026-10-19

**A master-red incident closed by hand stays closed, and a master push that reused a full run is judged by that run.** Nightly-watch opened a false master-red (#7056) after a maintainer closed the real one by hand: the incident's newest block was still red, a re-run-failed-jobs attempt left an incomplete manifest, and pushes that reused a full run carried no manifest of their own, so nothing could ever clear it. A full `ci:ubicloud` gate now runs only in `eu-central-h1`, where test timeouts and shard weights are calibrated.

### What changed

| Situation | Before | Now |
|---|---|---|
| A master-red incident closed by hand while its newest block is red | the next rebuild opened a fresh incident carrying the stale note | the incident ends green with `closed_by_hand` recorded; a later run whose latest attempt is red still opens a new incident |
| A master push that reused a passed full run | judged incomplete (it has no ci-manifest), so it could never clear an incident | judged by its source run's complete evidence: `reuse.json` checked with the release gate's record check, identical trees, and the source attempt's ci-manifest |
| A full `ci:ubicloud` gate with `--location` other than `eu-central-h1` | ran, and its timing failures read as test failures | refused before any VM is requested; `--lanes` runs a diagnostic subset elsewhere, whose summary says it is not gate evidence |

## [0.60.313.0] - 2026-10-19

**Unit shards in a full Test run cost about 29% less, the macOS 26 nightly typecheck no longer times out, and test paths survive a checkout directory with a space in it.** Each 4-vCPU runner now runs two unit shards at once (22 shards on 11 runners, re-mined from a green packed run, each within the unchanged 600 s budget). The `ci:ubicloud` gate plans its unit shards from the same partition, weights and budget.

### What changed

| Situation | Before | Now |
|---|---|---|
| The unit lane of a full Test run | 18 shards on 18 runners | 22 shards on 11 runners, two per runner (`scripts/test-shard-pack.sh`), each with its own coverage, receipts and log; lane names, coverage manifests and per-shard artifacts are unchanged in kind |
| The `ci:ubicloud` unit check | its own 1,260 s budget against measured time, so a slow fleet failed a gate whose tests all passed | the same `unitShardPlan` and `UNIT_SHARD_BUDGET_MS` as GitHub; measured time is printed beside the plan for drift |
| macOS 26 validation | typecheck ran inside verify and was killed at the 240 s cap (#6056) | typecheck has its own job with a measured 15-minute step timeout and its state saved on every outcome |
| A test resolving a file URL with `.pathname` | broke in a checkout path containing a space (#6845) | 42 test files use `fileURLToPath`, and `check:file-url-pathname` fails verify on a new one |
| An index-lock reclaim meeting this user's own exiting git | a cwd or environ read that failed while the git exited was taken for another user's process, so the reclaim refused | the read is re-checked within `RECLAIM_MIN_AGE_MS`; another user's git, or an alive one that stays unreadable, still fails the proof |
| Tier 2 when provider keys aren't passed to the test process | the notice said it ran keyed | it says "provider keys not passed (GBRAIN_TEST_KEEP_PROVIDER_KEYS unset)" |

## [0.60.312.0] - 2026-10-19

**Fix wave 20: about thirty answers that were quietly wrong are now right.** Recall honours every filter you give it, think names the model that actually answered, doctor and the advisor stop calling stale or failed checks healthy, `embed --max-usd` respects your own prices, Katakana names stop matching inside longer words, `get_links` pages instead of returning everything, and a disabled Gmail API is reported as what it is. Thirty-one contributor fixes were rewritten on master and credited. Nothing here adds a paid call or a migration.

### What changed

| Situation | Before | Now |
|---|---|---|
| `recall --entity X --session Y` without `--since` | the session filter was dropped | both filters apply before the limit |
| `recall --since <garbage>` or an empty `--session` | silently recalled everything | refused `invalid_params` with the accepted forms |
| `recall --since-last-run` with more new facts than `--limit` | the overflow was never shown | the next run continues where the last one stopped |
| `think` answered by a `chat_fallback_chain` model | reported, priced and saved the model that failed | names the model that answered, plus `requested_model` |
| advisor backup coverage with expired or future-dated evidence; a collector that fails to read | read healthy | warns, or reports `collector_failed` |
| `embed --max-usd` with a model priced by `gbrain pricing set` | stopped with `no_pricing` | uses your price |
| A known price with no context ceiling | `no_pricing` | `no_context_ceiling`, naming the model |
| `config set chat_model` while config.json or an env var pins it | said it worked | warns that the write is shadowed; `config unset <key> --file` clears the pin |
| A Katakana alias inside a longer Katakana word; a page titled with one generic word | created a mention link | no link; `MENTION_EXTRACTOR_VERSION` 7 rescans mentions once |
| `get_links` / `get_backlinks` on a hub page | every row, unbounded | 500 by default (max 5000) with `truncated` and `next_cursor`; `--all` on the CLI |
| Gmail API disabled in the OAuth project | `connector_account_changed` | the credential refusal with its fix |
| `dream --drain` stopped by a provider outage | exit 11, help said 3 | transient failures retry (11); permanent ones and no progress exit 1 naming the blocker |
| `extract links --source db` reaching a page whose source has no row | aborted the run | defers and names the page; the run continues |
| Codex "always allow" on a gbrain tool, then `connect --install --fresh-token` | refused `configuration_conflict` | keeps your approvals |
| A meeting that hasn't happened yet | got "Discussed in" timeline rows | rows are added once it has ended |
| A fact longer than the embedding input | coverage claimed for text never embedded | reported as partially embedded; nothing re-embeds |

Every user-visible change is listed in the upgrade notice. Contributed by @javieraldape, @tarush1989, @spiky02plateau, @akinduroifedayo, @johnerik, @troyhoffman-oss, @Masashi-Ono0611 and @Kkkkkuro.

## [0.60.311.0] - 2026-10-19

**The dream `consolidate` phase no longer silently supersedes a real fact when two typed statements of one metric share an effective time, and the facts an earlier run closed that way can be reopened.** Fixes the residual case of #6023.

### What changed

| Situation | Before | Now |
|---|---|---|
| A consolidation cluster holds two typed facts with the same metric, unit and period at the same effective time (an amount and its correction recorded on one day, or one statement stored twice) | the higher-confidence one became the take and the other got a `valid_until` equal to its own `valid_from`, a zero-length validity that marked a real fact superseded | the cluster is left unchanged. The phase reports `warn` with `details.clusters_held_same_instant` and `details.same_instant_clusters`, each with the fact ids and a next step: ask which statement is current, then `gbrain forget` the other. The managed path holds it before admission, and an intent an older release admitted publishes nothing |
| Facts an earlier run closed at their own instant | no supported way back | `gbrain repair consolidate-ties` lists them with their tied partners and take; `--apply --expect <hash>` reopens exactly the previewed facts. It never runs on upgrade |

A typed series at distinct times still consolidates with its chronological writeback.

### What you need to do

Nothing. If `gbrain dream` reports held clusters, answer the question it relays. To check for facts an earlier run closed, preview `gbrain repair consolidate-ties`.

Contributed by @Kkkkkuro (report and reproduction on #6023).

## [0.60.310.0] - 2026-10-19

**On Postgres, a brain no longer keeps a copy of its last big read in memory on every database connection.** After a query that returned a large row, such as a 1 MiB piece of a segmented page, each pooled connection held on to it until that connection ran another query. That was about 2 MiB of raw network buffer plus the query's whole result. A worker with a pool of 10 could sit on 30 MiB it no longer needed. Idle connections now hold nothing from their last query. PGLite brains were never affected.

### What changed

| Situation | Before | Now |
|---|---|---|
| A pooled Postgres connection after a query whose reply spanned several network reads | kept the joined receive buffer (about 2 MiB for a 1 MiB `bytea` row, which arrives as hex) until its next read | drops the buffer once every message in it is handled |
| A pooled Postgres connection after any query | kept the whole query, and through it the query's full result rows, for the desync tripwire's diagnostic | keeps only the statement's text, which is all the diagnostic prints |
| A pooled Postgres connection that closed under a statement (a terminated backend, a pooler restart, a stuck or desynced connection) | kept that statement, with its parameters, until the pool gave the connection another one | keeps nothing |
| Reading a segmented page body on a pool of 4 | up to about 12 MiB held after the read finished (one segment's buffer and rows per connection) | 1 to 2 MiB of ordinary heap noise |

### For contributors

- `vendor/postgres` (ESM, CommonJS and workerd copies) and `patches/postgres@3.4.9.patch` carry the three changes; `bash vendor/update-postgres.sh --check` verifies them, and `vendor/README.md` describes them. `test/e2e/postgres-driver-idle-retention-postgres.test.ts` pins each one: a 4 MiB row or parameter leaves under 2 MiB behind, where the old driver kept 4 to 12 MiB.
- `test/large-pages/segmented-prior-view.test.ts` stops flaking on the Postgres arm. Its heap check failed now and then (5.8 MiB held against a 5.5 MiB bound) because the warm-up and the measured call left driver buffers on different pooled connections. The test now runs one small statement on every pooled connection before its baseline, so a driver that keeps its receive buffers fails it every run. The bound is unchanged.

## [0.60.309.0] - 2026-10-19

**Classic sync no longer stops, or quietly drops a file, when one file is strange: it holds that file, names the fix, imports the rest and moves the bookmark.** Symlinks, unreadable files, FIFOs, files missing from a sparse checkout, names that aren't valid UTF-8 and renames whose old title the database can't compare each used to block a source for three runs or vanish without a word. A force-pushed upstream is now a typed refusal with a guarded fix instead of a raw Git error, and five smaller errors that stopped sync for good are fixed.

### What changed

| Situation | Before | Now |
|---|---|---|
| A symlink, FIFO, device, unreadable (EACCES/EPERM) file or symlink loop in a classic source | blocked the source for three runs, then auto-skipped it, or dropped it silently | held `file_unreadable` with a typed reason and fix; the rest imports and the bookmark advances; re-screened every run |
| A committed file missing from the checkout (sparse checkout, deletion not committed) | treated as deleted after the pin and dropped silently | held `absent_from_worktree` (`skip_worktree` or `deleted_locally`) |
| A file name that isn't valid UTF-8 or holds a tab or newline | decoded lossily and checkpointed as deleted, or skipped with a log line naming no path | read as bytes and held `unsupported_path`; the fix renames it without putting the name in an argv |
| A gitlink (submodule) in the range | left unindexed with nothing said | reported once as `gitlink_not_followed` |
| A rename whose old title or id holds a NUL byte or broken Unicode | stopped the source | held `rename_identity_unreadable`; an old page that can't be removed is held `rename_reconcile_failed` |
| A force-pushed or diverged upstream on a classic pull | a raw Git error on every run | `upstream_rewritten` or `upstream_diverged` with both commits, and `gbrain sources reset-upstream <id> --expect-local <sha> --expect-upstream <sha>`, which acts only while both still match |
| A stored page an older gbrain validated that expands past the S-47 alias bound | stopped its source as `sync_parser_regression`; advice said to pin the last good version | held alone as `frontmatter_alias_limit`; advice never suggests pinning a release older than 0.60.305.0 |
| A keyless brain | queued embed-backfill jobs that failed | queues none; one already queued ends once as `embed_backfill_skipped` |
| A managed sync job submitted without pull options | failed permanently | imports HEAD |
| A mention whose target isn't a valid slug (#7008) | failed the links effect | skipped before locking |
| `gbrain backup check` on a big dirty tree or slow remote (#6907) | over 1 MiB of status read `probe_failed`; a fixed 2 s remote timeout looked like a missing backup | reads dirty; `backup.remote_timeout_ms` (0.5–30 s); a timeout is counted in `totals.remote_timeouts` and named as one |
| Managed dream synthesis after upgrading from pre-managed mode (#6924) | re-synthesised old transcripts | counts a completion while its dream-generated page still exists in the same source |

`sync.holds=fail` keeps the old fail-closed classic behaviour. Docs: `docs/guides/write-refusals.md`, `docs/guides/sync-unblock-runbook.md`.

Contributed by @tarush1989, whose #6950 and #6951 found the pre-managed synthesis gap.

## [0.60.308.0] - 2026-10-19

**The PostgreSQL arms lane of a full Test run costs about 43% less, and every listed test file still runs on PostgreSQL.** Each arms job now runs two files at once, each against its own Postgres service (11 shards instead of 19). The Bun 1.4.3 cell runs only the PostgreSQL side of files that use `testBackends()`, because their PGLite side already runs in the unit and serial lanes on that Bun.

### What changed

| Situation | Before | Now |
|---|---|---|
| An arms job | one file at a time, 19 shards per Bun cell | two files at a time on separate Postgres services, heaviest first, 11 shards; each file's output prints whole in its own group with an `ARM_FILE … ms=` line the weight miner reads |
| The Bun 1.4.3 arms cell | both backends of every listed file | the PostgreSQL side of `testBackends()` files (`--postgres-only`); files that read `DATABASE_URL` directly keep both; the Bun 1.4.0 cell is unchanged |
| Proving a test still ran after moving lanes | receipts tagged only the arm, so a PGLite test leaving a cell looked like a drop | identities carry the backend the test pins; a PGLite test may move to another arm, a PostgreSQL test only to another database arm; receipts carry the real shard count (shards 9–19 were never checked) |
| A test that restored a saved `process.exitCode` of `undefined` | the earlier exit code stayed set, so a run could exit 1 with every test passing | 24 sites restore `?? 0`, and a scan fails on a bare restore |

## [0.60.307.0] - 2026-10-18

**A token scoped to one source can no longer read other sources' data through `gbrain remote doctor`.** Fifteen remote doctor checks ignored the caller's source grant, so a source-bound token saw other sources' ids, names, sync lag, embed coverage, failed jobs and page counts (directly, or by subtracting its own share from a brain-wide total). Every check now reads only the sources the token is granted. Local `gbrain doctor` and unscoped admin callers see exactly what they saw before.

### What changed

| Situation | Before | Now |
|---|---|---|
| `federation_health` for a scoped token | every source's id, lag, embed coverage and failed-job count | only the granted sources; the "single-source brain" shortcut is skipped because it revealed whether other sources exist |
| `sync_freshness` for a scoped token | named other sources (id and display name) and put them in its fix commands | only the granted sources |
| `sync_consolidation`, `links_extraction_lag`, `graph_signals_coverage`, `hidden_by_search_policy`, `link_resolution_opportunity`, `embedding_migration_state`, `schema_pack_source_drift` | brain-wide counts, ratios and samples | counted over the granted sources; `links_extraction_lag` grades each granted source and reports the worst |
| `contextual_retrieval_coverage` synopsis failures, `brainstorm_health`, `calibration_freshness`, `voice_gate_health`, `abandoned_threads`, `grade_confidence_drift` | read every source's audit events, calibration profiles, takes and grades | read only the granted sources' rows |

Contributed by @Masashi-Ono0611, who spotted the `federation_health` leak in #6914.

## [0.60.306.0] - 2026-10-18

**A pull request now runs a cheap CI tier on each push, and the full suite runs once on the head before merge. A master push whose tree already passed the full suite doesn't run it again, and leaked gate VMs now expire.** A pull-request push cost about $1.77 in Test and E2E; it now costs about $0.03–0.23 (Test only, more when the diff touches persistence or native code). The full run happens once, at handoff, and the push to master reuses it.

### What changed

| Situation | Before | Now |
|---|---|---|
| A push to a pull request | the full Test matrix (18 unit shards, serial, slow, both PostgreSQL arms) and diff-selected E2E | the cheap tier: `verify`, `typecheck`, `gitleaks`, security regressions, dependency audit, the stress gate on changed tests, and the crash robot, convergence and native cells when the diff selects them; `cheap-tier (full suite not run)` says so; no E2E |
| Running the full suite on a pull request | every push | the maintainer-only `full-ci` label (`full-ci.yml`) or a hand dispatch runs Test and E2E on the head, with the same shape as a push to master, and again on every later push while the label stays |
| What merge reads | `test-status` / `e2e-status` from the pull-request run | `full-suite` and `e2e-full-suite`, which succeed only when their run's aggregate did; a pull-request run can never produce either |
| A push to master whose tree equals a passed full-suite run's | ran everything again | reuses that run (`scripts/ci-reuse.ts`), records it, and the release gate checks the record; any doubt runs in full |
| A `ci:ubicloud` gate VM a sleeping machine never tore down | lived for days | is named to expire after 2 hours; `scripts/ubicloud/reap-expired.ts` (dry run by default) lists and, with `--apply`, destroys expired gate VMs across owners, never legacy or untagged names |
| The gstack pregate remote stage | a full `ci:ubicloud` | `ci:ubicloud:diff`; one full gate per PR, at handoff |
| Watching CI spend | by hand | `scripts/ci-cost-ledger.ts` prices each week's Actions runs against `scripts/ci-cost-baseline.json` in the CI health report |

Docs: `docs/ci-event-parity.md#full-ci-on-pull-requests` and `#master-push-reuse`, `docs/RELEASING.md#release-ci-gate`, `scripts/ubicloud/README.md`.

## [0.60.305.0] - 2026-10-18

**A few hundred bytes of crafted frontmatter can no longer take down your brain.** YAML lets a value refer back to another value, and nesting those references multiplies them: a 432-byte page sent through `put_page` used to expand into gigabytes in memory and crash a PGLite brain, and a committed file like it could kill `gbrain sync`. Any caller with write access could do it, including a remote agent over MCP. gbrain now measures how far a frontmatter block would expand before it uses it, and refuses one that would grow far past its own size.

### What changed

| Situation | Before | Now |
|---|---|---|
| `put_page` / `edit_page` with frontmatter whose YAML aliases expand past the limit | stored the expanded value (681 KB from 324 bytes, 6.1 MB from 378 bytes) or ran the database out of memory (432 bytes) | refused `invalid_frontmatter`; nothing is written |
| `gbrain sync` reaches such a file (classic or managed) | stored it whole, or the process was killed for running out of memory | the file is held `invalid_frontmatter` with a message naming the alias limit and its line; every other file keeps syncing |
| Ordinary anchors and merge keys (`<<: *defaults`) | read | still read: a block may expand up to its own length plus 64 KiB |

### What you need to do

Nothing. Real frontmatter stays far below the limit. If a file is held for it, replace its anchors and aliases with plain values, commit, and run `gbrain sync --source <id> --no-pull`.

### Itemized changes

- `loadBoundedYaml` in `src/core/data-frontmatter.ts` is the only js-yaml `load` in `src/`. Every frontmatter, skill and manifest parse goes through it: `data-frontmatter`, `markdown`, `brain-writer`, `frontmatter-recovery`, `skill-frontmatter`, `shared-skills/manifest`, `skill-catalog` and `sync-rename-identity`. After loading, it sizes the value as if every alias were copied out (a shared node is measured once, a cycle counts as unbounded) and throws `YamlAliasBoundError`, shaped like a js-yaml parse error, past the text length plus 65,536 characters, before anything serializes the value.
- Tests: `test/pathological/s-47-yaml-alias-bomb.test.ts` (remote `put_page` and `edit_page` through MCP dispatch, classic and managed sync, and a 9-level parse-time guard) and its Postgres arm `test/e2e/s-47-yaml-alias-bomb-postgres.test.ts`.

## [0.60.304.0] - 2026-10-18
