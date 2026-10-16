# Wave 18 lane 2, S2 fragments (scratch; the integrator applies these rows and deletes this file)

**Every row in this file is S2** (each row is tagged). S1 rows (#6729 core, #6741 A/B/C, #6749) are in `.wave18-fragments/lane2-s1.md`.

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

