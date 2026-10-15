# Wave 18b lane 4: release notes for the integrator

Version stamps, CHANGELOG headers and `since:` values are the integrator's. Rows below use `since: '<WAVE_VERSION>'`.

## CHANGELOG bullets (Itemized changes)

- **Transaction aborts cancel their running statement (#6598).** An aborted Postgres transaction now sends the
  driver's cancel for the statement it is running before it discards the reserved connection, so a statement blocked
  on a lock no longer keeps running on the server after the caller gave up. `vendor/postgres` (and
  `patches/postgres@3.4.9.patch`) gain `own()` cancel-and-discard; `transaction-abort.ts` uses it with a settle window
  (`cancelSettleMs`). The abort's `cause` stays the driver error; a failed cancel is reported as `cancelFailure`.
  Contributed by @Kkkkkuro (re-land of the cancel hunk from #6790). Proven on direct Postgres and PgBouncer
  (`test/e2e/transaction-cancel-held-lock.test.ts`).
- **A surviving `gbrain serve` takes over resolve IPC once the owner exits (#6647).** Each socket a serve could not
  bind (source and legacy) retries on an unref'd timer every 30 s plus jitter, through the single-owner probe, so
  hooks keep their per-turn context after the first serve stops.
- **Long Windows PGLite paths keep working IPC (#6573).** On Windows, a data-dir socket path over the 107-byte
  afunix limit moves to `%USERPROFILE%\.gbrain\run\<kind>-<hash12>.sock`, still guarded by `.gbrain-ipc-secret`.
  A path still too long there is reported as `ipc_path_too_long` in the serve log and by the new doctor check
  `ipc_socket_path`, with the move-the-brain fix.
- **Process launches hide their console window on Windows (#4992).** 71 more files now launch through
  `src/core/spawn.ts`; the `NOT_YET_MIGRATED` ratchet lists 13 files (open PRs and the persistence write path).
- **`gbrain backup create` refuses brains its archive cannot hold, up front (#6649).** A flat or symlinked data dir
  is `unmanaged_database_path` (before: a one-line refusal, or a generic `symlink_path` for a `.gbrain` alias) and an
  estimated archive over 8 GiB is `backup_too_large` (before: the dump ran and failed late, "Out of memory"). Both
  refuse before the lock or any write and point at the new quiesced physical-copy runbook
  (`docs/guides/in-agent-setup.md`), proven by a restore drill test. Doctor's `pglite_data_dir` warns from 75% of
  the cap. #6649 stays open for native archives over 8 GiB.
- **`bootstrap harness --token` on PGLite no longer needs the serve running to wire (#6661).** With no serve
  answering and none holding the brain, the run wires every target and ends `pending_verify` (exit 13, JSON
  `status: "pending_verify"`); its `fix` is the same `--token` re-run once the serve is up, which runs while the serve
  holds the brain. `bootstrap harness --status` stays `partial` (exit 1) until then.

## BEHAVIOR_CHANGES rows (src/core/behavior-change-notice.ts)

```ts
  // Wave 18b lane 4 item 4.6 (#6598).
  { since: '<WAVE_VERSION>', text: 'On Postgres, an aborted transaction (a request deadline, a cancelled job or a closed client) now cancels the statement it is running before it releases the connection, instead of leaving that statement running on the server until it finished on its own. A statement waiting on a lock is cancelled within the settle window; the abort error keeps the driver error as `cause` and reports a failed cancel as `cancelFailure`.' },
  // Wave 18b lane 4 item 4.1 (#6647).
  { since: '<WAVE_VERSION>', text: 'A second `gbrain serve` that could not bind the resolve IPC socket (another serve owned it) now retries every 30 seconds (plus up to 5 s jitter) and takes the socket over once the owner is gone, so hooks keep per-turn context without restarting the surviving serve. The single-owner rule is unchanged: a live owner is never displaced.' },
  // Wave 18b lane 4 item 4.2 (#6573).
  { since: '<WAVE_VERSION>', text: 'On Windows, a PGLite brain whose data directory makes the IPC socket path longer than 107 bytes now places its sockets at `%USERPROFILE%\\.gbrain\\run\\<kind>-<hash>.sock` (the Postgres scheme, same `.gbrain-ipc-secret` guard) instead of failing to bind them, so hooks and local commands reach `gbrain serve` again. A path still too long is logged as `ipc_path_too_long` and reported by the new doctor check `ipc_socket_path`.' },
  // Wave 18b lane 4 item 4.5 (#6649).
  { since: '<WAVE_VERSION>', text: '`gbrain backup create` on PGLite now refuses before it takes the lock or writes anything when the brain is outside what its archive holds: a data directory that is not `<root>/.gbrain/brain.pglite` or is reached through a symlink is `unmanaged_database_path` (a `.gbrain` alias used to get `symlink_path`), and an estimated archive over 8 GiB is `backup_too_large` (it used to run the dump and fail late). Under `--json` both are their own envelope with an ask-the-user physical-copy fix instead of `storage_error`; the legacy `reason` is unchanged. Doctor `pglite_data_dir` now warns on a healthy PGLite brain whose estimated archive passes 6 GiB.' },
  // Wave 18b lane 4 item 4.4 (#6661).
  { since: '<WAVE_VERSION>', text: '`gbrain bootstrap harness --token` on a PGLite brain now wires the harness when no serve answers at the serve URL and none holds the brain, and exits 13 with JSON `status: "pending_verify"` instead of exit 1 before writing anything. Re-run the same command with the same `--token` once `gbrain serve --http` runs to verify it; `gbrain bootstrap harness --status` reports `status: "partial"` and exits 1 until that run passes. A serve holding the brain at another URL, any HTTP answer, no `--token` and Postgres brains still fail as before. The harness `--json` result gains `status` (`ok`, `failed` or `pending_verify`).' },
```

## PR body notes

- Partially supersedes #6790 (Kkkkkuro): this lane re-lands its `own()` cancel-and-discard hunk, the
  `types/index.d.ts` hunk and its offline cancel-order test. Design change from #6790: the abort's `cause` stays the
  driver error (callers such as `publication-deadline.ts` classify `cause.code`), and a cancel failure is a new
  enumerable `cancelFailure` field; the #6790 test is adjusted to that. Credit: `Contributed by @Kkkkkuro` plus the
  `Co-Authored-By` trailer on commit 255e2357.
- Addresses #6647, #6573, #4992 (ratchet step), #6598, #6661; refs #6649 (stays open: archives over 8 GiB).
