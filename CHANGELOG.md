# Changelog

All notable changes to GBrain will be documented in this file.

Historical entries use generic identifiers for the retired hosted provider
and its removed commands.
Those identifiers and any sample command containing them are non-executable
archival labels, not supported configuration. Dates, measurements and contributor
credits are retained; no result has been reassigned to another provider. Original
identifiers and attribution are available in the pre-removal Git revision
`6040075c6cb95be5881cc2e1b76ef7d71f4e5d29` (retained on 2026-09-23).

## [0.60.345.0] - 2026-10-21

**Background jobs stop burning retries on refusals that can never succeed, the dream synthesize phase stops cancelling every child over one bad transcript, and job sweeps stop tripping over the sync lease record.** A sync that runs on a host that doesn't own the checkout, or that needs `--no-pull`, used to fail the same way on every retry and was queued again every few minutes. One transcript with a character Postgres refuses in JSON failed the whole synthesize fan-out. A long sync's lease record made the stall and timeout sweeps fail, so nothing else stuck got reaped and synthesize reported a failure after its work finished.

### What changed

| Situation | Before | Now |
|---|---|---|
| A job fails with a deterministic refusal (a caller, consent or host-only error code) | retried until `max_attempts`, then requeued by autopilot every slot | ends `dead` after one attempt with `result.job_outcome: 'refused'` and the refusal's code, reason and fix; autopilot holds that source for its failure cooldown |
| A transcript whose subagent job can't be queued | the synthesize phase failed and cancelled every child already queued | that transcript is skipped as `submit_failed (<code>)` and the rest run |
| Job data with a lone UTF-16 surrogate or U+0000 | Postgres refused the insert (22P02 / 22P05) | the character becomes U+FFFD |
| A sync holding its drain lease longer than two lock durations, or a dead lease holder | the stall / timeout / wall-clock sweeps hit `chk_attempts_order`: no stalled job was reaped, and the dream inline drain failed synthesize | the sweeps skip the lease record |
| serve, the supervisor, workers and job children on different builds | nothing reported it | `/health` carries `build`, doctor `runtime_build_skew` warns and names the restart, and a job child records `job_build_skew:` (or refuses on a protocol mismatch) |

**Spend effect:** synthesize children that were cancelled before they ran now run, inside the existing `dream.synthesize` budget, daily cap and breaker. No default or cap changes. Nothing is rewritten on upgrade.

### Itemized changes

- `src/core/minions/refusal.ts` (new): `jobRefusal` classifies a job error from its registry code. The worker and the dream inline drain end a refused job dead after one attempt. A refusal crosses the per-job child boundary as errorKind `refused`.
- `src/core/persistence/sync-discovery.ts`: `owner_unavailable` carries a `reason` and is `retryable: false` unless a transfer or clone is in progress.
- `src/commands/autopilot-dispatch.ts`: a refused sync job holds its source for the existing failure cooldown; a completed sync clears it.
- `src/core/minions/queue.ts`: `add` passes job data through `jsonbSafeJson`; `failJob` takes an optional `result`; the three sweeps skip `LEASE_BEACON_QUEUE`.
- `src/core/cycle/synthesize.ts`: a transcript that fails to submit is skipped with its fresh chunks rolled back.
- `src/core/runtime-build.ts` (new) and doctor check `runtime_build_skew` (new error code): builds of serve, the supervisor, worker parents and recent job children.

### For contributors

- `scripts/bench-minions-load.ts`: a synthetic PGLite job-load fixture (`retry_burn`, `cancel_churn`) with no network and no model calls.
- Doctor and export goldens are regenerated for the new check and error code. `/health`'s exact-shape test now includes `build`.
- Thanks to @sameerbopardikar for the root-cause report in #7261.

## [0.60.343.0] - 2026-10-21

**An opt-in warm CLI socket lets `gbrain search`, `query`, `get` and `recall` skip most of a cold start's database round trips.** A cold CLI process connects, loads config and resolves its source before it can answer. Behind a transaction-mode pooler at 40 ms RTT, that cost a 305k-page brain about 3.4 s per search. With `gbrain serve --cli-socket` running, the same CLI call goes through a local Unix socket to the running serve and returns byte-identical output: 2.3 s for that search and 0.66 s for a get, against 1.19 s cold. It is off by default.

### What changed

| Situation | Before | Now |
|---|---|---|
| A CLI read while `gbrain serve` runs on the same brain | every call paid a cold start | with `gbrain serve --cli-socket` (or `gbrain config set serve.cli_socket true`), search, query, get and recall go through `GBRAIN_HOME/.gbrain/run/cli.sock`. Writes and every other command take the normal path |
| A socket that is stale, dead, slow, on another brain or set up differently | n/a | the CLI falls back to the cold path silently. `GBRAIN_DEBUG=1` prints why, and `GBRAIN_CLI_SOCKET=0` skips the socket |

