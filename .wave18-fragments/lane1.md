# Wave 18 lane 1 fragment rows, S2 (integrator: apply, then delete this file)

Branch `capy/wave18-lane1`. Its `INTEGRATOR-ROW:` commits (`14758692e` FACTS_ABSORB_REASONS, `61909f1df`
regeneration, `d28162a45` upgrade-replay golden, `0cd5f30d6` llms-full.txt) hold the generated output and
registry rows the lane's tests and guards need; the S1 share of them is redone S1-only on `capy/wave18-lane1-s1`.
Drop or redo them at slot time as you prefer. Everything below is what each S2 item needs in integrator-owned files.

## Slot-time steps

This file holds the S2 rows (#6779, #6773, #6778, #6761, #6791, #6753). The S1 rows (#6757, #6782, wave 18a) are in
`lane1-s1.md`, from `capy/wave18-lane1-s1`, which this branch merges.

1. [S2] **Plugin trees and llms (#6753).** `skills/maintain/SKILL.md` changed:
   `bun run scripts/generate-plugin-tree.ts --out plugin --variants-out plugin-variants`, then
   `bun run build:llms` (llms-full.txt inlines docs/guides/cron-schedule.md). `bun run regen:all --goldens` does both.

## Registry rows

- [S2] **`src/core/facts/absorb-log.ts` `FACTS_ABSORB_REASONS` (#6778):** append
  `'write_pending_accepted', 'write_deferred_unadmitted',` after `'write_refused'`, and bump
  `test/facts-absorb-log.test.ts` from `length).toBe(17)` to `19` with two `toContain` asserts.
  Already in commit "INTEGRATOR-ROW: FACTS_ABSORB_REASONS ..." (typecheck needs it: commit
  "fix(facts): facts absorb waits ..." alone does not typecheck).
- [S2] **`src/core/error-registry.ts` `CODES` (#6791), alphabetical position, then `bun run build:error-codes`.** The adapter's
  once-per-process stderr notice already names the code and points at `gbrain errors continuation_unproven`:
  ```ts
  continuation_unproven: { class: 'retryable', summary: "Claude Code continued an answer past its output cap and gbrain could not prove the full text, so the claude-cli call returned no text and no tool calls and finished as length.", why: "Print mode reports only the text after an automatic continuation; parsing or dispatching that tail as a complete answer would act on a fragment. The caller retries or escalates as for any capped answer; the gateway does not resend it to a fallback model.", reasons: ['events_missing', 'no_assistant_events', 'segments_unmatched'], docs: 'docs/ai-providers/claude-cli.md#claude-cli-troubleshooting', fix: { argv: ['gbrain', 'config', 'set', '<KEY>', '<TOKENS>'], inputs: [{ name: 'KEY', how: "The output cap the failing caller's truncation warning names (for example dream.propose_takes.max_tokens, facts.extraction_max_tokens or models.synopsis_max_tokens)." }, { name: 'TOKENS', how: 'A larger whole number of output tokens; ask the user, since a larger cap can cost more per call.' }], consent: [], actor: 'agent', ask_user: true, why: 'A cap the whole answer fits under ends the call before Claude Code continues it, so the full text arrives in one response.', requires_exclusive: false, verify: { argv: ['gbrain', 'config', 'get', '<KEY>'] } } },
  ```
  Adjust the `fix` envelope to the registry's current consent/ask_user shape if it differs.
  The code is provider metadata, not a thrown code, so no contract test requires the row.

## BEHAVIOR_CHANGES rows (`src/core/behavior-change-notice.ts`, `since: '<wave version>'`)

- [S2] **#6778:** "Facts absorb now waits for its write up to the job deadline instead of 5 s. A write still committing is logged `write_pending_accepted` and writer contention before admission `write_deferred_unadmitted`; neither counts toward the doctor's facts_extraction_health threshold, and persistent contention gets its own warning (`gbrain sources writer status --source <id> --json`)."
- [S2] **#6761:** "facts_extraction_health reports its 24 h failure count as history (rolling, with an ages-out time) and separately names facts-absorb jobs still dead, with `gbrain jobs retry <id>` as the fix; it no longer suggests raising `facts.absorb_warn_threshold`, and the thresholds are unchanged."
- [S2] **#6791:** "A `claude-cli` answer that Claude Code continued after hitting its output cap is now rebuilt in full from the call's event stream (the CLI runs with `--verbose`) instead of returning only the text after the continuation as a complete answer. When the full text cannot be proven, the call returns no text and no tool calls, finishes `length` (callers retry or escalate as for any capped answer) and reports `providerMetadata['claude-cli'].code = 'continuation_unproven'` with reason `events_missing`, `no_assistant_events` or `segments_unmatched`, and one stderr line per reason per process naming its remedy (upgrade the claude CLI for the first two, raise the caller's output cap for the third)."
- [S2] **#6773 (optional):** "Generated dream-cycle summaries now carry `created: <summary date>` in their frontmatter, so they pass `gbrain lint`'s temporal check."

## CHANGELOG credit

- #6773 reimplements PR #6773 by @lubosxyz ("Contributed by @lubosxyz", `Supersedes #6773`). The branch
  commit's `Co-Authored-By` trailer uses `lubosxyz@users.noreply.github.com`; GitHub attributes this
  account (id 159481718) only through `159481718+lubosxyz@users.noreply.github.com`, so use that
  address in the PR body or squash message. The pushed commit was not rewritten (no force-push).
