# Fix wave 6, lane D: N2 contradiction surfacing

Branch `capy/evalwave-fixes-d`, based on `origin/capy/fix-wave-5` at `a551d84b`
(#5839 was still open). Bugs and keyless repros come from gbrain-evals
`capy/wave-n2-a4`, `docs/benchmarks/2026-10-01-n2-contradiction-surfacing/`.
No version bump or CHANGELOG entry; the collector owns both.

## N2-1: undated pages reached the judge with a date

Root cause: `searchResultToMember` (`src/core/eval-contradictions/runner.ts`)
copied `SearchResult.effective_date` verbatim. For a page with no frontmatter
or filename date, `computeEffectiveDate` stores the creation time with source
`fallback`, so every undated page reached the judge as `(from: <import day>)`
instead of `(date unknown)`. Two consequences: the date pre-filter's
"both sides have an effective date" rule always fired, so rule 1 never skipped
text-dated pairs, and `temporal_supersede` proposals ordered pairs by import
time, naming the wrong side as older.

Fix: a pair member keeps an effective date only when its source is a content
source (not `fallback`, not unlabeled), the same rule `deriveTimelineAnchor`
already applies. Take members inherit the null.

Tests: `test/eval-contradictions-runner.test.ts` "N2-1: …" (two cases, one
through `put_page` and the default `hybridSearch`). Both failed before the fix.
The keyless repro now prints `[]` for judge dates (the pair is skipped) and
`pairs skipped by the date filter: 1`.

Behavior note: on the N2 world the 20 `dated_change/text_dates` pairs are now
skipped by the pre-filter (dates more than 30 days apart in both texts), as
the filter documents. Their old `temporal_supersede` proposals were the ones
naming the wrong side (0 of 20 acceptable for the oracle judge).

Cached verdicts are keyed on text, not dates, so a pre-fix cached verdict can
still be returned for a pair. Its proposal is re-rendered with the corrected
dates, so the worst case is "date order unclear". The N2-3 prompt bump below
invalidates the cache anyway.

## N2-2: bare `gbrain find-contradictions` returned the unavailable note

Root cause: `makeContext` (`src/cli.ts`) always fills `ctx.sourceId`, falling
back to `'default'`. `find_contradictions` (`src/core/ops/insights.ts`) refuses
any caller with a scalar source because stored reports are brain-wide, so the
documented bare command (skills/correction-pipeline/SKILL.md) never worked.

Fix: `makeContext` marks `ctx.localSourceImplicit = true` when the source came
from a non-explicit tier (`local_path`, `brain_default`, `sole_non_default`,
`seed_default`, or the pre-init fallback), the same explicit/implicit split
#2561 uses. The op treats a scalar source as a filter unless that marker is set
and the caller is the trusted local CLI. Not widened: every remote caller,
unset trust, any federated grant, `--source <id>`, `GBRAIN_SOURCE`, and
`.gbrain-source` still get the unavailable note without loading the report.
`ops/context.ts` (another lane's file) is untouched.

Tests: `test/find-contradictions-cli-source.test.ts` drives the real
`makeContext` (bare reads the run; `--source alpha` and `GBRAIN_SOURCE=alpha`
refused; `--source __all__` reads). `test/salience-source-scope.test.ts` adds
the local-implicit read and three refusals (remote, unset trust, federated
grant) carrying the marker. Bare-command test failed before the fix. Also
checked end to end with `bun src/cli.ts find-contradictions --json` on a
keyless PGLite brain: the base returns the note, the fix returns the run.

The gbrain-evals N2-2 repro builds `{ remote: false, sourceId: 'default' }` by
hand, without the CLI marker, so it still prints the note. That context no
longer matches what the CLI builds.

## N2-3: judge prompt (shipped, PROMPT_VERSION 2 → 3)

Two rules added to `buildJudgePrompt`:

1. The three temporal verdicts need two different times (different `(from:)`
   dates or different dates in the text). Same-date or undated value
   conflicts are contradictions.
2. Only claims about the same entity can conflict. Look-alike names are
   different entities (`no_contradiction`). The example uses generic names,
   not N2 names.

Measurement: a matched before/after on a fresh N2 seed (20261002; the counted
seed is 20261001). Generator `n2-contradiction-gen/1.0.0`, judge
`anthropic:claude-haiku-4-5-20251001`, PGLite keyword-only retrieval, top 5,
cache off. "Before" is this branch with N2-1 and N2-2 (`e833e93d`). "After"
adds only the prompt change, byte-identical to this commit. Both arms judged
the same 1,371 offered pairs: all planted pairs plus a fixed sha256-sampled 40%
of unplanted pairs (820 distinct). The offered-key hash is identical across
arms. Scored with gbrain-evals `scoreClassification`.

| Metric | Before (v2) | After (v3) |
|---|---|---|
| Same-time conflicts called contradiction | 101/150 (67.3%) | 131/150 (87.3%) |
| … dated same day | 36/50 | 45/50 |
| … undated | 24/50 | 37/50 |
| … mixed dated | 41/50 | 49/50 |
| False contradiction, dated changes | 0/40 | 0/40 |
| False contradiction, compatible negatives | 3/50 | 2/50 |
| False contradiction, unplanted pairs | 59/820 (7.2%) | 11/820 (1.3%) |
| Judged-pair precision | 101/163 (62.0%) | 131/144 (91.0%) |
| Temporal recognition, dated changes | 40/40 | 40/40 |
| Judge errors | 0/1371 | 0/1371 |
| Acceptable resolution proposals | 141/190 | 171/190 |

Paired flips: planted conflicts gained 30, lost 0. Unplanted pairs lost 51
false contradictions and gained 3. Compatible negatives lost 2 and gained 1.
This is one judge sample per arm. The conflict flips are one-directional
(30 to 0), so noise does not explain them. Recall improved and every
false-contradiction rate fell or held, which meets the bar to ship.

Cost: $5.90 total ($2.78 before, $3.12 after, 2,742 requests), ledger-reconciled
under one $10 budget run (`n2-3-prompt-ab-2026-10-01T21-40-40-215Z-f873e9f2`,
gbrain-evals `.budget/ledger.json`). The driver was a scratch script reusing
the gbrain-evals generator, gold and scorer. It is not committed.

Operator impact: the bump invalidates the persistent judge cache, so the next
`gbrain eval suspected-contradictions` re-judges every pair and prints its cost
estimate first, as it does on any prompt change.

Test: `test/eval-contradictions-judge.test.ts` "N2-3: …" pins both rules and
the version. It failed before the change.

## Validation

- `bun run typecheck` and `bun run verify`: pass.
- Contradiction, source-scope, isolation-matrix, CLI flag and source suites:
  746 tests across 26 files pass on the N2-1/N2-2 commits. All 16 test files
  that use `makeContext` pass. The 265 contradiction tests pass with prompt v3.
