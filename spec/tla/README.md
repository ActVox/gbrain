# TLA+ specs

TLA+ models of gbrain's concurrency protocols, checked exhaustively at small bounds by TLC, the TLA+ model checker. Each
guard a model relies on is a mutant: removing it from the model must break a named property, and removing it from the
code must fail a named test. The crash robot (`scripts/persistence/`) samples real schedules; these models cover every
interleaving of the modelled actions inside their bounds. The approach follows Parcha's agentrun `spec/receipts`
(Apache-2.0); no code was copied.

## Run it

```sh
bun run test:tla                                   # every config of every spec, then every mutant (model and code)
bash scripts/spec/tlc.sh drain-lease DrainLease.cfg  # one config
bun scripts/spec/mutants.ts --only renewal-ignores-token
bun scripts/spec/mutants.ts --spec-only            # model mutants only (no Bun tests)
```

Needs Java 11 or later (CI uses temurin 21), GNU `timeout` (`brew install coreutils` on macOS) and Bun.
`scripts/spec/tla-jar.sh` downloads tla2tools.jar once into `~/.cache/gbrain/tla` and checks it against the sha256 in
`scripts/spec/tla-tools.env`; set `TLA2TOOLS` to use a jar you already have (it is checked too). The code mutants
that need Postgres run when `DATABASE_URL` points at a test database (with `GBRAIN_TEST_ALLOW_DATABASE_URL=1`);
otherwise they print `skip`, and CI passes `--require-postgres`. Logs and counterexample traces land in
`.context/tlc/` (`TLC_OUT`), and CI uploads them as the `tla-spec-logs` artifact.

`.github/workflows/tla-spec.yml` runs all of it nightly, on dispatch, and on pull requests and master pushes that touch a
spec, its runner, the code a spec models, or a test a mutant names.

### When it fails

| Code | Meaning | What to do |
| --- | --- | --- |
| `TLC_VIOLATION` | A property is violated. | Read the trace in the log; the action table below maps each step to code. Fix the code, or fix the spec when it is wrong and say why in the PR. |
| `TLC_TIMEOUT` | TLC did not finish within `TLC_TIMEOUT_S` (600 s). | The state space grew: shrink the config's bounds, or find the action that multiplies states. |
| `TLC_ERROR` | TLC stopped: a parse or semantic error, or out of memory. | The log names the line. |
| `TLA_JAR_DOWNLOAD_FAILED` | The jar did not download. | Rerun. |
| `TLA_JAR_SHA_MISMATCH` | The jar is not the reviewed release. | Never rerun; a new pin needs review. |
| `MUTANT_STALE` | A mutant's `before` text is not found exactly once. | The spec or code moved: update the mutant's text in `mutants.json`. |
| `MUTANT_SURVIVED` | No property caught a model mutant, or the named test passed with the guard removed from the code. | A property or a test stopped pinning the guard. Restore it; never delete the mutant to go green. |
| `MUTANT_WRONG_PROPERTY` | A different property caught it, or a survivor became load-bearing. | Read the trace; update `expect`, and give a new load-bearing guard a code edit and a test. |
| `MUTANT_INCOMPLETE` | TLC did not finish, or a named test failed without the edit, matched no test, or did not load with it. | Fix the test or the filter first; a failure that is not the test's own assertion proves nothing. |

## drain-lease: the managed-sync drain lease

One drainer per source at a time (`src/core/persistence/sync-lease.ts` over `src/core/db-lock.ts`). The lease is one
`gbrain_cycle_locks` row; its `acquisition_token` is the fencing token. Every transaction that admits sync work or
swaps the cursor runs `assertDrainLease`, which reads the row by token `FOR SHARE`. The pass stamp takes the same share
lock with the token stamped on its request: a folded stamp's proof (`provenStamp`) and the checkpoint request
(`applyPassCheckpoint`), both run by the write coordinator, possibly in another process.

| Config | What it checks |
| --- | --- |
| `DrainLease.cfg` | Two drainers, one fenced transaction at a time, the code's timing at 10 s ticks: every property. |
| `DrainLeaseSafety.cfg` | Every adverse assumption on (live holders stolen by a lying pid probe or `--force-break-lock`, fenced transactions longer than the renewal timeout, no renewal priority), 20 s ticks: the safety properties, which must hold anyway. |

`test/spec-drain-lease-constants.test.ts` keeps both configs' timing equal to the code's constants and checks the
ordering the liveness property needs.

### Properties

| Property | Holds that |
| --- | --- |
| `FencedTxnsMatchRow` | every open fenced transaction belongs to the row's current holder, so every commit is made under the live lease |
| `OneDrainer` | at most one process has fenced work open |
| `CursorMonotone` | the sync cursor never moves backward |
| `NoSpuriousLapse` | a holder that never slept (machine asleep, event loop blocked) never loses its lease, under the timing assumptions below |

### Timing assumptions

An awake holder runs its timers on time: the clock does not pass a due renewal, a renewal that can land, a renewal
timeout, its local lease deadline, or a fenced transaction at its bound. On top of that, `NoSpuriousLapse` needs:

