# Eval-category wave, fix lane C (`capy/evalwave-fixes-c`)

Bugs from gbrain-evals branch `capy/wave-n1-n5` (repros in
`docs/benchmarks/2026-10-01-n1-n5/repro/`, ledger
`docs/benchmarks/2026-10-01-wave-bugs.md`). Every item has a failing test
first, then a root-cause fix, on both engines. No version bump or CHANGELOG
entry: the integrator owns those. Base: `capy/fix-wave-5` (a551d84b).

## Integration notes

- **Migration v188** (`facts_ontology_stint_dedup`). GBRA-37 holds v187 and
  lane B v188. Standalone, this branch has a gap at 187–188, so three
  count-based assertions fail until those land and pass once they do:
  `test/migrations-golden.test.ts` (gap list `[17,18,19,100]`),
  `test/fix-wave-4-integration.test.ts` X1 (`applied: LATEST_VERSION - 178`)
  and `test/persistence-diagnostics.test.ts` (`applied` count). Every other
  suite is green here.
- **Goldens.** The catalog, doctor `schema_version`, export-surface, migration
  record and SQL-text goldens were regenerated for v188 and the new
  `visibility` read option. After merging v187/v188, regenerate them once
  more with `GBRAIN_TEST_UPDATE_GOLDENS=1` (unit and the Postgres E2E
  catalog/doctor/replay files) rather than hand-merging the JSON.
- **Ratchets.** `scripts/module-size-limits.tsv` (both engines, `types.ts`)
  and `scripts/function-size-baseline.tsv` (`dispatchToolCall` +3) record
  the growth with rationale.
- `isFactWithdrawn` / `recordFactWithdrawal` signatures are unchanged.
- No edits to `src/core/ops/context.ts`, `src/core/ops/links.ts`,
  `src/commands/hook.ts` or the vector search SQL.

## N1-3 — ontology reads returned private observations to remote callers (privacy)

`ontology_get` (and `ontology_conflicts`, `volunteer_chronicle`'s
ontologies) only redacted diary-sourced rows and rows whose provenance page
is private; `facts.visibility` was never checked, so a remote caller saw an
observation proposed with `visibility: private`.

- `getOntology` and `findOntologyConflicts` take a `visibility` tier list
  (both engines), applied before the per-dimension `DISTINCT ON` and the
  conflict `HAVING`, so an untrusted caller resolves the newest world value
  instead of a private value or a hole.
- The three ops pass `['world']` for `ctx.remote !== false` (the recall and
  hot-memory rule); trusted local callers read every tier.
- Existing chronicle fixtures that expected remote callers to see
  default-private observations now write those rows as `visibility: world`,
  so they keep isolating the diary and provenance-page rules.
- Tests: `test/ontology-fact-visibility.test.ts` (handler and MCP dispatch,
  remote `true`/`undefined` vs local, conflicts, `volunteer_chronicle`);
  Postgres parity in `test/e2e/ontology-merge-parity.test.ts`.

## N1-1 — `ontology_propose` refused on every `gbrain init` brain

`mergeOntologyFact` inserts into `facts` directly, and the managed writer
guard trigger rejects that whenever managed persistence is on.

- New `coordinatedDatabaseWrite` (`src/core/persistence/database-write.ts`):
  the managed path for database-only rows. It checks the caller's durable
  write authority, then runs the write inside `withCoordinatedWrite` with
  the source incarnation revalidated and the given page keys held.
  `coordinatedManualLinkWrite` now delegates to it (behavior unchanged).
- `ontology_propose` uses it with the entity's page key; unmanaged brains
  keep the direct engine call. A direct engine write on a managed brain is
  still refused.
- Tests: `test/managed-ontology-propose.test.ts` (PGLite and Postgres via
  `test/e2e/managed-ontology-propose-postgres.test.ts`).

## N1-2 — same-provenance revert was a silent noop

The dedup index `(source_id, entity_slug, dimension, value_hash,
source_markdown_slug)` had no time component, so Lisbon → Porto → Lisbon from
one provenance collided with the first Lisbon row and Porto stayed current.

- Migration v188 replaces it with `idx_facts_ontology_stint_dedup`, which adds
  `valid_from`. The new key is strictly finer, so existing rows satisfy it.
- `mergeOntologyFact` (both engines) keeps same-stint repeats idempotent: when
  the incoming value equals the current open value and the same provenance
  already observed it at or after the current stint's start, it returns
  `noop` instead of inserting a corroboration echo. Exact replays of any
  step conflict on the new key and stay noops.
- Tests: `test/ontology-revert.test.ts` (dated, undated, replay),
  `test/managed-ontology-propose.test.ts` (through the coordinator), parity
  in `test/e2e/ontology-merge-parity.test.ts`; `test/e2e/schema-drift.test.ts`
  pins the new index shape.

## N5-1 — hot memory served a forgotten fact for up to 30 s

