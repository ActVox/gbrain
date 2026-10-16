# Wave 18 lane 2, S2 fragments (scratch; the integrator applies these rows and deletes this file)

**Every row in this file is S2** (each row is tagged). S2 items: #6743, #6739, #6755, #6717 and the #6729 rename-identity remedy. S1 rows (#6729 core, #6741 A/B/C, #6749) are in `.wave18-fragments/lane2-s1.md`.

## #6743 fragment (integrator-owned rows)

Code commit: `7afd6f96c fix(bootstrap): converge shared-skills cleanup after a cleanup token is revoked (#6743)` (SHA as of format-patch; may change on integration).

Exit code 14 was the next free value on master 933a76779 (used: 0,1,2,3,4,10,11,12,13,69,75,124,130). The constant
`HARNESS_CLEANUP_PENDING_EXIT_CODE = 14` is already in `src/core/exit-codes.ts` (in the commit). **Integrator: check no other
wave lane also claimed 14**; if one did, renumber the constant and every row below together.

### [S2] 1. Error registry row — src/core/error-registry.ts

Insert into `CODES` in alphabetical position (between the `b…` neighbours, e.g. after any `bootstrap_*` code / before `brain_*`):

```ts
  bootstrap_cleanup_pending: { class: 'host_only', retryable: false, exit: 14, summary: "`gbrain bootstrap harness` wired and verified the harness, but cleanup of earlier shared-skills enrollments or carried previous token ids is still pending.", why: "A rotation leaves each old enrollment with that enrollment's own credential and then revokes the credential (leave_brain is principal-owned, so a revoked token can never leave). Each carried id is revoked and cleared on its own; an enrollment whose credential is already revoked is inert and finishes locally as credential_revoked. Until every id is cleared the run must not read as success, so --json lists each id's token state and cleanup state.", reasons: ['revoke_pending', 'leave_pending', 'enrollment_retained', 'credential_unreadable'], docs: 'docs/guides/bootstrap.md#cleanup-pending', suggestion: 'Follow the fix in the --json result: when every id can converge it re-runs the same bootstrap command; otherwise relay its user_message (restore the cleanup credential or revoke that token by id, or make the current enrollment ready), then re-run. Never revoke a token whose enrollment has not left unless its cleanup credential is lost.' },
```

Then regenerate: `bun run build:error-codes` (docs/guides/error-codes.md) and `bun run build:llms`.

Optional test once the row lands (test/exit-codes.test.ts, 'registry codes map onto the table'):
```ts
    expect(exitCodeForCode('bootstrap_cleanup_pending')).toBe(14);
```
and in 'the published values': `expect(exitCodes.HARNESS_CLEANUP_PENDING_EXIT_CODE).toBe(14);` (and add 14 to the documented-values list once the exit-codes.md row below lands).

### [S2] 2. docs/guides/exit-codes.md — exit table row

Insert after the `| 13 |` row:

```md
| 14 | `bootstrap_cleanup_pending`: `gbrain bootstrap harness` (or `--status`) wired and verified the harness, but earlier shared-skills enrollments or carried token ids are not cleaned up yet | the harness result with `status: "cleanup_pending"`, a per-id `cleanup` list and `fix` | follow `fix.next`: `run` re-runs the same command; `tell_user_to_run` relays the owner's revoke or restore step, then re-run ([cleanup pending](bootstrap.md#cleanup-pending)) |
```

### [S2] 3. docs/protocol/AGENT_OPERATOR_v1.md — exit table row

Insert after the `| 13 |` row (~line 997):

```md
| 14 | `bootstrap_cleanup_pending`: a harness is wired; old shared-skills enrollments or token ids still await cleanup | follow `fix.next` (re-run, or relay the owner's revoke step), then re-run |
```

### [S2] 4. BEHAVIOR_CHANGES row — src/core/behavior-change-notice.ts

