# Wave 18 lane 5 fragment (integrator: apply, then delete this file)

Branch capy/wave18-lane5. Rows for integrator-owned files, in the order the
items were committed. "<v>" is this wave's release.

## Already applied in the INTEGRATOR-ROW commit (drop or keep it)

The last commit, "INTEGRATOR-ROW: lane 5 registry row and regenerated docs",
holds what this branch's tests and checks need:

1. src/core/error-registry.ts: the movement_unknown row (#6781), inserted
   right before managed_sync_flag_refused. typecheck needs it
   (src/commands/sources-writer-movement.ts throws it).
2. docs/guides/error-codes.md regenerated (bun run build:error-codes).
3. llms-full.txt regenerated (bun run build:llms), because lane docs are
   inlined there.
4. test/fixtures/goldens/exports/types.json regenerated
   (GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/export-surface-golden.test.ts):
   the only change is "movement_unknown" in the error-code union.
5. plugin/ and plugin-variants/ regenerated for skills/maintain/SKILL.md
   (#6748): bun run scripts/generate-plugin-tree.ts --out plugin --variants-out plugin-variants
6. The doctor check coordination_lock_location (v3 lock follow-up) is
   registered:
   - src/commands/doctor/wave-checks.ts, right after the
     foreign_ownership_marker entry:

         {
           id: 'coordination_lock_location', resolution: 'operator', registration: 'wave',
           hostOnly: 'Coordination lock reservations are private files beside the source checkouts on the brain host.',
           count: d => Number(d.count ?? 0),
           impact: 'GBRAIN_COORDINATION_HOME names another directory than a checkout\'s recorded coordination lock, which stays in use',
           instruction: 'Make the recorded lock directory doctor names survive container recreation and unset GBRAIN_COORDINATION_HOME for that checkout if it was meant to move the lock (docs/architecture/topologies.md#coordination-home-ignored); never edit or delete the reservation.',
           run: async engine => (await import('./checks/coordination-lock.ts')).checkCoordinationLockLocation(engine),
         },

   - src/core/doctor-categories.ts and the list in
     src/commands/doctor/checks/graph-health.ts: 'coordination_lock_location'
     right after 'foreign_ownership_marker'.
   - Doctor goldens regenerated (GBRAIN_TEST_UPDATE_GOLDENS=1 on
     test/doctor-json-golden.test.ts, test/doctor-content-golden.test.ts,
     test/doctor-hot-checks-golden.test.ts, test/doctor-registry-golden.test.ts):
     the only change is the new check (ok on a fresh brain).

## src/core/error-registry.ts: writer_lock_unavailable suggestion (lock cluster, #6765)

Replace the suggestion value of writer_lock_unavailable with:

    suggestion: 'For a queued write, wait for the owner (gbrain sources writer status --json names it) or run the write from a process that can open the lock directory; retrying from the same sandboxed process changes nothing. The lock path and the rule that chose it are in onboarding.sources[].coordination_lock of that status. A claim refused while another process repairs an old reservation whose lock was recorded inside the checkout (old_path_wedge: true) succeeds once that repair finishes: run the claim again; never delete the reservation.'

Then bun run build:error-codes and bun run build:llms.

## Watch

docs/architecture/key-files/tooling-and-tests.md is 59990 bytes after #6776,
10 under the 60000-byte doc-history cap: the next edit there needs a split.

## Doctor goldens

The #6758/#6759/#6781 details changes are warn-path only; the only golden
change is the new coordination_lock_location row (INTEGRATOR-ROW item 6).

## Process groups: the cross-run reap is a separate, droppable commit

The last commit of the branch, "fix(eval): reap a SIGKILLed guard's group
only with verified ownership (#6776, scope: owner decision)", is the
cross-run auto-reap (lease files, ownership-verified reap under flock,
status unknown ledger rows). Garry decides its scope; drop that commit to
ship only the in-run group signalling. Its BEHAVIOR row (marked below) ships
only with it.

## src/core/behavior-change-notice.ts: BEHAVIOR_CHANGES rows (append, since '<v>')

    { since: '<v>', text: 'A managed sync backlog that cannot be read is now movement_state unknown (unknown.reason backlog_read_failed) on sources status, writer status and doctor, never nothing_pending (#6781). Doctor managed_sync_not_moving warns with details.health unknown, and gbrain sources writer movement exits 1 with the new code movement_unknown (--warn-only still exits 0) where it used to exit 0. Rerun the movement command; if the read keeps failing, run gbrain doctor --json.' },
    { since: '<v>', text: 'gbrain config set now accepts twelve keys gbrain already reads at runtime but refused as unknown (#6780), including facts.absorb_warn_threshold, think.trajectory_enabled, embedding_image_ocr_max_usd and agent.search_snippet_chars; a source scan guard keeps every getConfig key registered.' },
    { since: '<v>', text: 'A terminal write failure with origin owner_exception no longer gets the database-trigger hint (#6719): it says the owner hit an unexpected exception, nothing was committed and the cause is unknown, and points at gbrain write-request <id> --json (error_detail) and the consumer log; an origin that names no database refusal stays unknown instead of being read as a trigger.' },
    { since: '<v>', text: 'Every agent-contract event now records the gbrain version that wrote it (#6758). When doctor agent_contract warns, details.builds splits the counted events into this_build, other_builds and unknown_build, details.incident is historical when none came from the running build, and the message names how many another build recorded. The warning and its 7-day window are unchanged.' },
    { since: '<v>', text: 'Doctor persistence_counter_drift now names each drifting scope\'s direction (overcharge for a positive delta, a bounded charge with no data lost; undercount for a negative one) and splits the receipts behind it into requests and topology_changes (#6759). The check is still read-only; there is no counter reconcile repair yet.' },
    { since: '<v>', text: 'An embedding error from a provider that reports one input over the model\'s context with a 5xx or no HTTP status (llama.cpp "larger than the max context size", Ollama 500 "input length exceeds the context length") is no longer retried as transient (#6772): the bad chunk is isolated, its siblings embed, and the over-length heal splits it. Only explicit token or context-limit wording counts; "input queue is too long", connection-limit and other 5xx errors still retry.' },
    { since: '<v>', text: 'Writer coordination lock path fallback (#6765): when a checkout contains GBRAIN_HOME (or is it), its native writer lock no longer lands inside the checkout; a claim places it under GBRAIN_COORDINATION_HOME (absolute, outside the checkout), else ~/.gbrain/persistence, in a directory namespaced by the checkout and host, and refuses with storage_error when even that resolves inside the checkout. Ordinary layouts keep persistenceHome()/locks, and a path a reservation already records always wins. A writer transfer keeps the recorded lock (successor reservation first, then the host binding) instead of recomputing it from the accepting process\'s home. A reservation an older release wedged with its lock inside the checkout ("must live outside the canonical checkout") is repaired by the next claim on the host that reserved it. Who: brains whose source checkout contains GBRAIN_HOME, and container deployments. What to do: in a container, set GBRAIN_COORDINATION_HOME to a mounted directory outside the checkout so the lock survives recreation; re-run the claim on a wedged source; gbrain sources writer status --json shows onboarding.sources[].coordination_lock (path, rule, old_path_wedge, and coordination_home_ignored when GBRAIN_COORDINATION_HOME names another directory than the recorded lock, which wins; doctor coordination_lock_location warns about the same case).' },
    { since: '<v>', text: 'A graduation intent marker that recorded a boot id or PID namespace this process cannot read now reads unknown, not alive, so a marker from another host or container is never taken as a live run because a local process shares its pid (#6774).' },

    { since: '<v>', text: '`scripts/eval-spend-guard.sh` runs the guarded command in its own process group and stops the whole group (helpers and grandchildren included) on an interrupt, after the kill grace, and when the command exits leaving processes behind. A terminal stdin is now EOF (the command cannot read the terminal from its own group); pipe or redirect input if it needs any (#6776).' },
    // only with the cross-run reap commit:
    { since: '<v>', text: 'A SIGKILLed `scripts/eval-spend-guard.sh` leaves `<ledger>.leases/<run_id>.lease`: the next guard stops that run\'s process group only when it can prove the group is the one that guard launched, never signals it otherwise, and records it as a cost-0 `status: "unknown"` ledger row while the run\'s reservation stays counted at the estimate (#6776).' },
    { since: '<v>', text: '`gbrain claw-test` runs each phase in its own process group: a phase timeout, SIGINT and SIGTERM stop everything the phase started, and SIGINT stops the running phase even when it was not sent from the terminal (a second SIGINT kills it) (#6775).' },

#6719's "checkpoint receipts become historical" row from plan-v2 is not
needed from this lane: master already supersedes failed checkpoint
submit_job receipts by a later committed __managed_sync_checkpoint__ request
(#6834, src/core/persistence/terminal-classify.ts supersessionSql); the
branch adds a pinning test only.

## CHANGELOG credit lines

- Contributed by @lubosxyz: writer coordination lock cluster (supersedes
  #6765, #6766, #6767), process identity probes (supersedes #6774),
  embedding over-length self-heal (supersedes #6772), process-group cleanup
  (supersedes #6776, #6775).
- Ideas from @Kkkkkuro's #6790 (closed by its author): #6719 owner-exception
  hint and #6758 build version on agent-contract events.

## Heavy Tests

#6049 changes test/e2e/install-real-opencode.serial.test.ts; dispatch Heavy
Tests on the wave branch and record the run id.
