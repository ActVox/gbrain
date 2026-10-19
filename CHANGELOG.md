# Changelog

All notable changes to GBrain will be documented in this file.

Historical entries use generic identifiers for the retired hosted provider
and its removed commands.
Those identifiers and any sample command containing them are non-executable
archival labels, not supported configuration. Dates, measurements and contributor
credits are retained; no result has been reassigned to another provider. Original
identifiers and attribution are available in the pre-removal Git revision
`6040075c6cb95be5881cc2e1b76ef7d71f4e5d29` (retained on 2026-09-23).

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

**A re-extraction that comes back empty or partial no longer deletes what the earlier run found, and a page write's Git backup no longer gets stuck when another machine pushed first.** On a managed brain, a model that honestly answered `[]` for an edited page retired every atom that page had produced (#7013). The same thing happened when a batch was published only partly, to Life Chronicle events, and to conversation facts. Separately, a Git effect whose push met a moved remote failed `git_push_unavailable` on every attempt and parked after five, leaving the page commits on that one machine (#7010).

### What changed

| Situation | Before | Now |
|---|---|---|
| A managed atom re-extraction returns `[]`, fails, or read only part of the page | every prior atom of the page was retired (`retired_by: managed-reextract`) | nothing retires; the page's scan state still advances, so the same text is not paid for again |
| A managed atom batch publishes only some of its new atoms (one conflicts) | the batch's retirements of the old atoms still committed | a retirement waits until every replacement page of its run has committed; until then the old atom stays live |
| `gbrain repair stale-atoms` after a zero-yield extraction | listed the kept atoms as `origin_changed` | an atom is `origin_changed` only when the current text's extraction produced a live atom |
| A Life Chronicle re-judge returns no events, drops or caps proposals, or reads a truncated body | the page's earlier events were retired | they stay live; a complete, clean replacement and a page that stops being chronicle-shaped still retire them |
| A conversation-fact re-extraction finds nothing, finds the page not extractable, runs with `--since` or `--segment-limit`, has rows held by the write gate, or fails partway (unmanaged) | every prior extractor fact of the page was deleted or expired first | prior facts stay; the outcome row still advances, a `--since` window adds its facts beside them, and only a complete non-empty run replaces them; the unmanaged path buffers and publishes once at the end |
| A Git effect's push is rejected because the remote moved | `git_push_unavailable` forever, parked after five attempts | the push runs `gbrain git commit-push --push-only --keep-checkout`, which merges the remote in memory and pushes without moving the checkout (`gbrain sources refresh` stays the only importer) |
| Both machines changed the same page file | indistinguishable from a network failure | the effect holds `integrate_conflict` with the user's choice as its fix (`--keep-checkout --resolve <path>=<ours\|theirs>`) |
| Git effects already parked on a push | needed `--pat-file` or one `retry-effects --request-id` per write | `gbrain sources writer retry-effects <source> --parked-pushes [--dry-run]` retries them all; it also covers `push_unconfirmed` and `integrate_conflict` |
| Atoms a zero-yield managed re-extraction already retired | gone from search, and the purge removed them after 72 hours | doctor `atom_retirements_restorable` counts them per source; `gbrain repair atoms-restore` previews exactly the latest retired generation of each still-live origin that nothing replaced, and `--apply --expect <hash>` restores them with a receipt per atom; the purge keeps those tombstones for 30 days so there is time to decide |
| Finding stuck Git backups | per-request lines in doctor `parked_effects` only | doctor `parked_effects` and `gbrain sync status` (`git_push_holds`) show, per source, how many are retrying or parked, any conflict, and the one fix; `sync status`'s `next` falls back to it |

### What you need to do

Nothing for new runs. Nothing is restored on upgrade. If doctor warns `atom_retirements_restorable`, preview with `gbrain repair atoms-restore --source <id>` and apply with the printed hash once you agree. If doctor shows `git_push_holds`, run the fix it names; a conflict asks you which version wins.

**Say to your agent:** *"Check whether my brain lost atoms to an empty re-extraction and show me what restoring them would bring back."*

**Say to your agent:** *"My brain's Git backups stopped pushing. Find out why and get them moving again."*