Append to `BEHAVIOR_CHANGES` (since = the wave's release version):

```ts
// S2
  { since: '<wave version>', text: '`gbrain bootstrap harness` exits 14 (`bootstrap_cleanup_pending`, JSON `status: "cleanup_pending"`) instead of 0 when the harness is wired but earlier shared-skills enrollments or carried previous token ids are not cleaned up yet, and `--status` exits 14 instead of 1 for the same state; the JSON gains a per-id `cleanup` list and a `fix`. Each carried token id is now revoked on its own once no enrollment holds it, and an old enrollment whose token was already revoked finishes its local cleanup and counts as left (`credential_revoked`) instead of blocking every revocation. Doctor `bootstrap_harness_health` names each id as revoked (cleanup pending) or active and recommends leave before revoke.' },
```

### [S2] 5. Module size

No tsv change needed: src/core/bootstrap/harness.ts went 2611 -> 2584 (cap 2615, slack 31 < 50). Optional: lower its ceiling
with a note "-27 #6743: cleanup gate moved to harness-cleanup.ts". New file src/core/bootstrap/harness-cleanup.ts is 283 lines
(new-file cap 1500). src/commands/doctor/bootstrap-checks.ts 548 -> 552 (not listed; under 1500).

### [S2] 6. Docs already in the commit

docs/guides/bootstrap.md (new `#cleanup-pending` anchor), docs/guides/shared-brain-skills.md (revoked-credential sentence),
docs/architecture/key-files/agent-bootstrap.md (harness-cleanup.ts entry). Run `bun run build:llms` if llms-full inlines them.

### [S2] 7. Notes for review

- [S2] "No new id carried when cleanup is known-unresolvable" is met by per-id convergence: a rerun still rotates the current token
  into previous_ids, but that id's enrollment leaves and is revoked in the same run, so only the unresolvable ids stay
  (pinned: 'a cleanup no rerun can finish ... carries no new ids'). Minting was not suppressed.
- [S2] The follow-approval boundary is unchanged: a working prior enrollment is still kept while the current one is not ready
  (`requirements_changed` etc., the @exGeni comment); that state is now reported as `enrollment_retained` with exit 14 and
  tell_user_to_run instead of exit 0.
- [S2] A token row that is missing from the brain is NOT treated as inert (conservative: the lookup may be the wrong brain); it
  reports leave_pending/converges=false with a check-your-config step.
- [S2] No owner-side membership retirement was added (the issue's "Expected" asks for one); the revoked principal's
  shared_skill_members row stays active=true but cannot authenticate.

## #6739 fragment (integrator-owned rows)

### [S2] BEHAVIOR_CHANGES row — src/core/behavior-change-notice.ts

Append to `BEHAVIOR_CHANGES` (since = the wave's release version):

```ts
// S2
  { since: '<wave version>', text: 'The first Claude Code `user-prompt` hook in a new working folder now records heartbeat outcome `ok` with prompt-only context instead of `degraded` / `transcript_unreadable`: Claude Code creates `~/.claude/projects/<project>/` only after that prompt, so a transcript whose project folder does not exist yet reads as absent, the same as a not-yet-written transcript (#5465). It applies only when the missing folder is a direct child of an existing folder inside the projects root and the path has no `..` segment; any other missing path still fails closed. A missing transcript at `session-end` is still reported as degraded.' },
```

### [S2] Nothing else

No registry row, exit code, doctor check or generated doc: the change is inside `confineTranscriptPath`
(src/core/transcripts/claude-code-jsonl.ts, 699 -> 712 lines, not in the size tsv) and reuses its existing `absent: true` result.
The issue's second suggestion (session-end `empty_session`) is deferred as instructed.

## #6755 fragment (integrator rows) — lane S2 — supersedes #6769

### [S2] 1. src/core/error-registry.ts — `migrations_pending.suggestion` (CODES block, ~line 377 on cadaf5cd7)

Old text:

```ts
    suggestion: 'not_applied: apply them with `gbrain apply-migrations --yes`. still_behind or schema_unreadable: run `gbrain doctor --json` and report it to the user; another --yes repeats the failure. wedged: ask the user, fix the cause in ~/.gbrain/upgrade-errors.jsonl, then `gbrain apply-migrations --force-retry <version>` and `gbrain apply-migrations --yes`.',
```

New text:

```ts
    suggestion: 'not_applied: apply them with `gbrain apply-migrations --yes`. still_behind or schema_unreadable: run `gbrain doctor --json` and report it to the user; another --yes repeats the failure. wedged: ask the user, read the migration\'s partial rows in the brain home\'s migrations/completed.jsonl (phases[].detail, if present; apply-migrations prints the resolved path), fix the cause, then `gbrain apply-migrations --force-retry <version>` and `gbrain apply-migrations --yes`.',
```

### [S2] 2. Regeneration

`bun run build:error-codes` (rewrites docs/guides/error-codes.md), then `bun run build:llms` (the key-files edits and the error-codes doc feed the llms bundles).

Optional test the integrator can add once the row lands (test/apply-migrations-wedged-6696.test.ts, inside the "upgrade names the completion ledger" spawn):
```ts
import { CODES } from './src/core/error-registry.ts';
console.log(CODES.migrations_pending.suggestion);   // expect: contains 'completed.jsonl' and 'phases[].detail, if present', not 'upgrade-errors.jsonl'
```

### [S2] 3. BEHAVIOR_CHANGES row (src/core/behavior-change-notice.ts)

Suggested row (fill `since` with the wave version):

- [S2] id: `v0_11_0_phase_f_skips_without_repo_path`
- [S2] text: "On a Postgres brain with no sync.repo_path, the v0.11.0 migration no longer runs `gbrain autopilot --install` during an upgrade. Phase F is recorded as skipped (reason no_repo_path) with the exact install command (the default source's path when it has one), the migration completes instead of wedging after three partial runs, and `gbrain doctor` shows a minions_migration line with that command until an autopilot is installed for the brain. A brain already wedged on v0.11.0 by partials that failed only the install phase is cleared automatically on the next apply-migrations run when its sync.repo_path is unset (a 'retry' row with reason phase_f_no_repo_path is appended to migrations/completed.jsonl); with sync.repo_path set the --force-retry advice stands. Phase F ledger entries now carry a reason code (no_repo_path, autopilot_already_installed, install_failed). Separately, a direct `gbrain autopilot --install` with no --repo and no sync.repo_path now installs for the default source's local_path instead of refusing. Wedged-migration advice now names migrations/completed.jsonl (phases[].detail) instead of upgrade-errors.jsonl."

### [S2] 4. Doctor registration

None needed. The new line is emitted under the existing check name `minions_migration` (already in src/core/doctor-categories.ts and the `minionsMigrationEntry` emits list), from `autopilotInstallPendingCheck()` in src/commands/doctor/checks/autopilot-install-pending.ts, wired into `runMinionsMigration` in src/commands/doctor/checks/local-runtime.ts (already committed). The remote report (src/commands/doctor/report-remote.ts) deliberately does not emit it: the remote surface is subprocess-free and the installed-job probe reads crontab.

### [S2] 5. Docs

- [S2] docs/architecture/key-files/commands-1.md updated in the commits (apply-migrations/v0_11_0 entry and the autopilot.ts entry). Run `bun run build:llms` after merge.
- [S2] skills/migrations/v0.11.0.md gained a `type: autopilot-install-needs-repo` section (not part of any plugin tree).

### [S2] 6. CHANGELOG credit line

"Contributed by @lubosxyz (#6769, reimplemented)" — wedged-migration advice pointing at the completion ledger.

### [S2] 7. Notes for the integrator

- [S2] `OrchestratorPhaseResult` (src/commands/migrations/types.ts) gained an optional `reason?: string`; only Phase F sets it so far.
- [S2] Evidence for the old ledger detail: on cadaf5cd7, a Postgres-mocked `apply-migrations --yes --migration 0.11.0` with a PATH shim that prints the refusal to stderr and exits 1 records `phases[].detail = "Command failed: gbrain autopilot --install --yes"` (in production the command is the resolved child CLI, e.g. `Command failed: '/x/bun' '/x/src/cli.ts' autopilot --install --yes`); the refusal text itself is never captured. The auto-clear no longer reads the detail at all.
- [S2] src/commands/autopilot.ts is now exactly at its ratchet (1642/1642); no TSV change made.
- [S2] test/setup.test.ts fails 26/37 on this machine at base cadaf5cd7 too (5 s default timeouts); unrelated to this item.

## #6717 fragment (integrator rows) — lane S2

- [S2] BEHAVIOR_CHANGES: none. This restores the documented behavior of `gbrain sources add --kind google` (--contacts-dir, --future-days, --loops-exclude-labels were accepted and validated but dropped on managed-persistence brains; the legacy path already stored them). No row needed.
- [S2] Registry rows / regeneration: none.
- [S2] CHANGELOG line suggestion: "Managed `sources add --kind google` keeps --contacts-dir, --future-days and --loops-exclude-labels in the source config, matching the unmanaged path (#6717)."
- [S2] Note for existing users: a managed google source added before this fix lacks those keys; re-add it (or set the keys) to apply the tuning. No automatic backfill is done (the flags' values were never stored, so there is nothing to recover).

## Wave 18 lane 2, S2 fragment: #6729 rename-identity remedy (scratch; the integrator applies these rows)

Every row here is **S2**. The remedy is not S1. It sits on top of the S1 rows already in b78dbf210 (doctor registration and categories of `rename_identity_downgrades`, the doctor goldens). Patches apply on b78dbf210 (final S1 head); `check:orphan-modules` passes there and the doctor goldens did not change (PGLite and Postgres golden tests pass unchanged).

### Already in the INTEGRATOR-ROW commit (last in the patch set) — S2

1. **S2** `src/core/repair/core.ts` `REPAIR_KINDS`: append `'rename-identity'` after `'aliases'`.
2. **S2** `src/core/repair/registry.ts`: `import { renameIdentityRepair, RENAME_IDENTITY_CONSENT_TEXT } from './rename-identity.ts';` and the `'rename-identity'` entry (handler `renameIdentityRepair`, `embeds: 'none'`, `checks: ['rename_identity_downgrades']`, `explicit_only: true`, `preview_bound: true`, `consent: 'destructive'`, `consentText: RENAME_IDENTITY_CONSENT_TEXT`, summary stating the managed limitation). `repairRunner().run` options gain `from?: string; close?: boolean` and pass them through.
3. **S2** `src/core/error-registry.ts`: codes `fact_rows_collide` and `managed_remedy_unavailable` (class `caller`, docs `docs/guides/repair.md#rename-identity`); regenerated `docs/guides/error-codes.md` (`bun run build:error-codes`).
4. **S2** Pinned explicit-kind lists gain `rename-identity`: `test/repair-explicit-only.test.ts` (`EXPLICIT`), `test/fix-wave-5-integration.test.ts` (`previews`).

If the integrator applies these rows by hand instead of taking the commit, note that the `feat(repair)` commit does not typecheck alone (`src/commands/repair.ts` compares a `RepairKind` with `'rename-identity'`); it typechecks once row 1 lands.

### BEHAVIOR_CHANGES (`src/core/behavior-change-notice.ts`, since = slot version) — S2

- **S2**
  ```ts
  { since: '<slot>', text: 'New explicit-only repair kind `gbrain repair rename-identity --source <id>` for an inexact Git rename that sync split into a delete plus an add (#6729). Without `--slug` the preview lists the open pairs with their preview commands. `--slug <new-slug>` (and `--from <old-slug>` when two pairs share it) previews one pair and binds both page ids, both revisions and the disposition into its hash; `--apply --expect <hash> --yes` (destructive consent; without `--yes` a non-interactive run exits 3 with the consent payload) carries the old page id onto the new slug with its version history, timeline, links, facts and aliases, imports the new file onto it as an edit and retires the provisional page (soft-deleted under a purged slug). Facts of both pages survive or the carry refuses `fact_rows_collide` before writing. Carrying identity is classic-only: on a managed source the preview states `managed_remedy_unavailable` and names `--close`, and an apply refuses with that code. `--close` settles the pair and moves nothing, on both kinds of source. Both settle the record (`disposition` remedied or closed), which releases the purge hold. `--all`, the maintenance cycle and the remediation plan never run it.' },
  ```
- **S2**
  ```ts
  { since: '<slot>', text: 'The #6729 sync report, `gbrain sync status --json` (`identity_downgrades[].remedy`) and doctor `rename_identity_downgrades` now name each open pair\'s remedy: the `gbrain repair rename-identity` preview argv, the apply argv bound to the plan hash, `consent: ["destructive"]` and what releases the purge hold. On a managed source the remedy is `--close` (`carry_unavailable: "managed_remedy_unavailable"`), because carrying identity is unavailable there. Doctor\'s fix is the first pair\'s apply (`ask_user`, with `preview_argv` and `plan_hash`); `gbrain restore <old-slug> --source-id <id> --force` stays the named alternative wherever the source admits a restore (`restore_available`, so not on an unbound Postgres source with a checkout); there the remedy is the only fix doctor offers, and `restore_unavailable_sources` lists those sources.' },
  ```

### CHANGELOG — S2

- **S2** When sync splits an inexact rename into a delete plus an add, `gbrain repair rename-identity` now finishes the rename on request: preview the pair, and after you agree the old page keeps its history, links and facts under the new name, or close the pair and let the old page go. Every surface that reports the pair names the command. Carrying identity works on classic sources; on a managed source only closing the pair is available this release (`managed_remedy_unavailable`) (#6729). Contributed by @javieraldape (PR #6732, rewritten).

### KEY_FILES (`docs/architecture/key-files/`) — S2

- **S2** new: `src/core/repair/rename-identity.ts`: `gbrain repair rename-identity` (#6729), explicit-only, preview-bound, destructive. `plan` selects one open pair (`--slug`/`--from`), hashes `identityRemedyParts` (brain, pair, both page ids and revisions, disposition) and saves the approved set; with no pair named it lists the open pairs. On a managed brain a carry preview returns no items with `details.code: managed_remedy_unavailable` and the `--close` preview, and an apply refuses with that code. `carryIdentity` (classic only): one maintenance transaction under both page locks re-checks the hash, the open record and `fenceRowChecks`, merges matching fence rows onto the old rows, retires the provisional page under `purgedSlug`, moves the old page to the new slug (`updateSlug` redirect), moves the provisional's page-id rows (`movePageIdReferences`), imports the new file, settles the record `remedied`. `--close` settles `closed`. Refusals: `fact_rows_collide`, `managed_remedy_unavailable`, `changed_since_preview`, `preview_changed`, `invalid_params`.
- **S2** amend the S1 entry for `src/core/sync-identity-downgrades.ts`: also the per-pair remedy (`identityRemedyParts`, `identityRemedy`, `withIdentityRemedies`, `renameIdentityPreviewArgv`, `remedyAction`; on a managed brain the remedy is `--close` with `carry_unavailable: managed_remedy_unavailable`) that every surface prints, and `settleIdentityDowngrade` (sets `completed_keys[0].disposition = { kind: remedied | closed, at }` on an open record).
- **S2** amend the S1 entry for `src/commands/doctor/checks/rename-identity-downgrades.ts`: fix = the first pair's `gbrain repair rename-identity` apply (destructive, `ask_user`, `preview_argv`, `plan_hash`; `--close` on a managed brain); restore is the alternative in its text only where `restore_available !== false`; `restore_unavailable_sources` lists the rest. The fix is the remedy everywhere, so unbound classic Postgres pairs now get an actionable fix. (Replaces the S1 restore fix.)
- **S2** `src/core/persistence/preview-approval.ts`: `PreviewApprovalCommand` gains `'rename-identity'` (in the feat commit, not an integrator file).

### Docs — S2

- **S2** `docs/guides/repair.md`: committed in the docs commit (explicit-only list, kind table row, `#rename-identity` section with the managed limitation).
- **S2** `docs/guides/live-sync.md` "Renaming a page": committed in the docs commit (names the remedy and `--close`, the managed limitation, links `repair.md#rename-identity`).

### Tests that changed for the intended behaviour — S2

- **S2** `test/sync-inexact-rename-6729.test.ts`, the classic crossed-pairs test: doctor's fix is now the remedy (argv, `preview_argv`, `consent: ['destructive']`, `plan_hash`); the test asserts the restore alternative in `fix.why` and still runs the restore and the verify.
- **S2** new `test/repair-rename-identity-6729.test.ts` (9 tests, PGLite and Postgres), including the managed fixture: report, status and doctor name `--close` and `managed_remedy_unavailable` and no other route; the carry preview states the code; `--apply` refuses with it and moves no identity; `--close` settles the pair and the purge then takes the old page; `gbrain restore <old> --source-id <id> --force` works on the managed source, so the restore alternative stays on managed.