The socket is a 0600 Unix socket in a 0700 directory owned by the current user. Peer credentials are checked on every connection, and a handshake token binds it to one brain, config, version and set of provider routing settings. An independent security review approved it. Postgres brains only. See [docs/guides/cli-socket.md](docs/guides/cli-socket.md).

## [0.60.342.0] - 2026-10-21

**A page saved again while its search embedding is being prepared no longer leaves that embedding job retrying for nothing.** When a page changed between two steps of its embedding job, the job waited about a second and tried again for a version of the page that would never come back. It then gave up on the next attempt. Now the job sees that the page moved on and closes at once, the same way it already did when the newer version arrived earlier. The newer version gets its own embedding as before.

### What changed

| Situation | Before | Now |
|---|---|---|
| A page is written again between the embedding job's page read and its text read | the job retried after about a second, then closed as superseded | the job closes as superseded on that attempt |
| An embedding job whose own version's text is not ready yet | retried | retried (unchanged) |

Nothing changes on upgrade, and nothing is rewritten.

### Itemized changes

- `src/core/persistence/effects.ts`: a `projection_pending` from the embedding effect's projection read re-reads the page; if the page is past the effect's revision, the effect completes `superseded`/`revision_changed`. Targeted-withdrawal and source-scan effects are unchanged.

### For contributors

- New fault point `effect:embedding:page_read`, with a regression case in `test/e2e/put-page-persistence-postgres.test.ts`.
- `check:vendor-postgres` in `bun run verify` runs `vendor/update-postgres.sh --check`, so a driver fix made only in `vendor/postgres/src` (missing from the patch or the `cjs`/`cf` copies) fails verify. The pinned downloads are retried with backoff and cached by hash (`~/.cache/gbrain-vendor`, cached in the verify job); a hash mismatch still fails.
- `scripts/ubicloud/ubi-runner.sh list --mine`, `gc` and the `up` sweep cover every VM this machine created, under any `UBI_OWNER` tag.
- Seven timing-dependent tests are fixed at their cause, each proven with a forced probe: the #6511 purge budget, the lp-c publication-ceiling wait, the #5762 lock-timeout receipt, the #6712 shared-budget level, the origin-native legacy deletion, the long-page off-path comparison with a provider key, and the MCP tool-list snapshot boot. No bound, timeout or assertion is loosened.

## [0.60.341.0] - 2026-10-21

**Facts, events and memories derived from a private page stay private, and a retry can no longer widen them.** A fact extracted from a `visibility: private` page took the brain default, so on a world-default brain it was stored world, and remote callers read it through `recall` and the entity card. `remember` without a `visibility` saved world even onto a private page, and a reworded retry that dropped the parameter did the same.

### What changed

| Situation | Before | Now |
|---|---|---|
| Facts from a private page (page-write backstop, `extract_facts` with `source_slug`, `extract-conversation-facts`) | brain default or the caller's `world` | private |
| Remote `extract_facts` whose source page it cannot see | caller's value | private, the same answer as a missing page |
| `remember` with no `visibility` onto a private page, or under an explicit private `facts.default_visibility` | world | private; still world otherwise. The resolved value is stored on the request, so retries keep it |
| A page marked private only by `access: private\|restricted\|confidential` or `confidentiality: confidential\|secret\|private\|restricted` | its facts, chronicle events, meeting timeline rows and `remember` saves were world | they are private |
| Remote page reads of such a page | visible | unchanged by default; hidden when you set `visibility.honor_aliases true` |
| Google Calendar events marked private or confidential | page had no visibility | `visibility: private`; a re-sync never drops a private label |

### Check and repair what was written before

Run `gbrain doctor`: `derived_visibility` now counts pages that rely on a privacy alias, chronicle events looser than their origin, and world facts from private pages (with the ids of those a remote caller can read). `gbrain repair visibility` previews every row; `gbrain repair visibility --apply` only tightens them. Nothing changes on upgrade.

Not covered: Calendar events with default visibility on a calendar that is itself private (that needs the Calendar ACL scope), and timeline rows already written from alias-private meetings.

### For contributors

- `test/visibility-fail-closed-derived-writes.test.ts` runs every path on PGLite and Postgres with remote callers.
- `access` and `confidentiality` are protected frontmatter keys: an ambiguous value is held instead of guessed.

## [0.60.340.0] - 2026-10-21

