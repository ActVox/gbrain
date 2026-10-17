# Private forecast journal (wave 4b W7)

Status: in progress (draft PR). Plan: gbrain-evals `docs/plans/2026-10-07-10x-memory-advantage/PLAN.md`, wave 4, row W7.

W7 makes each prediction in a brain auditable for its owner: what was predicted, when, by when it had to come true, how it was resolved and on what evidence, and how many predictions are still open. It extends `takes_scorecard` and `gbrain takes scorecard` instead of adding a `track_record` op. Everything new is private, which means trusted local only. `takes_scorecard` keeps returning exactly what it returns today to remote callers. Nothing public about real people ships from this wave.

## Slice 1 (this change): the horizon

The horizon of a take is the last day its claim can come true: `2024-12-31` for "by the end of 2024", `2024-09-30` for "by Q3 2024". Without it, the journal cannot tell a prediction that is overdue from one that is still open.

**Where it lives.** It goes in a table of its own, `take_horizons`, one row per take (migration v251 for now; the number is taken when the merge slot is called). It does not go in either of the two obvious places:

- **The takes fence.** Changing the fence format would make sync hold files. Garry's decision is an additive DB column, not a fence-format change.
- **A column on `takes`.** `takes_list` and `takes_search` return `t.*`, so a new column would reach remote callers. That would break the rule that remote output stays the same, and it would leak a private field.

| Column | Type | Meaning |
|---|---|---|
| `take_id` | `BIGINT PRIMARY KEY REFERENCES takes(id) ON DELETE CASCADE` | The take. The row is deleted when its take is. |
| `claim_sha256` | `TEXT NOT NULL` | The sha256 of the claim the horizon was set for. If the claim is later edited, the row stays as written but reads as not current, so a horizon never carries over to a different proposition. |
| `horizon_date` | `DATE NOT NULL` | The last day the claim can come true. |
| `basis` | `TEXT NOT NULL`, one of `stated`, `stated_relative`, `owner` | How the horizon was set (see below). |
| `set_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | When it was set. |

The three bases:

- `stated` is an absolute deadline in the claim's own words: "by the end of 2024", "by the end of Q1 2025", "by Q3 2024", "by March 2025", "before 2025", "by 2026".
- `stated_relative` is "within N months" or "within N years", counted from `since_date`. It is only as certain as `since_date`. On a source without recording, that date is the uncertified one, and the journal labels it `uncertified` (Garry, 2026-10-17).
- `owner` is set by the owner. A scan never overwrites it.

**No page text is stored.** The table holds dates, an enum, a hash and a timestamp. That keeps it outside the purge surface (`text_free_ledger` in the deletion inventory). Graduation copies it as user data. Postgres's RLS event trigger covers it.

**Nothing is written on upgrade.**

- `gbrain takes horizon scan` lists each take's stated horizon. It writes them only with `--apply`.
- `gbrain takes horizon set <slug> --row N --date YYYY-MM-DD` and `clear` are the owner's own edits.
- None of these has an MCP op. A thin client refuses them as host-bound.
- The parser returns nothing in three cases: when a claim states no deadline, when it states two different deadlines, or when it states a relative deadline without a usable `since_date`. It does not guess.

**What stays the same.** `takes_list` and `takes_scorecard` return byte-identical output, locally and to remote callers, whether or not horizons exist. Tests on PGLite and Postgres check this.

## Next slices (same PR, before it leaves draft)

1. **Prediction time.** On sources with recording, the time a take was first recorded comes from the belief ledger (the first `take.asserted` event for its claim) and is certified. Elsewhere it falls back to `since_date`, labelled `uncertified` wherever it shows.
2. **The journal view.** `gbrain takes journal` (trusted local) shows every prediction with:
   - its prediction time and certification;
   - its exact claim;
   - its horizon and basis;
   - its state: open, overdue (past the horizon and unresolved) or resolved;
   - its resolution and provenance: `resolved_by`, `resolved_source`, and the grade verdict when one is cached;
   - the denominator of unresolved predictions.
3. **`takes_scorecard {group_by}`.** `group_by` is `holder` or `source`. The new fields go only to trusted local callers:
   - Beta-shrunk accuracy;
   - Brier skill score against the holder's base rate;
   - recency decay;
   - citations;
   - `min_n` with a `low_n` flag;
   - cohort uncertainty.
   A remote caller gets today's output byte for byte. A remote caller that passes `group_by` gets a typed refusal, so it is never silently ignored. N6-style probes check both.
4. **Gate ($0, synthetic).**
   - Synthetic holders of known skill should give Spearman ρ ≥ 0.8 at n ≥ 10. This is a diagnostic.
   - "Who was right about T" is measured as set-F1.
   - Remote probes should show no access to the journal fields and byte-identical existing output.

The resolution policy for auto-resolve is out of W7's scope. Garry's decision (2026-10-16) is recorded with the take-grading follow-ups in gbrain-evals: a take whose numeric target was missed is never auto-applied, neither as `partial` nor as `incorrect`. It is held for manual review until the real sample settles which.
