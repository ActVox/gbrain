# ActVox Team GBrain migration to v0.46.28.0

Status: candidate preparation only. Merging the PR is production-impacting because Render tracks `ActVox/gbrain:master`.

## Scope

- Current production: `0.42.62.0`, Postgres, migration `123`.
- Upstream base: exact tag `v0.46.28.0`, commit `67e7e8a9246b75b9aec359e17dc3e5746d62fc62`.
- Deployment artifact: the resulting exact `ActVox/gbrain:master` merge SHA, not the raw upstream tag or pre-merge PR head.
- Target migration level: `140`.
- Active schema pack must remain `gbrain-base-v2@1.0.0+f4f6494a`, source `env`.
- Embedding/reranker provider migration is a separate change and must not be folded into this code/schema cutover.

## Data answer

No export/import or corpus rewrite is required. Existing pages, chunks, embeddings, sources, links, tags, and credentials stay in the same Postgres database.

The production database does require idempotent schema migrations `124..140`. Most are additive tables, columns, or indexes. Two migrations mutate bounded operational data:

- `128` backfills job timeouts and cancels duplicate waiting autopilot-cycle rows.
- `139` rewrites legacy timeline rows to the current `(source, summary)` shape and removes only already-duplicated rows.

Migration `133` deliberately does not backfill `embedded_text_hash`; existing vectors are grandfathered and heal forward on the next re-embed. Therefore this upgrade does not require a corpus-wide re-embedding.

## Why this is stop-the-fleet

Migration `131` drops `uniq_subagent_tools_use_id`. The `0.42` worker names that constraint as an `ON CONFLICT` target and will fail after the drop. Old and new workers must never share the migrated database.

Render auto-deploys web, worker, and cron resources independently. A blind merge can therefore start a new worker while an old process or cron is still running. This is why the upgrade cannot be a normal automatic deploy.

## Database changes: v123 to v140

| Version | Change | Risk |
|---|---|---|
| 124 | Replace page search-vector trigger; stop indexing unbounded `compiled_truth` | Function replacement |
| 125 | Replace take-proposal idempotency index with per-claim uniqueness | Index replacement |
| 126 | Add `session_context_state` and freshness index | Additive |
| 127 | Add OAuth surface columns and queue/status/update index | Additive |
| 128 | Backfill job timeouts; cancel duplicate waiting autopilot cycles | Bounded data mutation |
| 129 | Add scored dream-triage columns | Additive |
| 130 | Add per-job lock duration and check constraint | Additive |
| 131 | Drop job-wide tool-use-id uniqueness constraint | Mixed-version incompatible |
| 132 | Add checkpoint manifests to session context state | Additive |
| 133 | Add nullable `content_chunks.embedded_text_hash` | Additive, no backfill/re-embed |
| 134 | Restore partial indexes for missing embeddings | Index repair |
| 135 | Add event-time facts index | Additive |
| 136 | Add private-queue owner and lease metadata | Additive |
| 137 | Add manual cross-source entity identity table/indexes | Additive |
| 138 | Replace timeline dedup index with fixed-width `md5(summary)` key | Index replacement |
| 139 | Repair legacy timeline source/summary rows and delete existing duplicates | Bounded data mutation |
| 140 | Add empty `chat_usage_log` table and indexes | Additive |

## Pre-deploy gates

1. Disable broad Render auto-deploy for GBrain resources.
2. Stop/suspend old web, worker, sync, dream, extract, and autopilot processes.
3. Verify no active, waiting, delayed, or paused migration-sensitive jobs.
4. Capture fresh baseline: `/health`, migration level, page/chunk/embedding/link/tag/timeline counts, sources, schema pack, queues.
5. Verify both database planes:
   - `DATABASE_URL` reaches the intended production pooler;
   - `GBRAIN_DIRECT_DATABASE_URL` reaches direct/session Postgres;
   - migration role can alter tables, indexes, functions, triggers, and constraints.
6. Run candidate `apply-migrations --list` and `--dry-run` without mutation.
7. Run candidate provider-sunset status. If ZeroEntropy remains configured, document the exposure but keep any provider/vector migration out of this cutover.
8. Take a mode-0600 custom-format `pg_dump`, generate `pg_restore --list`, and checksum it.
9. Restore into disposable Postgres with required extensions and run the exact candidate with `gbrain init --migrate-only`.
10. Require migration `140`, unchanged page/chunk counts, 100% embedding coverage, unchanged schema pack, healthy queues, and no failed migration ledger row.

## Sequential cutover

1. Keep every `0.42` process stopped.
2. Merge the reviewed PR and record `EXPECTED_ACTVOX_SHA`; verify it equals `ActVox/gbrain:master`.
3. Run a one-off Render migration process built from `EXPECTED_ACTVOX_SHA`:
   ```bash
   gbrain init --migrate-only
   gbrain doctor --json
   ```
4. Verify database migration `140` before starting an HTTP or queue process.
5. Deploy web on `EXPECTED_ACTVOX_SHA`; verify `/health` and read-only MCP.
6. Deploy worker on the same SHA; verify supervisor readiness and queue health.
7. Deploy/enable sync and dream cron resources on the same SHA.
8. Re-enable auto-deploy only after all services are live and verified.

## Live verification

```bash
curl -fsS https://gbrain.actvox.dev/health
hermes mcp test gbrain-team
hermes -p eve mcp test gbrain-team
hermes -p actvox-slack mcp test gbrain-team
hermes -p vulcan mcp test gbrain-team
```

Require:

- `/health.version = 0.46.28.0`, `engine = postgres`;
- every Render resource reports `EXPECTED_ACTVOX_SHA`;
- doctor reports migration `140` as latest;
- schema pack remains `gbrain-base-v2@1.0.0+f4f6494a`, source `env`;
- fresh page/chunk baseline is preserved and embeddings remain 100%;
- no wedged or failed queues;
- default and federated reads work;
- attributable write/read/delete smoke succeeds.

## Rollback

Before migration `131`, redeploying the previous artifact is allowed if no state-changing migration ran.

After migration `131`, never start `0.42` against the migrated database. Full rollback is:

1. stop every `0.46` process;
2. restore the verified pre-migration backup;
3. deploy the previous known-good commit to web and worker;
4. re-enable cron jobs only after `/health`, doctor, MCP, counts, and queue readback pass.

## Fresh baseline requirement

Preparation baseline is not deployment evidence. Immediately before cutover, recapture migration level, page/chunk/embedding/link/tag/timeline counts, active schema pack, source freshness, and queue status.