**Cold one-shot reads behind a transaction pooler make fewer round trips and open at most two connections.** A cold `gbrain search` used to pay a round trip for each startup probe and open a connection for each parallel arm. On a 5,000-page test brain behind PgBouncer, cold search drops from 70 to 56 round trips, `get` from 15 to 13 and `recall` from 20 to 11.

### What changed

| Situation | Before | Now |
|---|---|---|
| Config reads in a one-shot read | the startup read and the operation each took a config snapshot | one snapshot per command, handed from startup to the read; the keyword statement timeout reads it too |
| Source resolution | the sources table was read up to three times per request | read once per request snapshot |
| The search-statistics guard on every cold search | several statements | one statement |
| Connections in a one-shot read | one per parallel arm (up to 8 for `entity`) | at most two (`GBRAIN_POOL_SIZE` still wins) |
| Modules loaded by `gbrain get` | 1,299, including the write path and PGLite WAL repair on a Postgres brain | 663; write handlers load `page-mutations.ts` only when they write |

Nothing changes on upgrade.

### For contributors

- `test/e2e/cli-read-startup-round-trips.test.ts` sets per-verb statement budgets on direct Postgres and through PgBouncer.
- `test/cold-read-module-graph.test.ts` pins the read path's module graph.

## [0.60.339.0] - 2026-10-21