Long Chronicle pages (over 12,000 characters) and segmented pages no longer retire stale events on re-extraction, because the judge never reads their whole body. Their earlier events stay visible instead of being lost.

### For contributors

- New pathological cases `test/pathological/h1`…`h4` (atoms, Git effects, Chronicle, conversation facts), each on PGLite and Postgres.
- Three existing tests encoded the lossy behavior and now assert the new invariant: `test/chronicle-auto-phase.test.ts` ("a genuine [] keeps the previous generation live"), `test/chronicle-date-quality.test.ts` ("keeps the old generation live when every new proposal is dropped") and `test/repair-stale-atoms.test.ts` (a zero-yield completion lists nothing; a completion that produced atoms still lists both old atoms).
- `gbrain git commit-push --push-only --keep-checkout` is the one form a managed worktree accepts.

Reported by @davidfragnoli-lang (#7013) and @dovstern (#7010).

## [0.60.303.0] - 2026-10-18

**CI only: master is green again. tsc runs in its own `typecheck` job beside `verify`, and the crash robot reaches every fault its count role plans.** Nothing changes for gbrain users.

### What changed

| Situation | Before | Now |
|---|---|---|
| A PR changes a widely imported type (any new error code) | master's next typecheck was effectively cold (121 s) inside verify's 120 s per-check cap, and it timed out; a timed-out tsc saves no state, so a rerun restored the same stale cache | tsc runs in test.yml's `typecheck` job, in parallel with verify, under a 6-minute step timeout (3x the worst cold CI time); the job saves its tsbuildinfo on every outcome; `test-status`, and with it the release gate, requires the job |
| A crash-robot count role sees the git effect of `finish`'s probe write | the run role could exit before that effect ran, so a fault planned there went unreached (`authority_change_pending_effects` seed 5105, `effect:git:mid#4`) | `finish` drains the probe's effects, so every seam the count role sees comes again in the run; a probe whose effects do not drain is a `wedge` violation |
| `test/minions-shell-process-tree.test.ts` reads a pid file the shell has created but not yet written | the empty read became pid 0, which counted as a live process, and the cleanup sent SIGKILL to pid 0, the test's own process group (the shard died with exit 137) | the test waits until each file holds a positive pid |

### What you need to do

Nothing.

### For contributors

- `bun run verify` still runs typecheck locally. CI's verify sets `GBRAIN_VERIFY_SKIP_TYPECHECK=1` because the `typecheck` job owns tsc, and `test/scripts/ci-gates.test.ts` pins the job, its timeout, its cache save and its place in `test-status`.
- Moving verify's typecheck to tsgo (TypeScript 7 native preview, about 13 s cold) is a follow-up for when its diagnostics match tsc's.

## [0.60.302.0] - 2026-10-18

**No gbrain writer replaces a newer file or database copy of a page without checking it first.** Before this release the unfenced-facts step in `extract_facts` could copy a stale checkout file over a newer database body with no history (#6982). An audit found the same unchecked overwrite in 21 more writers. Each one now compares both copies, keeps both on a mismatch, holds the page with `file_database_drift` and the next step, and keeps going with the rest of the batch. A `storage.db_only` cache that only lags the database no longer blocks writes to that page (#6986), and `response_too_large` now returns the write's `request_id` (#6989).

### What changed

| Situation | Before | Now |
|---|---|---|
| `extract_facts` / `dream` meets a checkout file older than the database body (#6982) | the file replaced the database body, and no `page_versions` row recorded the old one | the page is held with `file_database_drift`, nothing is overwritten, and the batch continues |
| Fence writes, `forget`, decide-proposal accept/undo, phantom redirects, synthesize/patterns reverse-writes, the dream summary, atom/concept/brainstorm write-through, full-sync re-export, Google and GitHub connectors, takes bootstrap, the v0.32.2 migration verifier, legacy-hash refresh | each replaced one copy with the other without checking that the replaced copy had nothing new | each replaces a copy only when it equals the live page or one of its recent versions, re-checks under the row lock or right before the rename, and writes a `page_versions` row first |
| A file edit landing while `writePageThrough` was staging | overwritten | detected after staging, and the write is refused |
| A failed page-cache mirror after a fence write or `forget` | the error was swallowed | the fence and facts are kept, and `FACTS_PAGE_MIRROR_FAILED` is reported |
| A `storage.db_only` page whose cache file holds an earlier database state (#6986) | every write was refused as an uncoordinated local edit | the cache is refreshed, while a cache with content the database never had still refuses |
| `response_too_large` on a committed mutation (#6989) | no `request_id`, so the write could not be looked up | carries the `request_id` and receipt |
| `think --take` on a database-only page | wrote the database and skipped the file | refuses with `mirror_unavailable` (use `gbrain takes add`) |

### What you need to do

Nothing. Held pages appear in the phase's `details.file_holds` and in `FACTS_FENCE_FAILED` warnings, together with the step that clears them. Nothing rewrites data on upgrade. Edits lost to this bug before this release were never in `page_versions`, so no GBrain repair can restore them. Recover them from git history or backups.

### For contributors

- `src/core/facts/file-body-guard.ts` is the shared guard (`replaceableFile`, `replaceStoredBody`, `mirrorFileBody`, `fileHeldBy`). `file_database_drift` is a registered error code.
- Each fix has a forced probe under `test/pathological/` (`d1`–`d23`, `w1`, `facts-mirror-failures`) that runs on PGLite and Postgres.
- `unit-postgres-arms` now runs 19 shards, with weights re-mined from this branch's own green run. The required checks are named `Unit-lane PostgreSQL arms N/19`.

## [0.60.301.0] - 2026-10-18

**CI only: the unit tests run in 18 shards, sized from fresh master timings, and a budget test now fails before a unit shard can outgrow its job timeout.** Nothing changes for gbrain users.

### What changed

| Situation | Before | Now |
|---|---|---|
| Measured runtime of the 3,761 unit-matrix files | weights from an older run (about 9,400 s), with 73 newer files, including 54 pathological-input tests, packed at the p75 guess; 10 shards carried about 950 s each and shard 5 was cancelled at the 22-minute timeout with no failing test | re-mined from master's own green run (10,199 s in total, every file measured): 18 shards of at most 567 s |
| A unit shard growing past its timeout | found only when a master run was cancelled | `test/scripts/unit-shard-budget.test.ts` fails when any shard's mined weight passes 600 s, so twice that plus a minute of setup still ends a minute inside the 22-minute job |
| `ci:ubicloud` with the unit and slow lanes | measured unit files without checking test.yml's shards | sums its measured durations over the same 18-shard partition and fails a shard that would not fit the job |

### What you need to do

Nothing.

### For contributors

- `test.yml` `test` and e2e.yml `coverage-full-unit` are now 18-shard matrices (`UNIT_SHARDS` in `scripts/sharding.ts`). Required checks are named `test (1)` to `test (18)`, and the coverage manifests expect `shard-1` to `shard-18`.
- The 22-minute job timeout is unchanged. When the budget test fails, re-mine with `bun run weights:mine --lane unit --run <green master Test run>`, then raise `UNIT_SHARDS` and both matrices to the smallest count that leaves room for new files.
- Serial weights were re-mined from the same run; the serial lane's four shards keep their 25-minute timeout, which they use a third of.

## [0.60.300.0] - 2026-10-18

**Every stuck state the #6948 sweep found now has an exit: a withdrawal mirror stuck on edited bytes, a crashed pre-kernel PGLite lock, fence rows an older release left in a managed clone, and stuck bundle, transfer and effect recoveries each get a preview-first repair command, and a failed withdrawal mirror no longer blocks the Git and embedding work of its request.** This is GBRA-130 PR 2, the second half of the #6948 bug-class sweep; every row ships with a probe that fails on master and passes here, on PGLite and Postgres. Nothing runs on upgrade.

### What changed

| Situation | Before | Now |
|---|---|---|
| A withdrawal-mirror effect stuck on edited file bytes | cleared only by hand | `gbrain repair stuck-recovery --keep withdrawn` previews it, backs up the edited bytes, writes the post-withdrawal bytes and finishes the effect; a record older than a later withdrawal on the same page is rebased first, so a forgotten fact never returns to disk |
| A legacy `.gbrain-lock/` left by a crashed pre-kernel gbrain | blocked the PGLite brain for good | `gbrain pglite-repair --legacy-lock` previews it and, after consent, moves it aside under the kernel lock; it refuses a live holder, a changed plan and a filesystem it can't confirm is local (`filesystem_unverified`), and prints an undo |
| Fence rows an older release appended to a clone gbrain owns (`sources add --url`) | blocked every pull | `gbrain repair url-clone-fences` keeps the rows in the database and restores the clone file to HEAD |
| A stuck bundle recovery, transfer or effect variant | no operator exit | each has a previewed resolution, a receipt and a retry path |
| A failed withdrawal mirror | blocked every Git and embedding sibling of its request | siblings run on the pages the mirror published; Git commits a page only when its bytes match the mirror rendering, skips one the mirror did not rewrite (`withdrawal_not_mirrored`), and waits while the mirror is requeued (`withdrawal_mirror_pending`); parked siblings re-arm when the mirror commits |
| A worker or entity slug the exporter refuses | the page could not be exported | slugs stay portable; a long or reserved name keeps its identity with a hash tag, and enrichment skips with `entity_slug_taken` when both forms belong to other entities |
| A run failure carrying an errno, SQLSTATE or typed error whose message also matches provider text | could be recorded as one bad item | structured failures are classified first, so `ENOSPC` stops the run |
| A session-start or prompt hook whose pack the serve backstop cut short | reported `ok` with an empty block | the pack assembled before the backstop is returned, and the hook records `degraded` with reason `server_budget` |

### What you need to do

Nothing. Each repair previews first and runs only with `--apply --expect <hash>` and your consent.

### For contributors

- The nightly watch reads job pages 50 at a time and retries a GET on a 5xx or a dropped connection (1 s, 3 s, 9 s); a 4xx still fails at once.
- The crash robot waits for the consumer's claim pass before finishing, the entity-resolve perf guard times its two query shapes alternately, and `eval_drift` refreshes a racy Git index after a timed-out diff.

## [0.60.299.0] - 2026-10-18

**Big pages now just work: `pages.segmented_storage` is on by default, so a page over 1 MiB is stored in segments and reading a piece of it costs the size of that piece, not the whole page.** A 200 MiB transcript, export or log file used to be stuck at the 24 MiB inline limit, and every read or rewrite of a large page moved all of it. Now a page can be up to 256 MiB on Postgres and 128 MiB on PGLite, a window, outline or chunk context reads only its segments, and a rewrite re-indexes only the segments that changed. Pages at or under 1 MiB are stored exactly as before. Forgetting or purging a fact on a large page now rewrites its file too, so the withdrawn text leaves the checkout and its Git history moves on, as it already did for small pages.

### How to use it

Bring a large file in through its file: `gbrain import <dir>` or `gbrain sync` (on a source backed by files, from the file's own place in the checkout). `put_page`, `put_pages`, `capture` and `gbrain put` stdin stay limited to 24 MiB per call.

```bash
gbrain config set pages.max_bytes 67108864        # lower the page ceiling (here 64 MiB)
gbrain config set pages.segmented_storage off     # store new pages inline up to 24 MiB again
```

Pages already stored in segments stay readable with the switch off.

### What changed

| Situation | Before | Now |
|---|---|---|
| A page over 1 MiB | stored inline, at most 24 MiB, and read whole | stored in segments up to 256 MiB (Postgres) or 128 MiB (PGLite); reads and re-indexing touch only the segments they need |
| `forget`, `forget_fact` or `purge_fact` on a large page of a source backed by files | the withdrawal mirror and Git effect skipped it (`page_body_segmented`) and its file kept the withdrawn text | the file is rewritten from the segments, one segment at a time, to the bytes `gbrain export` writes, and the Git effect commits it |
| A facts fence longer than a segment, once its source has a withdrawal | export, the mirror, the Git walk and the drift check refused `page_projection_stale`, so a purge parked with the row still in the file | they read the fence whole (up to 24 MiB) and apply the withdrawals; a longer fence is refused before a purge commits |
| A purge or forget of a row in a fence whose begin or end marker falls on a segment boundary | refused `withdrawal_provenance` | it commits and the row leaves the segments, the file and Git |