- **Every fenced transaction closes in under the renewal timeout** (30 s, `withRefreshingLock`). TLC passes with
  fenced transactions up to 20 s and finds a lapse at 30 s: the renewal waits on the transaction's share lock, times
  out just before it ends, and the next fenced transaction starts before the next renewal. `inFencedSlices` keeps its
  own transactions to 5 s (`FENCED_SLICE_MS`, #7415); see the known gaps for the rest.
- **Fenced transactions of one holder do not overlap.** Postgres 16 lets a new `FOR SHARE` in beside the share locks
  already held even while an `UPDATE` waits, and gives the row to the waiting `UPDATE` once every share lock is gone.
  So a waiting renewal lands between serial fenced transactions and can starve under overlapping ones.

Times are rounded so the model is never kinder than the code: TTL and graces round down, the refresh interval,
renewal timeout and transaction bound round up. A renewal's `now()` is its statement's start, so the row's expiry
counts from the request, not from the moment it got the row.

### Actions and code

| Action | Code |
| --- | --- |
| `Acquire` | `tryAcquireDbLock`'s upsert: insert, or take over a row whose TTL expired and whose last refresh is older than the steal grace; it waits for every `FOR SHARE` |
| `DeadPidTakeover` | `tryAcquireDbLock`'s second path (#1780) and `--break-lock`'s safe path: an unexpired row whose same-host pid the probe calls dead, older than `HOLDER_TAKEOVER_GRACE_MS` |
| `StartRenew`, `RenewLand` | `withRefreshingLock`'s interval and `handle.refresh()`: one renewal in flight, `UPDATE ... WHERE id AND holder_pid AND acquisition_token`; a refused renewal aborts the lease signal |
| `RenewTimeout`, `CancelSettle` | the renewal timeout aborts the query; it settles later and never extends local authority |
| `LocalDeadline` | the expiry timer: the TTL passed with no confirmed renewal (`renewDeadline`) |
| `BeginFenced`, `Commit`, `Rollback` | `assertDrainLease` inside a transaction (signal, token, expiry, `FOR SHARE`); lane 1 swaps the cursor. The pass stamp's checks in `provenStamp` and `applyPassCheckpoint` are the same fence without the signal check, which the model shows is defense in depth (`fence-ignores-signal` survives) |
| `Release` | `withRefreshingLock`'s finally: wait for the in-flight renewal, then `DELETE ... WHERE id AND holder_pid AND acquisition_token` |
| `Sleep`, `Wake`, `Crash` | the environment: a sleeping holder keeps its open transaction and share lock; a crash rolls them back |

### Mutants

`mutants.json`. A guard mutant has a code edit (every engine branch) and the tests that must fail under it.

| Mutant | Kind | Caught by | Code and test |
| --- | --- | --- | --- |
| `fence-ignores-token` | guard | `FencedTxnsMatchRow` | `assertDrainLease`; `test/persistence-sync-lease.test.ts` |
| `fold-stamp-ignores-token` | guard | `FencedTxnsMatchRow` | `provenStamp` (sync-pass-fold.ts); `test/drain-lease-stamp-fence.test.ts` and its Postgres twin |
| `checkpoint-stamp-ignores-token` | guard | `FencedTxnsMatchRow` | `applyPassCheckpoint` (sync-prepare.ts); the same |
| `fence-without-share-lock` | guard | `FencedTxnsMatchRow` | `assertDrainLease`; `test/e2e/drain-lease-fence-postgres.test.ts` |
| `takeover-ignores-ttl` | guard | `NoSpuriousLapse` | the upsert's `ON CONFLICT ... WHERE`; `test/drain-lease-guards.test.ts` and its Postgres twin |
| `release-ignores-token` | guard | `NoSpuriousLapse` | `handle.release()`; the same |
| `renewal-ignores-token` | guard | `NoSpuriousLapse` | `handle.refresh()`: a former holder's late renewal, its `now()` taken when it was sent, would rewind its successor's expiry; the same |
| `pid-probe-calls-live-holder-dead` | guard | `NoSpuriousLapse` | `classifyHolderLiveness` (EPERM is alive); `test/db-lock-auto-takeover.test.ts` |
| `fenced-transaction-outlives-renewal-timeout` | guard | `NoSpuriousLapse` | `FENCED_SLICE_MS` (#7415); `test/sync-fenced-slices-gbra133.test.ts` |
| `fence-skips-queued-renewal` | assumption | `NoSpuriousLapse` | Postgres gives the row to the waiting renewal between serial transactions |
| `overlapping-fenced-transactions` | assumption | `NoSpuriousLapse` | one fenced transaction per holder at a time (known gap 2) |
| `fence-ignores-signal` | survivor | — | defense in depth: an abort is also visible to the token or expiry check |
| `fence-ignores-expiry` | survivor | — | defense in depth: `FOR SHARE` blocks a takeover while the transaction is open and the token refuses after it; `test/persistence-sync-lease.test.ts` still pins the refusal |

### Not modelled

Postgres only: PGLite is one connection and serializes everything. Also left out, each covered elsewhere: the
`LEASE_BEACON_QUEUE` holder record older binaries see (`test/persistence-sync-lease.test.ts`,
`test/minions-lease-beacon-sweeps-7261.test.ts`); a follower's wait and `drain_stalled` (`test/persistence-sync-lease.test.ts`);
reentrant passes under one lease; older binaries that take no lock; side effects outside the database; how the
local monotonic clock behaves across a machine suspend; and a coordinator in another process that keeps a pass-stamp
transaction open after the holder crashed (its share lock delays a takeover; its token check still holds).

### Known gaps

The model shows the lease's liveness rests on two properties the code does not enforce yet:

1. Nothing bounds every fenced transaction under the 30 s renewal timeout. `inFencedSlices` checks its 5 s budget only
   between items, other call sites of `assertDrainLease` run one transaction over a whole batch, and the pass stamp's
   checks run inside the coordinator's publication transactions, whose length the lease does not bound.
2. The holder's own fenced transactions run one after another (admissions are serial), but the pass stamp's checks run
   in the coordinator's publication transactions alongside them, so the row can stay `FOR SHARE` across a waiting
   renewal. A fix that weakens the fence to `FOR KEY SHARE` would let the takeover upsert through too
   (the test behind `fence-without-share-lock` catches that).

Both are filed with the sync lane. The model keeps `NoSpuriousLapse` as stated and names these as assumptions rather
than weakening the property.