`getBrainHotMemoryMeta` (`src/core/facts/meta-hook.ts`) caches per process for
30 s, and nothing invalidated it (`bumpHotMemoryCache` had no caller), so
`context_pack` and `_meta.brain_hot_memory` kept a withdrawn claim.

- `dispatchToolCall` calls `invalidateHotMemoryForEngine(engine)` after every
  mutating op, on success and on failure (a failed write may have committed
  part of its work). Both MCP transports dispatch here.
- A per-engine generation stops a build that raced an invalidation from
  storing its stale payload.
- Each cache hit revalidates the source's `fact_withdrawals` watermark (count
  and latest `withdrawn_at`, read before the rows), so a forget committed by
  another process (a CLI next to a running server) is not served either.
- Tests: `test/hot-memory-invalidation.test.ts` (forget via dispatch on both
  tiers in `_meta` and `context_pack`, an out-of-dispatcher withdrawal, a
  fresh write, the race), PGLite and Postgres via
  `test/e2e/hot-memory-invalidation-postgres.test.ts`.

## N5-3 — first remember after a forget refused as stale bytes (PGLite CLI)

The forget commits, queues its `withdrawal-mirror` effect and exits; a CLI
process has no resident consumer. The next process (the remember) starts a
consumer whose effect worker and request worker run in the same tick
(`consumer.ts` `doTick`). The mirror rewrites the page file after the remember
captured `expectedBeforeHash` and before it publishes, at an unchanged page
revision, so publication refused with `source_changed` → `raw_file_changed`.
Postgres and the servers hid it by timing.

- `CLAIMABLE_WRITE_SQL` (`journal.ts`): a file write is not claimed while a
  queued or running withdrawal mirror targets its page (an untargeted legacy
  mirror blocks its whole worktree). Writes to other pages are unaffected.
- `publishMutation` (`coordinator.ts`): changed bytes **and** a moved page
  revision (a forget committed while the write was preparing) throw
  `revision_conflict`, so semantic writes reprepare; changed bytes at an
  unchanged revision still refuse as `raw_file_changed`.
- Tests: `test/withdrawal-followup-writes.test.ts` (PGLite and Postgres via
  `test/e2e/withdrawal-followup-writes-postgres.test.ts`).

## N5-2 — forget under concurrent CLI writes on PGLite

Two independent causes. The ledger said the `owner_unavailable` forgets had
committed; they had not (refused before sending, fact still active).

- **Missing chunks.** `recordFactWithdrawal` deletes the withdrawn pages'
  chunks in the commit and leaves the rebuild to the resident projection
  worker, which a CLI forget never runs. It reproduced without concurrency
  (forget, then search). `submitForgetMutation` now rebuilds those pages'
  text projections after the commit and before answering
  (`rebuildPendingPageProjections` gained a `pages` filter). A failed rebuild
  stays queued as durable projection work and does not turn a committed
  forget into an error.
- **`owner_unavailable`.** `maybeDelegateLocalOperation` treated any PGLite
  lock holder as a resident owner; when the holder was another CLI call
  there was no owner socket, so concurrent CLI writes (forgets and remembers)
  got `owner_unavailable` with `submission_status: not_sent`. A holder that
  is not a serve and answers no owner socket now falls through to the engine
  path, which already waits up to 30 s for the lock. A serve holder, or a
  socket that answered, still makes every failure final.
  `maybeDelegateLocalAdministration` is unchanged.
- Behavior change to call out: concurrent CLI calls on one PGLite brain now
  take turns on the lock instead of failing fast; behind a long-running
  non-serve holder (e.g. a jobs daemon) a CLI write waits and then fails
  lock-busy rather than answering `owner_unavailable` immediately.
- `test/persistence-memory-mutations.test.ts` "forget commits offline" used
  to assert the chunks were empty after a forget (the N5-2 behavior); it now
  asserts the chunks keep the retained text and drop the withdrawn claim.
- Tests: `test/withdrawal-followup-writes.test.ts` (retained fact in chunks
  and keyword search after an acknowledged forget),
  `test/persistence-local-client.test.ts` (non-serve holder falls through;
  serve holder without a socket still throws).

## Repros (gbrain-evals `capy/wave-n1-n5`, run against this checkout)

| Repro | Before (a551d84b) | After |
|---|---|---|
| N1-1 | `ontology-add` exit 1 `writer_coordinator_required`; `ontology_get` `[]` | exit 0; `ontology_get` returns location = Lisbon |
| N1-2 | third write `noop`; current Porto | third write `superseded_prior`; current Lisbon |
| N1-3 | remote sees `decision_style=deliberate, risk_tolerance=high (private marker)` | remote sees `decision_style=deliberate` |
| N5-1 | `context_pack` and `get_page` `_meta` right after forget carry the fact | both `false` |
| N5-2 | rounds lose chunks after `forget ok` (search false) or answer `owner_unavailable` (2/5 each) | 10/10 rounds over two runs: forget ok, retained neighbor in recall and search |
| N5-3 | first remember `scope_denied: The source file bytes changed after this request was accepted.`; retry ok | first remember ok |
