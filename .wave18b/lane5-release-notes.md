# Wave 18b lane 5: release notes (#5012 items 8, 9, 6)

The integrator merges these into CHANGELOG.md and `BEHAVIOR_CHANGES`
(`src/core/behavior-change-notice.ts`) at stamp time. `since` is the wave's
release; nothing here sets a version.

Issue status for the PR body: `Addresses #5012` (item 8: the reporter's own
bank alerts were not replayed, so this lane does not claim them fixed; item 9
and item 6 are fixed by the code and probes below).

## CHANGELOG bullets

### What you'd see

| Situation | Before | Now |
|---|---|---|
| A bank, payment or shipping alert sent with `Precedence: bulk`, `list` or `junk`, a `List-Id`, or a no-reply `Reply-To` | `gbrain waiting` lists it as a person waiting on you | no reply-owed loop opens; the sync log prints `[google] reply-owed loops withheld: automated_mail=N` |
| Older reply-owed loops from those senders | stay listed with no way out but one `loops drop <id>` at a time | `gbrain waiting` counts them and prints `gbrain loops drop sender <email> --source <id> --dry-run` per sender; the dry run lists ids, the apply closes them (cannot be undone) |
| `gbrain loops mute sender <email>` / `mute thread <id>` | stops new loops; existing loops stay open | also closes that sender's or thread's open reply-owed loops and prints the count and the `Undo:` command; `--dry-run` lists them first |
| `gbrain loops unmute ...` | loops closed during the mute stay closed | the loops the mute closed are re-checked on the next Gmail sync; one reopens only if nothing answered its thread since; `--dry-run` lists them |
| Gmail files a cold introduction under Updates | opens a loop | unchanged by default; `gbrain config set loops.updates_require_reciprocity true` (opt-in) requires that you wrote to the sender before Updates mail opens a loop |
| The source's calendar id is one the account cannot read (HTTP 403/404) | the sweep looks like an empty calendar | the sync logs `calendar_unreadable` with the fix; `gbrain google status` names it (`ok: false`, exit 1); doctor `google_calendar_readable` warns |
| Pointing a Google source at another calendar | edit `g_calendar_id` by hand | `gbrain sources set-calendar <source> <calendar-id>` |
| `gbrain config set search.contextual_retrieval <mode>` or `gbrain sources set-cr-mode` | silent about existing pages | prints that existing pages keep their recorded mode and names `gbrain repair contextual-mode` |

### Itemized changes

- Loop noise (#5012 item 8). `src/core/google/google-clients.ts` captures `Precedence`, `List-Id` and `Reply-To`; `isPositivelyAutomated` (`google-render.ts`) and `detectThreadLoop` (`loop-detect.ts`) withhold the reply-owed open with a typed `withheld` reason (`automated_mail`, `updates_without_reciprocity`); closes are unaffected. The sweep records withheld senders in connector state (`loop_withheld_senders`, at most 2,000) and, once, re-checks the newest thread of up to 500 senders with open reply-owed loops (`loop-catchup.ts` `seedLoopRechecks`).
- Mute closes, unmute re-checks. `loops-store.ts` `closeMutedLoops` / `requeueMutedLoops` / `settleMuteRecheck`; the upsert never reopens a `muted` loop for the same counterparty and reopens a `mute_recheck` loop on the re-check's verdict. `loops_mute` returns `closed` (dry run `would_close`) and `undo_command`; `loops_unmute` returns `requeued`, `unverifiable`, `stale_source` with `recheck_command`, and `undo_command` (dry run `would_requeue`). Manual closes are never touched; a loop another mute still covers stays closed.
- `gbrain loops drop sender <email> [--source] [--note] [--dry-run]` (`src/commands/loops.ts`); `open_loops` grouped view and `gbrain waiting` add `withheld_noise`.
- New opt-in key `loops.updates_require_reciprocity` (default `false`, boolean, off value `false`; validated at `config set`) in `src/core/google/loops-reciprocity.ts`.
- Unreadable calendar (#5012 item 9). `GoogleForbiddenError` and `CalendarClient.probeCalendar`; the calendar sweep records `calendar_unreadable` without failing the run (`people-calendar-sweep.ts`); `gbrain google status` probes live (`--no-probe` reads the record); new doctor check `google_calendar_readable`; new error code `calendar_unreadable`; new `gbrain sources set-calendar` (`src/commands/sources-set-calendar.ts`; on a managed brain whose source also syncs Gmail or Contacts it needs `--yes`, exit 3 `confirmation_required` otherwise, because the cursor is keyed by the source's configuration).
- Contextual retrieval hint (#5012 item 6): `src/commands/config/contextual-mode-hint.ts`, printed by `config set search.contextual_retrieval` and `sources set-cr-mode`.
- Tests: `test/loops-noise-5012.test.ts`, `test/loops-noise-5012-store.test.ts` (+ `test/e2e/loops-noise-5012-postgres.test.ts`), `test/google-calendar-unreadable-5012.test.ts`, new cases in `test/google-loop-detect.test.ts` and `test/google-clients.test.ts`. Every case fails on master 3c16e9ba (31 failing tests) and passes on the branch.
- Docs: `docs/guides/open-loops.md`, `docs/guides/google-connect.md` (Unreadable calendar), `docs/guides/troubleshooting.md`, `docs/guides/multi-source-brains.md`, `skills/google-loops/SKILL.md`, key-files entries.

## BEHAVIOR_CHANGES rows (append; `since` = the wave's stamp)

```ts
  // Wave 18b lane 5 (#5012 item 8).
  { since: '<wave release>', text: 'Gmail mail sent with `Precedence: bulk`, `list` or `junk`, a `List-Id` header, or a no-reply `Reply-To` no longer opens a reply-owed loop in `gbrain waiting`. Loops opened before this release stay open: `gbrain waiting` counts those from such senders and prints `gbrain loops drop sender <email> --source <id> --dry-run` for each (preview, then run without `--dry-run`; a drop cannot be undone).' },
  { since: '<wave release>', text: '`gbrain loops mute sender|thread` (`loops_mute`) now also closes the muted sender\'s or thread\'s open reply-owed loops (status `dropped`, `closed_by: muted`) and returns their ids in `closed`; before, existing loops stayed open. `gbrain loops unmute` (`loops_unmute`) queues those loops for a re-check on the next Gmail sync, which reopens one only when nothing answered its thread since, and returns `requeued`. Both take `--dry-run` (`dry_run`) and return an `undo_command`. Commitment and decision loops and manually closed loops are not touched.' },
  // Wave 18b lane 5 (#5012 item 9).
  { since: '<wave release>', text: '`gbrain google status` now reads each linked Google source\'s calendar once (`--no-probe` skips it) and, when the account cannot read it (HTTP 403 or 404), names it with `code: calendar_unreadable` and the fix, and reports `ok: false` with exit code 1. The sync records the same result instead of looking like an empty calendar, and doctor warns `google_calendar_readable`.' },
```

The item 6 hint and the opt-in key change nothing by default and need no row.
