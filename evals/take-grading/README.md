# Take-grading eval (W6, wave 4b)

Measures which chat models may grade a forecasting take: when the `grade_takes` cycle phase's auto-resolve rule would apply a verdict (not `unresolvable`, confidence at or above `GRADE_TAKES_AUTO_RESOLVE_THRESHOLD`, 0.95), how often is it wrong? The result decides `GRADE_TAKES_MEASURED_MODELS` (`src/core/cycle/grade-takes-measured.ts`), which `gbrain takes grades` uses to mark verdicts no measurement backs. Auto-resolve stays off. The preregistration is [`PREREGISTRATION.md`](PREREGISTRATION.md); raw results and the verdict are mirrored into gbrain-evals (`docs/benchmarks/2026-10-16-take-grading*`).

## Current result

Not yet measured on the counted split; `GRADE_TAKES_MEASURED_MODELS` is empty. The dev rounds that shaped prompt `hybrid-evidence-v2` and the parser are summarized in the preregistration.

## What's here

| File | Role |
|---|---|
| `cases.ts` | Seeded builder of 908 synthetic takes with dated evidence: dev 118, counted 790, across eight sets in the rule (resolved correct and incorrect, pre-horizon, pre-claim, no evidence, restatement, near-name distractor, real-world proposition without evidence) and two exploratory sets (partial, world counterfactual). Placeholder names only. |
| `generate-fixtures.ts` | `cases.ts` → `fixtures.jsonl` (committed). Counted is built first and dev avoids its claims. Regenerate after editing a case; the keyless test fails on drift. |
| `check.ts` | The $0 instrument checks (counts, placeholders, the dates each set promises) and the production take row and evidence block each fixture becomes. |
| `score.ts` | Pure grading and summaries: applied and wrong per verdict, coverage, abstention, the Clopper-Pearson bound, the decision rule and the ranking. |
| `report.ts` | The JSON report and the Markdown tables, including the proposed `GRADE_TAKES_MEASURED_MODELS`. |
| `harness.ts` | Runner: `--check` ($0), live (`--model`, `--split`, `--out`, `--max-usd`: the production `defaultJudge` call per fixture; the counted split needs `--preregistration <commit>`) and `--score`. |

The keyless test is `test/eval-take-grading.test.ts`. It guards the instrument, not the score.

## Running

```bash
# Prove the instrument ($0, no key):
bun evals/take-grading/harness.ts --check

# One live dev run (needs the provider key; stops at the cap):
bun evals/take-grading/harness.ts --model openai:gpt-6.1-sol --split dev --out results/gpt-dev.jsonl --max-usd 1

# A counted run, only after PREREGISTRATION.md is frozen:
bun evals/take-grading/harness.ts --model openai:gpt-6.1-sol --split counted --out results/gpt.jsonl --max-usd 3 --preregistration <commit>

# Score saved runs ($0):
bun evals/take-grading/harness.ts --score results/*.jsonl --json summary.json --md summary.md
```

## Metrics

- **Wrong share of applied verdicts** (preregistered): one-sided 95% Clopper-Pearson upper bound at most 1%, so at least 299 clean applied verdicts.
- **Coverage**: resolvable takes applied and right, over resolvable takes in the rule.
- **Abstention**: unresolvable takes not applied, over unresolvable takes in the rule.
- **No answer**: no usable verdict (parse failure, provider unavailable); safe, reported apart.
- **Cost and latency**: USD per verdict from gbrain's price table; wall time p50 and p95.

Ranking: qualifying models first, by coverage, ties to the cheaper model.
