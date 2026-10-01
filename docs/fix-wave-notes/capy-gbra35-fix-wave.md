# Fix-wave notes: capy/gbra35-fix-wave (GBRA-35)

Retrieval, memory hygiene, dream lock, Mac verify and federated link reads.
Contributor branch for fix wave 6. The collector writes the version and the
single CHANGELOG entry; this file carries the text, evidence, closes and credits.
Base: `capy/fix-wave-5` (a551d84b, master v0.60.27.0 plus fix wave 5). No
schema migration.

## CHANGELOG text (symptom-first)

- **Hybrid search on large Postgres brains no longer quietly falls back to keyword-only results (#5824).** The vector arm checked content freshness inside the HNSW candidate scan. Postgres can't estimate that check, so the planner dropped `idx_chunks_embedding`, scanned every chunk and hit its 8 s budget. A since+until date filter on vector search did the same. The freshness check now runs after the index scan, so chunks edited after embedding are still never returned, and a date range keeps the index. On a 160k-chunk brain, vector search goes from about 500 ms to about 15 ms (p50) with identical top-10 results. A new `gbrain doctor` check, `vector_plan`, confirms the index is used. If vector search regresses after upgrading, run `gbrain config set search.vector_legacy_guard true` (or set `GBRAIN_VECTOR_LEGACY_GUARD=1`) on the brain host and restart serve and autopilot to restore the old statement for this release.
- **Pasted text no longer becomes "facts about you" (#5812).** When you paste an email, article or log into Claude Code, the Stop hook saves only your own words from that turn, and a turn that was only a paste saves nothing. The sweep, the serve harvest and dream `extract_atoms` never show pasted blocks to the extractor. Transcripts, the session corpus, recall and `synthesize` still keep the pasted text. To keep a paste as memory, save it with `gbrain remember "…" --provenance "…"`. Facts extracted from pastes before this release stay until you remove them with `gbrain forget`.
- **gbrain's own claude-cli calls stop filling your memory (#5820).** Each `claude --print` call from the claude-cli provider used to fire your Claude Code hooks, so it was banked as a conversation and extracted with another paid call. The provider now starts its child with hooks disabled (`--settings '{"disableAllHooks":true}'`), and your login is unaffected. The Stop hook, the serve harvest, the sweep and dream `extract_atoms` all skip these sessions. `gbrain doctor` (`self_capture`) shows when the newest one was captured and prints one-time quarantine commands for old files. The claude-cli provider now needs Claude Code 2.0.60 or newer; older CLIs get a clear upgrade message.
- **Nightly dream no longer skips for hours after a long atom drain (#5809, #5832).** A timed-out or cancelled `extract-atoms-drain` job, or one whose cycle lock was taken over, now stops at its next page and releases `gbrain-cycle:<source>`. The interrupted page takes no failure strike and nothing more is written. `gbrain dream --drain --window` is now a hard deadline: no new page starts after it. `--drain` exits 0 only when the backlog drained; every other stop exits 3, reports `stopped` and `remaining`, and prints the rerun command. The routine cycle's `extract_atoms` phase also stops on an autopilot-cycle timeout, and a `cycle_already_running` skip names the lock holder.
- **`bun run verify` works on a stock Mac again (#5810).** `scripts/check-retired-phrases.sh` didn't parse under macOS `/bin/bash` 3.2. CI now parses every tracked shell script with the real bash 3.2 parser (`bun run check:bash32`), and the macOS 26 job runs `bun run verify` under `/bin/bash`.
- **`gbrain embed --stale` no longer reports success for pages it skipped (#5804).** A page edited or retagged after the run started now counts as a failure (non-zero exit), with one summary naming the pages and how to retry.
- **Link and graph tools work on multi-source brains (#5827).** `get_links`, `get_backlinks` and `traverse_graph` no longer return nothing for agents connected without a source grant: they read the same federated sources as `search`, a granted token stays inside its grant, and private pages stay hidden. Locally, `gbrain links` (new name; `get_links` still works), `gbrain backlinks` and `gbrain graph` read every federated source when no source is pinned, accept `--source-id` and `--all-sources`, refuse `--source` combined with either, and print a rerun hint when a page's links live in a source outside the read. Graph output carries source ids (`source_id` on nodes, `from_source_id`/`to_source_id` on edges). Behavior change: on thin clients the link commands follow an ambient `GBRAIN_SOURCE` or `.gbrain-source` (use `--all-sources` to span), and against an older brain host that ignores the scope they fail with an upgrade instruction instead of printing unscoped results.

## Closes

- Issues: #5824, #5812, #5820, #5809, #5832, #5810, #5804, #5827.
- Superseded PRs, to close with a pointer after the wave merges: #5803 (option A, code-only, replaces its statistics + migration; title-FTS index deferred), #5833 (ported with credit), #5811 (ported), #5805 (ported), #5046 and #5479 (drain window as a hard deadline is covered).
- #5558 / #5815: already fixed by fix wave 5 (#5839), which deleted the line.

## Credits

Ported code carries `Co-Authored-By` trailers: @andreineacsu (#5833), @mml-studio (#5811), @furuchanchan (#5805), @benswinney (the #5812 patch). Diagnosis credit: the #5824 reporter (@clatyceo) for the EXPLAIN analysis and option A, @morven-ai for #5803, @clatyceo for #5820, @greenwayveterinary-tech for #5827.

## Evidence

- #5824 reproduced on 3a284ae: 40k pages, 160k vector(1536) chunks, PostgreSQL 16.15 + pgvector. The emitted statement ran a seq scan in 469 ms; with the freshness check out of the CTE it ran an HNSW scan in 14 ms. Bench (`scripts/bench/vector-plan-5824.ts`), before → after p50/p95 ms: current 506/630 → 15/24, 10% stale 449/493 → 16/27, 30% stale 377/399 → 15/27, re-embedded with stale statistics 501/550 → 20/38. Top-10 overlap was 1.00 in every phase, with no underfill.
- Every fix has a test that fails with its source change reverted and passes with it. Lane logs record the commands and counts (vector, pasted content, self-capture, drain, bash 3.2, embed, links).
- The macOS 26 runner passed `bun run verify` under `/bin/bash` 3.2.57.
- The claude CLI hook probe on 1.0.90 through 2.1.287: `--settings '{"disableAllHooks":true}'` suppresses user hooks and keeps OAuth. 2.0.60 is the oldest CLI that accepts the provider's full argv. Managed-policy hooks still run on 2.1.x (policy wins); the Stop, harvest and sweep skips cover that case.

## Deferred (TODOS)

- Remove `GBRAIN_VECTOR_LEGACY_GUARD` / `search.vector_legacy_guard` next wave, with a one-time notice if it is still set.
- Write-time freshness for stale vectors (null the vector or store an `embedding_current` flag) so stale rows stop taking candidate slots.
- Per-column date spelling for the keyword and CJK arms.
- #5803's title-FTS expression index.
- `gbrain auth permissions <name> set-source …` CLI for legacy tokens (#5827 suggestion 3).
- #5831: atom facts without `entity_slug`.
- Provenance-based withdrawal of facts already extracted from pastes or self-captures.
- `gbrain graph-query` on a thin client should forward `--source`.
- Managed atom retry (`persistence/atom-retry.ts`) ignores the cycle lock's lease signal.
- A heap flag for `bun run typecheck` on 8 GB Macs (the macOS runner needed `--max-old-space-size=4096`).
