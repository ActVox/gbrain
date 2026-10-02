# Fix-wave notes: capy/gbra35w2-fix-wave (GBRA-35 wave 2)

Memory capture, search ranking, upgrades and managed brains with Google
connectors. Contributor branch folded into fix wave 7 (#5908); the collector
writes the version and the single CHANGELOG entry, and this file carries the
text, closes, credits, evidence and deferrals. Base: `capy/fix-wave-7`
(0c1a874f). No schema migration. `KNOBS_HASH_VERSION` 29 → 30 (the one bump
for this wave).

## CHANGELOG text (symptom-first)

### Memory

- **What the agent saves with `remember` is no longer stored a second time by automatic capture (#5888).** Automatic capture (the writeback hook, the compaction harvest and the corpus sweep) now skips a fact when an active fact in the same source has the same normalized text on the same entity (or on another entity the claim names), is visible where the new fact would be, and was written within 15 minutes of the turn or by capture in the same conversation. Reworded copies are never skipped by similarity, so a correction such as "is not moving", a changed amount or a changed place is always kept; capture only counts same-entity near duplicates (cosine 0.92 or higher) so a threshold can be measured first. Hot memory and the `context_pack`/`delta` facts show one line per duplicate group. Each skip is logged on stderr and in the hook heartbeat, and `gbrain doctor` (`memory_writeback`) reports `cross_lane_duplicates_7d` and `near_duplicates_shadow_7d`. Explicit `remember` is never skipped, so use it for anything that must persist.
- **The maintenance sweep now reads whole session transcripts, not just their first 8,000 characters, and a resumed session no longer re-extracts the same head (#5887).** The sweep cuts each transcript into windows at turn boundaries, each carrying its `[user]` or `[assistant]` label, with pasted blocks removed first, and records progress in a `<file>.progress` sidecar so appends and compaction rewrites cost only their new turns. Cost: a long transcript costs one extraction call per window, so a typical 120 KB transcript is about 15 calls where it used to be one. Spend per sweep is capped at 8 windows per file and 32 windows across files (`GBRAIN_CORPUS_WINDOWS_PER_SWEEP` changes the 32); longer files finish over later sweeps. `gbrain sweep --once --json` reports `corpus_files[]` with `windows_done` and `windows_remaining`. Transcripts marked done before this release are not re-read; only turns added after the upgrade are extracted.
- **New explicit repair: `gbrain repair captured-facts` expires facts captured before v0.60.30.0 from gbrain's own claude-cli sessions or from pasted text.** Doctor reports them as `captured_facts_active`, and the post-upgrade banner names the preview. Self-capture facts with evidence expire with `--apply --expect <hash>`; paste candidates (a word-overlap heuristic against the retained session corpus) expire only with `--include-ambiguous`. A claim that also has a legitimate active copy is kept. Facts are expired, never withdrawn, so `remember` can save the claim again.

### Search

- **An exact-title page ranks first again in title search, for CLI and MCP callers on both engines (#5889).** Title ties used to break by page id, so a page titled exactly "Acme" lost to dozens of "Acme weekly sync N" pages and fell outside the rows the exact-lookup tier reads. The title arm now sorts an exact-title match first. Remote (MCP) title search is also index-backed now, with no migration: on a 40k-page Postgres brain a rare term drops from about 490 ms to about 34 ms. Behavior change: remote title matching follows the language `search_vector` was built with; after changing the FTS language, run `gbrain reindex-search-vector`. `KNOBS_HASH_VERSION` 29 → 30 invalidates cached search results once.
- **`think` and synthesis see the full evidence set again with `search.adaptive_return` on (#5890).** Evidence gather was cut to 2 pages (entity questions) or 6 before synthesis. Gather, brainstorm's close set, grade-takes evidence, `whoknows` and `enrich` now opt out of both reader-facing trims.
- **`--json` output stays valid JSON when a claude-cli model runs (#5892).** The AI SDK printed its warning banner on stdout on the first provider warning, so `gbrain think --json` and `gbrain query --json` output failed to parse. Warnings now go to stderr; a user-set `AI_SDK_LOG_WARNINGS` is kept.

### Upgrades and operations

- **`gbrain upgrade` no longer installs a release the host's Bun cannot run (#5855).** Before swapping, the upgrade reads the target release's Bun floor (a clone fetches and checks `package.json` at the exact commit it then fast-forwards to) and compares it with the host's Bun. Behavior change: a manual `gbrain upgrade` or `gbrain self-upgrade` refuses and changes nothing (exit 78) with `gbrain <target> requires Bun >=<floor>; bun on PATH (<path>) is <found>. Fix: bun upgrade, then gbrain upgrade.` When the floor cannot be read, `--no-bun-floor-check` upgrades anyway (manual only). Autopilot holds the upgrade instead (`gbrain doctor` `self_upgrade_health` shows the hold and the fix) and applies it after `bun upgrade`. The post-swap smoke now runs `gbrain --help`, which passes the startup Bun check, and prints per-method recovery when it fails. Clone installs should upgrade with `gbrain upgrade`, not `git pull`, so the check runs. Hosts on v0.60.31.0 or older do not run this check until they have upgraded past this release.
- **An unpaced embed backfill no longer takes every database connection (#5902).** Without an explicit concurrency, `embed --stale` drains and the `embed-backfill` job run at most half the engine's real pool (20 when the engine has no pool); an explicit `GBRAIN_EMBED_CONCURRENCY` keeps the full-pool clamp.
- **Dream synthesis no longer fails its phase when the canonical writer is busy (#5854).** Maintenance publishes wait up to 30 s (one wait per job, bounded by the job deadline). A synthesis output still publishing after that is deferred, not failed: the phase reports `warn` with `publish_pending` and "publish deferred (writer busy); finishes next cycle, no action needed", the cooldown is not stamped, and the next cycle finishes the same request. Behavior change: a pending synthesis publish is a phase warning, not a failure.

### Managed brains and Google connectors

- **Gmail and Calendar pages get links and timeline entries again (#5875).** Cycles with no on-disk checkout (connector sources, Postgres brains without `--dir`) skipped extraction entirely. They now run the bounded, source-scoped database-only stale drain each cycle.
- **Managed brains extract commitments from Gmail again (#5867).** Managed connector syncs never queued `loops_extract`. Every sweep now queues it on managed and unmanaged brains, the sync result carries `loops_enqueue` (`enqueued`, `deferred`, `skipped_reason`), and every skip is logged. A one-time catch-up on managed sources analyzes email threads from the last 30 days that were never extracted.
- **Quiet Gmail threads open their loops when the waiting window ends (#5868).** A thread still inside its 24 h (inbound) or 72 h (outbound question) window was never re-checked unless new mail arrived. The sweep now records a grace hold and re-evaluates the thread when it is due, from the stored page when nothing changed; the first sweep after upgrading seeds holds for threads active in the last 14 days from stored pages, with no Gmail calls. Grace holds are not held items and do not affect `connector_held_items` or `waiting` coverage.
- **Closing a commitment loop retires its fact, and says so honestly (#5869).** On a managed brain the fact expiry was refused, the error swallowed, and `loops_close` still answered `fact_expired: true`; the fence row was never struck on any brain. Closing now expires the fact and strikes its fence row in one coordinated write, keeps a fact another open loop still uses, and returns `{ closed, id, status, fact_expired, retryable, reason? }`; a close whose retirement did not commit is retryable. New explicit repair: `gbrain repair loop-facts` (doctor `loop_facts_drift`) retires the facts of loops closed before this release.
- **Automatic atom drains stop dead-lettering on connector sources (#5856).** Behavior change: atom extraction of connector `email` and `meeting` pages is now opt-in on every brain, managed or not: `gbrain config set cycle.extract_atoms.connector_pages true`. Unmanaged brains that extracted those pages automatically stop until they opt in. When opted in, the text of each extracted email thread or calendar event goes to the configured `extract_atoms` model. The auto-drain's daily cap (`autopilot.auto_drain.max_usd_per_day`, $2.00) counts drain attempts at the per-attempt estimate (`cycle.extract_atoms.budget_usd`, $0.30), so 6 attempts a day by default, each attempt under one budget across its batches; with a model the tracker cannot price, the dollar limit is not enforced and only the attempt count bounds it. A job refused before any model call dead-letters once and does not count; checkout and connector sources take turns for slots. Off switch: `gbrain config set autopilot.auto_drain.enabled false`.
- **`gbrain doctor`'s `orphan_ratio` fix command runs, and connector mail no longer inflates the ratio (#5877).** The printed command includes `--source db` (and `--source-id` when scoped), the message says it counts pages with no links in either direction, and orphaned email/meeting renders of connector sources are reported apart as `connector_renders_excluded`.
- **`gbrain extract timeline --source db` writes on fresh and managed brains, and fails loudly when it can't (#5904 probe).** It inserted raw rows that every managed brain (including every fresh `gbrain init` brain) refuses, printed "rows lost" and exited 0. It now publishes per page through the coordinator; a refused write prints its code, "nothing written; existing timeline rows are untouched", the recovery command and a docs anchor, and the command exits non-zero.

### Collector input lines (spend, cost, repairs, gate)

- Spend: connector `email`/`meeting` atom extraction is opt-in on every brain (`cycle.extract_atoms.connector_pages`); the auto-drain cap counts attempts (6/day by default).
- Cost: long transcripts cost about one extraction call per 8,000-character window (p90 about 15 calls instead of 1), capped at 8 windows per file and 32 per sweep.
- New explicit repairs: `gbrain repair captured-facts`, `gbrain repair loop-facts`; the post-upgrade banner names both previews.
- Bun gate: manual upgrade refuses on an unmet Bun floor (exit 78); autopilot holds.

## Closes

- Issues: #5888, #5887, #5889, #5890, #5892, #5855, #5902, #5875, #5867, #5856, #5877, #5854, #5868, #5869.
- #5904 stays open: its library-level `--source db` entry point is deferred (the shared coordinated path now exists in `src/commands/extract-timeline-db.ts`), but the probe defect it reported is fixed here.
- Superseded PRs, to close with a pointer after the wave merges:
  - #5897 (javieraldape): windowed corpus extraction, ported with credit and reworked (no window starts mid-turn without its role label, finished files are decided by a stat compare instead of a rehash, the hook's claim contract is unchanged).
  - #5860 (andreineacsu): Bun floor gate, ported with credit; its source-regex autopilot test is replaced by a behavioral harness.
  - #5865 (andreineacsu): `connector_database` write target for atom maintenance, ported with credit.
  - #5853 (morven-ai): diagnosis credited; remote title search is index-backed through `pages.search_vector` without its title GIN migration or its statistics half.

## Credits

Ported code carries `Co-Authored-By` trailers: @javieraldape (#5897), @andreineacsu (#5860, #5865). Diagnosis credit: @morven-ai (#5853, title FTS). Issue reports with reproductions: @andreineacsu (#5888, #5887, #5889, #5890, #5892, #5855, #5875, #5867, #5856, #5877, #5868, #5869), @nezovskii (#5902, #5904), @ywlee7922 (#5854).

## Evidence

- Every fix has a discriminating test that fails on the base and passes with the fix; the managed connector job contract harness (`test/helpers/managed-connector-job-contract.ts`, PGLite and Postgres) drives every automatic connector-source job on a managed brain through a real queue and worker, counts every `managed_writer_guard` refusal, ties each committed guarded row to a coordinator publication, and ends with no expected-fail markers.
- #5888: 16 of 19 dedup cases fail on the base (the 3 passes are negative controls); 19 of 19 pass on PGLite and pgvector Postgres 16.
- #5889 benchmark: Postgres 16, real gbrain schema, 40,001 sealed pages, `VACUUM ANALYZE`d, remote options `{requireSafeChunks, excludePrivate, sourceId, limit: 50}`, median of 9 interleaved runs of `engine.searchTitles`, no `enable_seqscan` forcing, same slugs in the same order in every case.

  | case | query | before ms | after ms |
  |---|---|---|---|
  | rare (1 match) | `zorblax` | 490.9 | 33.6 |
  | 2,000 matches | `globex` | 545.1 | 453.3 |
  | 10,000 matches | `sync` | 572.9 | 468.8 |
  | OR fallback (strict 0) | `zorblax weekly sync` | 1142.6 | 498.0 |
  | 10,000 matches, no sourceId | `sync` | 634.2 | 527.5 |

  With JIT off (diagnostic) the same cases run 121 → 4 ms, 129 → 19 ms, 169 → 40 ms, 330 → 73 ms and 251 → 74 ms: about 500 ms of the remaining common-term time is JIT compilation (EXPLAIN ANALYZE for `globex`: 17 ms execution, 504 ms JIT), because the visibility subplans push the cost estimate past `jit_above_cost`. Turning JIT off for the title arm is deferred.
- Title-index rationale: a title GIN migration was rejected because its FTS language would be frozen at upgrade time with no rebuild path, it adds a third GIN index on `pages` (write amplification beside `idx_pages_search` and `idx_pages_trgm`), and PGLite would need its own expression index. The remote arm instead matches `pages.search_vector` with every query lexeme labeled `:A` (weight A is the title alone, pinned by a test) and ranks on `ts_filter(search_vector, '{a}')`, so negated and phrase terms are evaluated on title lexemes only and timeline text cannot change which titles a remote caller sees. Pages with a NULL `search_vector` are absent from the remote arm (the trigger keeps it non-NULL; `gbrain reindex-search-vector` repairs it).
- #5890: with `search.adaptive_return` on, the reproduced gather returned 6 of 12 matching pages before the fix and 12 after.
- #5902 is mitigated, not reproduced end to end: pool saturation by 20 workers on a 10-connection pool was measured, but the reported timeouts and dead jobs were not reproduced. Postgres E2E: an instance pool of 4 peaks at 2 workers.
- #5854: only the wait and phase-failure half is fixed. The issue's claim that the failure caused duplicate child re-runs was not proven.
- Capture dedup cosine (V1, D16), measured once with `voyage-4` (document embeddings) over generic pairs: 20 paraphrase pairs (min 0.870, median 0.954, max 0.987; 17 at ≥ 0.92, 13 at ≥ 0.95), 20 correction pairs with a negation, number or date change (min 0.822, median 0.921, max 0.959; 11 at ≥ 0.92, 4 at ≥ 0.95) and 10 word-change corrections such as "deploy to staging" vs "deploy to production" (min 0.866, median 0.918, max 0.956; 4 at ≥ 0.92, 2 at ≥ 0.95). The capture lanes' negation/number/date guard catches all 4 correction pairs at ≥ 0.95, but neither word-change pair at ≥ 0.95 ("The offsite is in Lisbon" / "... Porto" at 0.956, "I use Vim" / "I use Emacs" at 0.954), so a same-entity word-change correction that close can still be dropped as a duplicate by automatic capture. Explicit lanes keep the unguarded 0.95 drop, so all 6 pairs at ≥ 0.95 are dropped there (TODOS).
- Upgrade journey (Pass 8): not measured in this wave; the target (end of `gbrain upgrade` to both new repairs previewed in under 5 minutes) is a TODOS entry.

## Known residuals (blunt)

- #5888: a `remember` saved after automatic capture already stored the same claim leaves two active rows. Hot memory shows them once only when the text is identical, and search can return both.
- #5888: the dedup check is a read outside the write transaction, so two capture writers racing on the same claim can both insert it.
- #5888: capture keeps same-entity rewordings (cosine dedup is shadow-only), so a reworded duplicate can still appear twice until a measured threshold ships. The V1 measurement shows why: single-word corrections ("Lisbon" → "Porto", "Vim" → "Emacs") embed at ≥ 0.95, which no token guard catches.
- #5855: hosts on v0.60.31.0 or older run their own upgrade code, which has no floor check, so the next Bun floor raise must wait until this release is widely installed.
- #5856: with an unpriced `extract_atoms` model the auto-drain's dollar limit is not enforced; only the attempt count bounds it.
- `gbrain repair captured-facts` stays registered (no sunset), so hosts that skip versions can still run it.

## Deferred (TODOS)

- Honest `waiting` completeness while loop analysis is pending, and a loop freshness field.
- Answer-quality before/after gate for #5888, #5890 and #5887 (V13).
- Static guard against raw guarded-table writes and swallowed `managed_writer_guard` refusals (V15).
- `extract-conversation-facts` dead-letters when `facts.extraction_enabled=false` (found by the contract harness).
- `extract timeline --from-meetings` on managed brains.
- Stopword-only title probe; `projects/` boost (eval first); one write-target resolver for connector sources.
- claude-cli provider as a native `LanguageModelV3`.
- Explicit, cost-previewed backfill of legacy head-only transcript tails.
- Escape `[user]` / `[assistant]` role markers inside user text (E27).
- Explicit-lane 0.95 cosine correction loss (V1); JIT off for the remote title arm.
- One coordinated fact-retirement mutation for `captured-facts` and `loop-facts`.
- Autopilot per-tick `git fetch` throttle while an upgrade is held.
- #5904's library-level `--source db` entry point.