**A managed source with thousands of pre-managed pages that no longer match their files advances again (#7189).** The first managed full round screened every legacy page before importing anything. A page whose body differs from its file is never recorded, so a pass stopped by its deadline kept nothing, and the next pass screened the same pages from the top. On a large brain every pass ran its full hour, ended partial with 0 changes, and the commits waiting behind the sweep never became searchable.

### What changed

| Situation | Before | Now |
|---|---|---|
| The first managed full round of a source with legacy pages | screened every legacy page before importing the round's changes | screens at most 500, then imports the round's changes in the same pass |
| A pass stopped mid-sweep | the next pass screened the same pages again from the top | the next full round resumes at the last screened path (`obligations.legacy_sweep.cursor`) |
| Legacy pages whose body differs from the file | the first full sweep never finished, so every pass was another first full round | the first sweep finishes once and records `first_full_at`; later sweeps rotate through the rest, 500 per pass |

### For contributors

- `test/sync-legacy-sweep-resume-7189.test.ts` (PGLite and Postgres) stops any pass past 500 screens and checks that the waiting commit imports and the next full round screens only the rest.

## [0.60.338.0] - 2026-10-21

**Keyword search on a large Postgres brain no longer stalls on a common word, and agent guidance now says to search gbrain first.** At 300k pages, a keyword query whose words matched hundreds of thousands of chunks ranked every one of them and often hit the 8 s keyword statement timeout, so the keyword arm returned nothing. Ranking is now bounded, the OR retry matches only the words that fit, and the candidate pool keeps one chunk per page. On a 305k-page bench behind a transaction-mode pooler, warm search p95 fell from 8.4 s to 2.4 s, warm query from 8.6 s to 1.2 s and warm recall from 8.4 s to 1.0 s. Retrieval quality on the agent-retrieval shapes and the 70-question ranking-shapes set is unchanged.

### What changed

| Situation | Before | Now |
|---|---|---|
| A keyword search whose words match more than 50,000 chunks (Postgres) | ts_rank ran over every match and often timed out | the first 50,000 matches that pass the filters are ranked, and the response is stamped `keyword_candidates_incomplete` |
| The keyword arm's any-word retry after an all-words miss | an OR over common words matched up to 850k chunks | matches only the words that planner statistics say fit under a 20k-chunk cap, and still ranks with the full OR query |
| A page with hundreds of matching chunks | it could fill the keyword candidate pool | the pool keeps one chunk per page (Postgres and PGLite) |
| The title arm's any-word retry for local callers | matched page text | matches titles only, as remote callers already did, and drops repeated words (#7135) |
| An agent deciding where to look | guidance didn't say | brain-first, query, brain-ops, RESOLVER and the AGENTS/INSTALL templates say to search gbrain first, then read the page, with copyable examples |

### For contributors

- `scripts/bench/retrieval-scale/` builds a synthetic large brain and times cold and warm search, query, get and recall behind PgBouncer and toxiproxy.
- `test/e2e/retrieval-round-trip-budget.test.ts` pins the cold CLI round trips: search 65, get 19, recall 38.

## [0.60.337.0] - 2026-10-21

**Agents can ask gbrain what happened to a file instead of copying its path rules, and `gbrain sync status` no longer contradicts itself.** A landing check that rebuilt gbrain's path-to-slug rules in its own code reported pages as synced but unsearchable for days when nothing was wrong. `gbrain sources resolve-path` gives gbrain's own answer for each path, and sync status and doctor now flag the pages that really are committed but not yet searchable.

### What changed

| Situation | Before | Now |
|---|---|---|
| A harness checks whether a synced file landed | it had to copy gbrain's path-to-slug rules and drifted | `gbrain sources resolve-path <id> <path...> [--stdin] [--json]` (MCP `sources_resolve_path`, read scope, up to 200 paths) returns each path's slug, one of 14 states, `searchable: true \| 'keyword' \| false`, a reason and a fix |
| Pages a managed sync committed are still not searchable | nothing said so | `gbrain sync status --detail` adds a `landing` block, and the doctor check `sync_landing_gaps` warns about pages committed longer ago than the freshness target that search still can't fully see |
| A folder `index.md` or `README.md` below the source root with `type:` or `title:` frontmatter | skipped by sync, so it never became a page | imported as a page. Bare ones and every one at the root stay skipped. `gbrain config set sync.metafile_pages off` restores the old skip |
| One file waits on a person while the rest of the source syncs | `sync status` said `blocked` | `synced` with reason `held_needs_human`. `blocked` now means only that the source can't advance |
| A source falls behind its checkout | latency looked healthy, "no resident watcher" showed while a sync was running, and a fixed error still demanded a person | `freshness.behind` counts the commits not synced yet, `notifier.drain_holder` names the process syncing the source, an error the sync has since moved past is marked `superseded`, and `needs_human_from` says why a person is needed (#7189) |

The first sync after upgrading imports existing typed nested metafiles once. Nothing else is rewritten or deleted.

### For contributors

- Harness authors: [docs/guides/resolve-paths.md](docs/guides/resolve-paths.md) lists the states and how a landing check should treat each one.

## [0.60.336.0] - 2026-10-21

**Writes no longer wait out their lock bound behind a large page's background index build.** Since 0.60.331.0, a new page over 4 MiB replies when it commits and its search index is built afterwards. Each step of that build held the page's lock while it inserted up to 4 MiB of passages, which took 1.6–2 s on a loaded host. A write to that page waits at most 1 s for the lock, so it failed and prepared again, copying a large page's prior file to its recovery stage once per attempt. A managed sync import, checkpoint or purge anywhere on the same source waited the same way, and could finish only on the next pass.

### What changed

| Situation | Before | Now |
|---|---|---|
| A delete, edit or other write to a page while its background build runs | could wait past its 1 s lock bound, then prepare again (a second copy of a large prior file) | the build holds the page lock for at most 512 KiB of passages per transaction (about 0.1 s), and the waiting write takes it next |
| A managed sync import, checkpoint or purge on the same source during such a build | waited behind each build step; a small file could be credited only on the next pass | waits at most one bounded step |
| The build's removal of stale passages | up to 20,000 rows per lock transaction | 2,500 rows per lock transaction |

No timeout or retry budget changes. The bounds and their derivation are in `src/core/page-body/limits.ts` (`PROJECTION_LOCK_HOLD_BYTES`, `PROJECTION_RETIRE_MAX_ROWS`).

### For contributors

- `test/large-pages/stuck-recovery-large.slow.test.ts` keeps its fault hook installed until the consumer is disposed, so a delete that outlasts the 5 s reply wait still meets the injected interruption.
- New `test/large-pages/projection-lock-hold.test.ts` and the `segmented:projection_insert` fault point drive a write and a sync import during a build insert.

## [0.60.335.0] - 2026-10-21

**A page of a source with no checkout of its own can no longer be written into another source's checkout through a second spelling of its path, and managed-root records keep their bound owner whichever spelling sorts first.** Both compared stored path strings where they needed filesystem identity. A symlink, a trailing slash, the macOS `/var` → `/private/var` alias or a case variant on a case-insensitive disk all name the same directory under a different spelling.

### What changed

| Situation | Before | Now |
|---|---|---|
| `sync.repo_path` is another source's checkout under another spelling, and a source with no `local_path` writes through | the page file landed in the other source's tree, and that source's next sync imported it as its own page | refused as `source_repo_belongs_to_other_source`, the same as the exact spelling |
| `sync.repo_path` lies inside another source's checkout, or another source's checkout lies inside `sync.repo_path` | the page file landed in that checkout | a file inside any other source's checkout is refused; files elsewhere still write |
| Another source's path can't be resolved (a symlink loop, an unreadable parent) | compared as a string | the leak guard fails closed |
| doctor `default_source_local_path` with an aliased or nested collision | ok | warns, names the source, and counts default-source pages that share a file path with that source's pages: pages an earlier misrouted write may have duplicated (read-only, nothing changes) |
| A bound worktree and an unbound source path alias one managed root | the spelling that sorted last won the root's record, so the record could lose its worktree identity or name the unbound source in refusal messages and fix commands | one record per root; the bound row wins regardless of spelling or order |
| Idle refresh of an aliased managed root | rewrote the record twice on every refresh | rewrites nothing (#5297 holds) |
| A record an alias already overwrote | stayed wrong | rewritten with the bound identity on the next refresh; no migration and no data removed |

The filesystem fence itself was never bypassed: writes through either spelling of a managed root were refused before and still are.

Reported by @dyana1lyons-ai (#7203).

## [0.60.334.0] - 2026-10-21

**Agents can now filter search and page listings by frontmatter, pass `--types` as plain words, and see what each search cost in time and money.** Without these, agents fell back to grep and raw SQL to answer "which company pages mention this" or "what did I touch this week". Retrieval now answers those questions directly and says where the time went.

### What changed

| Situation | Before | Now |
|---|---|---|
| `gbrain search q --types company` or `--types person,company` | failed with "--types requires a JSON array" | a bare value or a comma list works; a JSON array still works (#7173) |
| Filter by a frontmatter field | not possible from search, query or `list_pages` | `--where key=value` (repeat to AND keys; `key=a,b` matches any value), MCP `where: { key: value \| [values] }`. The existing GIN index serves it; no migration (#7159) |
| List pages under a slug prefix | not possible | `list_pages --slug-prefix <prefix>` (#7159) |
| A search names a page type or a time period without filtering on it | no hint | one `search_filter_hint` info notice with the filtered command; results are unchanged |
| What a search or query cost | not reported | `_meta.retrieval.cost` lists the embedding, rerank, chat, expansion and decide calls with tokens and USD (#7158) |
| Where a CLI search spent its time | not reported | `--json --timings` prints `{results, timings_ms, cost}` with startup, connect, context and stage timings. Plain `--json` still prints the bare array |
| A query-expansion call | wrote no usage row | writes a `chat_usage_log` row (phase `expansion`); `think` synthesis records phase `think` (#7176) |

Nothing changes on upgrade. Every new parameter is optional, and existing `--json` output keeps its shape.

### For contributors

- A per-request `AsyncLocalStorage` meter (`withAIInvocationMeter`) keeps cost from concurrent MCP requests separate.
- Frontmatter `where` keys must be plain identifiers, and values travel only as bound JSON (8 keys, 32 values, 256 characters).

## [0.60.333.0] - 2026-10-21

**`gbrain doctor` has a quick tier for agents on large brains, grades checks that ran out of budget honestly, and stops counting sync-failure ledger rows nothing can retry. One-shot CLI reads also start faster behind a pooler.** On a large brain a full doctor run used to blow its budget and report a wall of unknowns. Agents read those as failures and repeated the run. `gbrain doctor --tier quick` answers the questions an agent gates on within 10 seconds. Every other check comes from its last known result, with the result's age.

### What changed

| Situation | Before | Now |
|---|---|---|
| An agent health-checks a large brain | a full `gbrain doctor` blew its budget and reported many checks as unknown | `gbrain doctor --tier quick` runs the ops sections, schema version, sync failures, queue health and partial embeddings under a 10 s deadline. Every other check is reported from its last known result with its age (`details.last_known`, `last_known_sections`) |
| A brain-wide doctor check runs out of its budget | reported unknown | reports its last result while that result is under 24 h old. Checks with no recent result are named in one `doctor_last_known` warning, and a Postgres brain queues one background `doctor-refresh` job per hour to measure them |
| A check whose count hit its bound, or a managed-guard check on columns it can't read | graded as a failure or a pass it hadn't earned | graded by what it measured: a capped count says it is capped and names the bound, and an unreadable guard says unknown (#7145) |
| Doctor lists terminal write failures | in arrival order, so old rows hid live blockers | active blockers first, then the unresolved pile, then historical rows (#7146) |
| `gbrain doctor --only sync_failures` | reported that durable sync state was unavailable | connects the brain and runs the check (#7143) |
| The sync-failure ledger holds rows for an unregistered source or a deleted file | counted as failures nothing could clear | set aside and counted separately. A process under `bun test` with neither `GBRAIN_SYNC_FAILURES_DIR` nor `GBRAIN_HOME` set writes a scratch ledger (#7144) |
| A one-shot read (`search`, `query`, `get`) behind a transaction-mode pooler | printed the prepared-statements banner every time and re-read config per key | prints the banner once per database per gbrain home, reads config once for startup and once for the operation, and skips write-only startup cleanup (#7147) |

On a 5,000-page test brain behind PgBouncer in transaction mode, a cold `gbrain search` went from 115 to 69 database round trips (p50 1,271 ms to 576 ms), `query` from 127 to 81 and `get` from 22 to 15. Per-key config reads went from 32 to 0.

Nothing changes on upgrade. `--tier quick` is opt-in, and the default doctor run is unchanged apart from recording last known results.

### For contributors

- The CI Postgres containers (Ubicloud gate VMs, `docker-compose.ci.yml`, the `e2e.yml` services) get a 1 GiB `/dev/shm`. With Docker's 64 MiB default, a parallel HNSW build's 64 MiB dynamic shared memory segment failed with 53100 "No space left on device" whenever another parallel operation held shared memory.
- The #7145 Postgres arms run from `test/e2e/*-postgres.test.ts` wrappers, not `test/postgres-unit-arms.txt`.

## [0.60.332.0] - 2026-10-21

**`search` and `query` stop spending result slots on copies of one page, and `--explain` shows both retrieval arms again.** The same page in two sources, a merge stub beside its target, and the summary and transcript of one document each used to take their own slot in the top 10. They now fold into the best-ranked row, which lists what it absorbed in `collapsed`.

### What changed

| Situation | Before | Now |
|---|---|---|
| The same slug in two sources with copied bodies | two rows | one row; the other copy is listed in `collapsed` (reason `twin`) |
| A merge or redirect stub and its target | the stub could rank above the target | the target takes the slot; a stub whose target can't be returned stays, stamped `redirect_to` and ranked ×0.5 |
| Summary, transcript and diarized copies of one document in one directory | one slot each | one row (reason `family`) |
| An organization question that names no person | the founder's page could outrank the company | person pages ×0.85 |
| An image page whose text covers half the query or less | ranked like a text page | ×0.6, stamped `image_page` |
| An undated page on a "when" question | no penalty | ×0.85 |
| `score` down the result list | could go up | follows rank; the previous value is `fused_score` |
| A chunk row longer than 8,000 characters | returned whole | cut at 8,000 with a marker naming the read for the rest; `snippet_chars: 0` returns it whole |
| `gbrain search/query --explain` on a hybrid brain | printed `arms: []` and `rrf: not_run` | shows both arms, with fusion and blend applied |
| A keyword or vector arm that timed out, on the CLI | nothing said so | a `degraded_recall` notice on stderr, `--json` included |
| The `query` tool description | implied expansion helps | says `expand` is one LLM call and rarely helps |

Opt-outs: `search.collapse false` and `search.rank_priors false`. Nothing is rewritten on upgrade.

## [0.60.331.0] - 2026-10-20

**Writing many facts at once no longer costs one guard call per row, new pages over 4 MiB reply as soon as they commit, and a remote `append_page` links what it mentions.** The facts purge refusal and withdrawal stamp ran once per row, so a 6,000-row publish spent most of its publication deadline in triggers (#7105). A managed import of a large new page waited for its whole search index to build before replying, which on a loaded host outlasted the deadline (#7106). A remote append added text with links that never became graph edges (#7122).

### What changed

| Situation | Before | Now |
|---|---|---|
| A publish inserts thousands of facts | the purge refusal and the withdrawal stamp ran once per row | they run once per statement over the inserted rows; `INSERT … RETURNING` still sees the stamp (migration v264) |
| A managed `gbrain import` or `gbrain sync`, or a `put_page`, of a new page over 4 MiB stored in segments | replied after its search index was built | replies at commit with `searchable: 'pending'`; the index builds in the background, one at a time. Edits still reply when sealed |
| A remote `append_page` to a page body with `[[wikilinks]]`, markdown links or page paths | no links were added | plain `mentions` links (`mcp-remote-mention`) to existing pages the writer can see |
| An owner `append_page` to a page with a purged claim | (undocumented) | still not an owner edit, so it doesn't release the claim's redaction (#7123) |
| A lane sync reaches a page whose preparation ran past its budget | another lane could claim and prepare it again, overwriting its deadline | the worktree waits for the abandoned preparation to end, and so does a foreground write to it |

Nothing changes on upgrade beyond migration v264, which replaces the per-row facts triggers with statement-level ones.

### For contributors

- `test/sync-pass-xid-arms-gbra108.test.ts` drew snapshot xmax values PostgreSQL never reports (`TransactionIdAdvance` skips low words 0–2), so it failed whenever a new migration moved `txid_current()` onto them. It now draws only reportable values.

## [0.60.330.0] - 2026-10-20

**Sync no longer deletes a page just because its file is missing when Git never had that file, and the autopilot purge no longer hard-deletes what a sync deleted without review.** A large managed source lost thousands of agent-written pages: their write-through files sat in a `.gitignore`d directory, so they were never committed; when they left the disk, sync read their absence as deletions (4% of the source, under the 50% valve), and the purge phase hard-deleted them 72 hours later (#7130, reported by @liuwenyong1985).

### What changed

| Situation | Before | Now |
|---|---|---|
| A live page's file is missing and Git never committed it (ignored, or never added) | managed sync soft-deleted the page | the page is held `file_drift` (side `deleted`, reason `never_committed` or `ignored`); a person decides with `gbrain repair file-drift --prefer file` |
| A committed file is removed in a commit | the page is deleted | unchanged |
| One sync run deletes many pages below the 50% valve | nothing stopped it | `sync.max_deletes` (500) and `sync.max_delete_ratio` (1%, above 50 deletes), per source too, withhold the deletes and ask the user; managed passes, classic `sync --full` and working-tree syncs |
| Classic `sync --full` when `git log --all` fails (a dangling ref) | every stale page was deleted | every stale page is kept, with a warning |
| The autopilot purge reaches a sync tombstone no live page duplicates | hard-deleted after 72 h | held (`sync_delete_unreviewed`); `gbrain pages purge-deleted` purges it after consent |
| The purge window | fixed 72 h | `purge.retention_hours`, which can only lengthen it (default and minimum 72) |
| A managed put_page or capture of a new page into an ignored directory, on a source without Git durability | wrote a file Git would never commit | the page is database-only |
| Pages a sync already deleted this way | no way to find them | doctor `uncommitted_sync_deletions` and the preview-first `gbrain repair uncommitted-deletions --source <id>` restore them database-only |

Pages the purge already hard-deleted come back only from a backup (`pg_dump`, or a `gbrain backup create` taken before the purge). Nothing changes on upgrade; the repair runs only when named.

## [0.60.329.0] - 2026-10-20

**Five tests that failed once each on CI are fixed at their causes, and two of the causes were real bugs.** An unchanged transcript re-ingest on Postgres could admit a no-op page write (and spend a request id), and a sync that held its lock while a write admission rebuilt the database pool threw at the very end and left its lock row behind.

### What changed

| Situation | Before | Now |
|---|---|---|
| Re-ingesting an unchanged transcript right after its page was written (Postgres) | the unchanged-page screen counted the just-committed write as still pending while its post-commit cleanup ran, so the rerun admitted a no-op put_page | only unfinished writes (queued, running, recovering) hold the screen; a finished write's page and canonical file are final |
| A sync whose lock was held across a reconnect (a write admission that lost its connection) | the lock release ran on the ended pool: `CONNECTION_ENDED` after the work finished, lock row left until its TTL | release and exit cleanup run on the engine's live pool |
| `worker-shutdown-error-matrix`, `persistence-memory-mutations`, belief-ledger probe 17 | each could fail on a loaded runner | each waits for the event its contract names (handler started, provider call in flight, consumer disposed) |

No timeout, budget, retry or assertion is loosened.

## [0.60.328.0] - 2026-10-20

**A Google API that's disabled in your OAuth project is now reported as itself, all at once, instead of looking like a different account.** When Gmail, Calendar or People was disabled (or a scope wasn't granted), a managed Google source could not read the account, so the sync failed or refused with `connector_account_changed`, and setup only found out one API at a time. The account now resolves through Google's sign-in identity, the services that work keep syncing, and setup, `gbrain google status` and doctor name every disabled API with its project and enable link in one report.

### What changed

| Situation | Before | Now |
|---|---|---|
| A managed source whose Gmail (or People) API is disabled, other services fine | the whole sync failed with `api_not_enabled`, or refused as an account change | the account resolves through userinfo, the other services sync, the run is `partial` and names the disabled API |
| Nothing can name the account because of a network failure | refused as `connector_account_changed` (`account_unresolved`), and autopilot skipped the source | fails with the network error and retries next interval |
| A credential that really belongs to another account | refused `connector_account_changed` | unchanged |
| `gbrain google setup` with two APIs disabled | registered the source, then failed one API per sync | stops before registering (exit 2, `status: api_access_blocked`) naming every disabled API with its project and console link, every ungranted scope, and a narrower `--services` command for what already works |
| `gbrain google status` | refresh and calendar checks only | also `accounts[].api_access`, with `ok: false` and exit 1 while an API is disabled or a scope is missing |
| A Google 403 "insufficient authentication scopes" on a calendar read | reported as `calendar_unreadable` (pick another calendar) | `scope_missing`, fixed with `gbrain google connect --reauth <email>` |

### What to watch for after you upgrade

- Run `gbrain google status`. If it lists `api_access` problems, open each enable link (only the Google Cloud project owner can enable an API), or reauth for a missing scope, then run it again.
- Doctor's new `google_api_access` check reads what the last sync recorded; it makes no network call, so it clears after the next sync reaches the API.

### Itemized changes

- New doctor check `google_api_access` (operator resolution).
- `gbrain google setup` probes every requested service before registering a source; `gbrain google status` probes the services each linked source syncs.
- A disabled-API error carries the API, its title, the project and the enable link from Google's error body; only Google Cloud console links are relayed.
- When the Gmail label list fails, the loop-exclusion log says the label names could not be checked rather than that they are not labels.

## [0.60.327.0] - 2026-10-20

**Facts keep their words again, and a brain whose facts already lost them can get them back. The embed sweep for changed chunks now finishes on large brains.** Fact extraction ran the prompt-injection filter over the text it saved, and one rule matched the word "System" before a parenthesis, so "Acme Business System (ABS)" was saved as "Acme Business [redacted](ABS)" in the fact, its page's `## Facts` fence and its search chunks. Separately, the sweep that re-embeds chunks whose text changed was one statement over the whole brain; on a large brain it hit the statement timeout every run, from embed jobs and from the hourly maintenance pass, and kept nothing.

### What changed

| Situation | Before | Now |
|---|---|---|
| A fact names "Business System (ABS)" or similar | saved as "Business [redacted](ABS)" | saved as written; the filter rule matches only a code call such as `os.system("…")` |
| A stored fact holding an injection phrase reaches a model prompt (standing questions, turn context, proactive briefs) | sent as stored | the phrase is neutralized in the prompt copy; the stored fact is unchanged |
| Facts damaged before this release | stayed damaged | doctor `facts_redaction_marker` counts them; `gbrain repair redacted-facts` previews each restoration a source page proves, and `--apply --expect <hash>` writes exactly that set |
| The content-drift embed sweep on a large brain | one statement over every chunk; cancelled by the statement timeout on every run | 5,000-chunk batches with a saved cursor, at most 60 seconds per run, a new pass once a day (`embed.content_drift.pass_interval_hours`, default 24) |

### What to watch for after you upgrade

- Nothing is repaired on upgrade. Run `gbrain doctor --only facts_redaction_marker`; if it warns, `gbrain repair redacted-facts` shows what it can restore and changes nothing until you apply the printed command.
- The repair restores a fact only when the words on both sides of every marker occur in a page the fact came from. A fact with no such page, with two possible spans, or with its row in the fence of a page stored in segments is listed and left for you to edit by hand.
- A restored database-only fact gets `restored: redacted-facts repair` appended to its context, and its vector is re-embedded by the next `gbrain embed`.
- On a large brain the first drift pass now spans several runs; `gbrain doctor --only content_drift_sweep` shows each pass, its cursor and any error.

### Itemized changes

- New repair kind `redacted-facts` (explicit-only, preview-bound) and maintenance intent `managed_maintenance_restore_redacted_facts`.
- New doctor checks `facts_redaction_marker` and `content_drift_sweep`; new setting `embed.content_drift.pass_interval_hours`.
- Embed and embed-backfill job results report the sweep's state (`content_drift`).
- Google loops and `gbrain enrich` keep the raw text and quote instead of the filtered copy.
- Dependencies: `@modelcontextprotocol/sdk` 1.31.0 → 1.32.1 and the admin console's `vite` 6.4.3 → 6.4.4.
  - GHSA-22jm-h49p-29qw (high): the SDK's experimental task store did not tie a task to the session that created it, so clients sharing one store could list, read and cancel each other's tasks. gbrain's servers (`gbrain serve`, `serve --http`, `mcp expose`) never pass `taskStore`, so they were not exposed.
  - GHSA-6prh-2h8m-c8cw (medium): the SDK's HTTP client transport followed redirects to any origin, re-sending custom headers, the `mcp-session-id` and, on a 307 or 308, the request body. gbrain uses that transport as a client: the thin client, `gbrain connect`'s probe, harness verify and the shared-skills installer. Bun drops the `Authorization` header across origins, so a redirect could not take the bearer token. It could take the tool-call body (for example, page text sent to `put_page`), but only when the configured brain URL redirected to another origin. Redirects now stay on the same origin.
  - GHSA-698v-4r3x-3vcv (medium) is in the admin console's build tool (`vite`) and affects development servers only.

Reported by @mje-xyz (#7125) and @DaCal90 (#7117).

## [0.60.326.0] - 2026-10-20
