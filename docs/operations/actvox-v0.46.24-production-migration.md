# ActVox Team GBrain migration to v0.46.24.0

Status: prepared only. Merging this PR deploys production because Render tracks `ActVox/gbrain:master` with `autoDeploy: true`.

## Scope

- Current production: `0.42.62.0`, Postgres, migration `123`.
- Upstream base: exact tag `v0.46.24.0`, commit `7e3ce95bbf4c2e4902c8a35ff6a1f79bdbd54081`.
- Deployment artifact: the post-merge `ActVox/gbrain:master` commit for this PR, rooted at that tag, not the raw upstream tag or the pre-merge PR head. Capture it as `EXPECTED_ACTVOX_SHA` after merge and require every Render service to report that exact SHA.
- Target migration level: `132`.
- Active schema pack must remain `gbrain-base-v2@1.0.0+f4f6494a`, sourced from `env`.

## Why this is a stop-the-fleet migration

Migration v131 drops `uniq_subagent_tools_use_id`. An old worker names that constraint as an `ON CONFLICT` target and will fail after the drop. Do not run 0.42 and 0.46 workers against the database concurrently.

Migration v128 also mutates queue state by cancelling duplicate waiting autopilot cycles. A binary-only rollback is therefore not a complete rollback.

## Database changes: v123 to v132

| Version | Change | Risk |
|---|---|---|
| 124 | Replaces the page search-vector trigger and stops indexing unbounded `compiled_truth` | Function replacement |
| 125 | Replaces take-proposal idempotency index with per-claim uniqueness | Index replacement |
| 126 | Adds `session_context_state` and its freshness index | Additive |
| 127 | Adds OAuth surface columns and queue/status/update index | Additive |
| 128 | Backfills job timeouts and cancels duplicate waiting autopilot cycles | Data mutation |
| 129 | Adds scored dream-triage columns | Additive |
| 130 | Adds per-job lock duration and check constraint | Additive |
| 131 | Drops job-wide tool-use-id uniqueness constraint | Mixed-version incompatible |
| 132 | Adds checkpoint manifests to session context state | Additive |

## Pre-deploy gate

1. Freeze production writes:
   - disable Render auto-deploy or suspend every affected service before merging, because `render.yaml` tracks `master` with `autoDeploy: true` and otherwise web/worker/crons race their deployments independently;
   - suspend Render worker;
   - suspend dream, sync, extract and autopilot cron jobs;
   - stop the old web service or put the endpoint behind maintenance routing;
   - verify no active or waiting migration-sensitive jobs.
2. Capture a fresh baseline:
   - `/health` version and engine;
   - `gbrain doctor` migration version;
   - page, chunk, embedding, link, tag and timeline counts;
   - active schema pack identity;
   - queue counts by status;
   - source sync freshness.
3. Verify the migration connection plane before taking any lock or running DDL:
   - `DATABASE_URL` points at the production database;
   - `GBRAIN_DIRECT_DATABASE_URL` is present and reaches the direct Postgres endpoint, not only the transaction pooler;
   - the migration role can create/alter tables, indexes, functions, and constraints;
   - `gbrain apply-migrations --list` and `gbrain apply-migrations --dry-run` complete without mutating state.
4. Inspect the v0.46.3 host migration for ZeroEntropy sunset exposure. If the effective embedding or reranker model uses ZeroEntropy, do not silently combine a vector-provider migration with this code/schema cutover. Record the destination provider, dimensions, backup, cost gate, re-embed plan, and rollback as a separate approved migration before production go.
5. Take a fresh custom-format Postgres backup:

   ```bash
   umask 077
   pg_dump --format=custom --no-owner --no-acl \
     --file "$BACKUP_DIR/gbrain-pre-v0.46.24.dump" "$GBRAIN_DIRECT_DATABASE_URL"
   pg_restore --list "$BACKUP_DIR/gbrain-pre-v0.46.24.dump" \
     > "$BACKUP_DIR/gbrain-pre-v0.46.24.restore.list"
   shasum -a 256 "$BACKUP_DIR/gbrain-pre-v0.46.24.dump" \
     > "$BACKUP_DIR/gbrain-pre-v0.46.24.dump.sha256"
   ```

6. Restore the dump into a disposable Postgres database and run the ActVox deployment candidate against the restored copy. Use the schema-only migration entrypoint so host-file/provider orchestrators cannot mutate unrelated state during the database rehearsal:

   ```bash
   gbrain init --migrate-only
   gbrain doctor
   gbrain stats
   ```

7. Require migration `132`, unchanged page/chunk counts, 100% embedding coverage and no failed migration ledger entry.

## Cutover

1. Keep the 0.42 fleet stopped.
2. After merging, capture and freeze the deployment identity:

   ```bash
   EXPECTED_ACTVOX_SHA="$(gh pr view 22 --repo ActVox/gbrain --json mergeCommit --jq '.mergeCommit.oid')"
   test -n "$EXPECTED_ACTVOX_SHA"
   test "$EXPECTED_ACTVOX_SHA" = "$(git ls-remote https://github.com/ActVox/gbrain.git refs/heads/master | cut -f1)"
   ```

3. Manually deploy `EXPECTED_ACTVOX_SHA` to web while worker and crons remain suspended. Do not re-enable broad auto-deploy until the full cutover is verified.
4. Run `gbrain init --migrate-only` once with the ActVox 0.46.24 candidate if startup did not already complete migrations.
5. Confirm migration `132` before starting any worker.
6. Deploy/start the 0.46.24 worker on `EXPECTED_ACTVOX_SHA`.
7. Deploy/enable cron jobs on `EXPECTED_ACTVOX_SHA` only after worker readiness and queue smoke pass.
8. Never re-enable a 0.42 process after migration v131.

## Live verification

Required evidence before declaring success:

```bash
curl -fsS https://gbrain.actvox.dev/health
hermes mcp test gbrain-team
hermes -p eve mcp test gbrain-team
hermes -p actvox-slack mcp test gbrain-team
hermes -p vulcan mcp test gbrain-team
```

Expected:

- `/health.version = 0.46.24.0` and `engine = postgres`;
- every Render service reports `EXPECTED_ACTVOX_SHA`; `/health.version` alone proves the version string, not fork artifact identity;
- doctor reports migration `132` as latest;
- active schema pack remains `gbrain-base-v2@1.0.0+f4f6494a` from `env`;
- page and chunk counts match the fresh pre-deploy baseline;
- embedding coverage remains 100%;
- no wedged or failed queues;
- read smoke works for default and federated sources;
- an attributable write/read smoke succeeds, then the test page is removed;
- all Render web/worker/cron services show the same expected commit.

## Rollback

Before migration 131: redeploying the previous commit is allowed if no state-changing migration has run.

After migration 131: do not start 0.42 against the migrated database. Full rollback means:

1. stop every 0.46 process;
2. restore the verified pre-migration database backup;
3. deploy the previous known-good commit to web and worker;
4. re-enable cron jobs only after `/health`, doctor, MCP and count readback pass.

## Current preparation baseline

Captured during PR preparation:

- production version: `0.42.62.0`;
- engine: Postgres;
- migration: `123` latest for the running binary;
- pages: `2469`;
- chunks: `16126`, embedded: `16126`;
- links: `148`, tags: `647`, timeline entries: `62`;
- active jobs: `0`;
- schema pack: `gbrain-base-v2@1.0.0+f4f6494a`, source `env`.

These numbers are evidence of preparation only. Capture a new baseline immediately before cutover and compare against that fresh snapshot.
