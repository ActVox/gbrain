# Forecast-journal gate (W7)

The $0 synthetic gate for the private forecast journal (`src/core/forecast-journal.ts`, `gbrain takes journal`, `gbrain takes scorecard --group-by`). It checks three things on placeholder holders of known skill and placeholder topic pages:

- whether the per-holder statistics rank holders in their true order;
- whether the journal answers "who was right about T" and keeps the unresolved denominator;
- whether remote callers see none of it while their existing output stays the same.

The preregistration is [`PREREGISTRATION.md`](PREREGISTRATION.md).

## Current result

Not run yet.

## What's here

| File | Role |
|---|---|
| `fixtures.ts` | Deterministic generator: 20 cohorts. Each has 12 holders of skill 0.30 to 0.90 (10 to 30 resolved predictions each), 2 low-n holders, one overdue and one open prediction per holder, and one undated take, over 40 topic pages. Placeholder names only. The output hash is frozen in the preregistration. |
| `score.ts` | Pure statistics: Spearman ρ (average ranks for ties), set F1, the median, and the preregistered decision rule. |
| `harness.ts` | `--check` ($0 instrument check) and `--run` ($0, in-memory PGLite: loads the cohorts, applies the horizon scan, measures through the production readers and op handlers, and applies the rule). |

The keyless test is `test/eval-forecast-journal.test.ts`. It guards the instrument, not the score.

## Running

```bash
bun evals/forecast-journal/harness.ts --check
bun evals/forecast-journal/harness.ts --run --json summary.json --md summary.md
```

Both cost $0 and need no key. `--run` exits 0 when the gate passes and 1 when it fails.
