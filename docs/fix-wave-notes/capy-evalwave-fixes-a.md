# Eval-category wave, fix lane A (`capy/evalwave-fixes-a`)

Bugs from gbrain-evals (branches `capy/wave-n7-n8` and `capy/wave-n12-n13`,
ledger `docs/benchmarks/2026-10-01-wave-bugs.md`). Every item has a failing
test first (the ported repro), then a root-cause fix. No version bump or
CHANGELOG entry: the integrator owns those.

## N8-1 / N8-2 — private pages in ambient recall (privacy)

`resolveEntitiesToPointers` (`src/core/context/retrieval-reflex.ts`) queried
`pages` with no visibility predicate, so `volunteer_context` returned a
`visibility: private` page's title and synopsis to remote callers, and the
turn hook block (`assembleTurnContext`, turn mode) injected it.

- The resolver now takes `excludePrivate` (default **true**, fail-closed) and
  applies `privatePagesFilterFragment` — the remote-search predicate,
  including derived-private atoms and concepts — on every arm: the alias
  liveness check (so a hidden page also stops counting toward alias
  uniqueness), the title/slug/surname query, alias hydration and the CJK arm.
- `volunteer_context` passes `resolveExcludePrivatePages(ctx.engine,
  ctx.remote)`: remote callers on stdio and HTTP are filtered (honouring the
  operator's `search.remote_private_pages` opt-out exactly like search); the
  trusted local CLI still sees private pages.
- `assembleTurnContext` turn mode passes `excludePrivate: true` explicitly
  for pointers and volunteered pages (documented world-only posture).
- Audit of the other context/reflex paths: the serve IPC `resolve` handler,
  the direct-Postgres reflex rung, `gbrain watch` and the BrainBench adapters
  all call the resolver without the option, so they inherit the world-only
  default. `pack`/`delta` modes were already filtered (entity cards and
  `listPages({excludePrivate})`). `recall-needed.ts` already passed
  `excludePrivate: true`. **`compile-context` had the same gap**: it listed
  pages without a visibility filter and wrote private titles and excerpts
  into `.claude/gbrain-context.md` / `AGENTS.md`; every `listPages` arm in
  `compile-view.ts` now passes `excludePrivate: true`.
- Tests: `test/reflex-private-visibility.test.ts` (title, alias, surname and
  derived-atom windows; stdio and HTTP remote callers; local presence
  control; turn block; resolver default vs explicit widen), run on PGLite and
  on Postgres via `test/e2e/reflex-private-visibility-postgres.test.ts`;
  `test/compile-view.test.ts` private-page case.

## N7-1 — a nudge hid an overdue request on first sight

`detectThreadLoop` measured the 24h/72h grace windows from the last message.
They now run from the oldest message in the trailing run (substantive
messages since the last turn flip) that carries the obligation: the first
inbound message with me in To:, or my first outbound question. A fresh run
stays inside grace; a run that started after my reply restarts the clock;
CC-only mail does not start it. Corpus cases added to
`test/google-loop-detect.test.ts`; `docs/guides/open-loops.md` states the rule.

## N12-1 — bold labels parsed as a conversation

New `PatternEntry.repeat_speaker_min_turns`, set to 3 on `bold-name-no-time`:
when the parsed body has at least three turns and no speaker ever speaks
twice, the orchestrator returns `no_match`. Density scoring cannot see this
shape (3 of 26 lines clears the 0.05 floor). All 61 conversation-format
fixtures (`test/fixtures/conversation-formats/*.jsonl`) give the same result
before and after; single-line and two-turn bodies are unaffected.

## N12-2 — offset timestamps re-parsed one day early

`renderSessionParts`' `anchorTimestamp` paired the date sliced from the raw
string with the UTC hour. It now takes both from the same UTC instant, and the
session date (slug, frontmatter `date`) is normalized too. The claude-export,
claude-code, codex and openclaw adapters normalize offset-bearing timestamps
to UTC through the shared `utcTimestamp` helper (`transcripts/types.ts`);
UTC strings pass through byte-identical, so existing imports do not churn.
Test: `test/transcript-offset-timestamps.test.ts`.

## N13-1 — short `const f = () =>` functions lost their names

`mergeSmallSiblings` treated a function-valued `lexical declaration` as a
mergeable const run. `declaresFunctionValue` (`chunkers/def-types.ts`) marks
TS/JS declarations whose declarator value is an arrow function, function
expression or generator; the chunker stamps `definesFunction` and the merge
guard protects those chunks. Plain const value runs still merge.
`CHUNKER_VERSION` 7 → 8 so existing indexes re-chunk (version-pin tests
updated). Tests in `test/chunkers/code-merge-defs.test.ts`.

## N13-2 — `resolved: false` on resolved edges

The shared row mapper (`engine-sql/code-edges.ts`, now also used by the
PGLite `getEdgesByChunk`) reports `resolved: true` for a `code_edges_symbol`
row the resolver stamped with `edge_metadata.resolved_chunk_id`.
`to_chunk_id` still reports the stored column, so two-pass retrieval is
unchanged.

## N13-3 — language gate picked an arbitrary namesake

`runRecursiveWalk` read the language of one arbitrary chunk carrying the
qualified name. It now reads every defining chunk's language and refuses only
when none is supported. When an unsupported-language namesake shares the
name, edges whose origin chunk is not in a supported language are dropped,
so a Python walk does not list the Go callers. Tests:
`test/code-intel/n13-edge-resolution.test.ts` (PGLite) and
`test/e2e/code-intel-n13-postgres.test.ts`.

Overlap note: open community PR #5835 also edits
`src/core/code-intel/recursive-walk.ts` (remote read policy); expect a small
textual merge there.

## N12-7 — legacy pack attendance

Handed to lane B (owns `link-extraction.ts` attendance and direction); not
touched here.

## Repro results (gbrain-evals scripts against this checkout)

| Item | Before (3a284ae) | After |
|---|---|---|
| N8-1 | private page + synopsis returned to remote caller | `[]` |
| N8-2 | block lists the private page and synopsis | `""` |
| N7-1 | `open=[]` | `open=[["unanswered_inbound","bob@example.org"]]` |
| N12-1 | exit 1, 3 fake speakers | exit 0, `no_match` |
| N12-2 | exit 1, re-parsed `2026-08-10T05:30Z` | exit 0, `2026-08-11T05:30Z` |
| N13-1 | exit 1, `code_def_count: 0` | exit 0, `src/sample.ts:3` |
| N13-2 | exit 1, `resolved: false` | exit 0, `resolved: true` |
| N13-3 | exit 1, `unsupported_language` | exit 0, `ok` |
