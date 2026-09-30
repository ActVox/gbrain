# Fork / upstream / production branch policy

This repository is the ActVox production fork of upstream GBrain.

## Remotes

- `origin` = `https://github.com/ActVox/gbrain.git` — ActVox fork, production/integration ownership.
- `upstream` = `https://github.com/garrytan/gbrain.git` — external upstream source.

Do not use `origin/master` as a clean mirror of upstream. `upstream/master` is the clean upstream.

## Branch roles

- `origin/master` is the ActVox production/integration branch.
  - Render services should track this branch.
  - ActVox-specific deployment config and operational patches live here.
- `upstream/master` is merged into `origin/master` through a guarded update path.
- `origin/ATX-HUB` was the temporary rollout/deploy branch. Keep only as a short-lived rollback reference after migration; do not continue feature or deploy work there.

## Update flow

```text
garrytan/gbrain:master  →  ActVox/gbrain:master  →  Render production
upstream/master         →  origin/master          →  gbrain-web / gbrain-worker / crons
```

Guardrails:

1. Never blind-pull production.
2. Fetch upstream first.
3. Merge in a clean checkout or disposable worktree.
4. Preserve ActVox deployment files (`render.yaml`, operations docs) unless explicitly changing production topology.
5. Run the verification gate before pushing.
6. Treat a push to `origin/master` as production-impacting once Render tracks `master`.
7. After push, verify `/health`, MCP discovery, and worker/cron health.

## Current ActVox patch classes

These are intentional and should not be discarded during upstream sync:

- Render topology: `render.yaml`, `GBRAIN_DIRECT_DATABASE_URL`, ZeroEntropy env wiring, `--bind 0.0.0.0`, trust proxy, web/worker/cron services.
- Team source corpus: Render worker/cron source list and persistent `/var/gbrain/repos` behavior.
- MCP/extract fixes for federated/team sources.
- Schema-pack lookup and extraction watermark fixes.
- Local/private-brain CLI reliability fixes around PGLite shutdown.
- Operational-memory ranking policy for ActVox agent retrieval.

Before deleting a patch, prove it is either upstream-equivalent or no longer used in production.

## Agent host boundary

A local GBrain CLI can be a thin client of the team server; verify the endpoint, credential and source before treating it as a separate private brain. Deduplicate aliases only when both endpoint and authorization identity match. Keep private knowledge separate and promote sanitized shared notes deliberately.

Hermes and OpenClaw on other machines have independent application lifecycles. A Team GBrain upgrade does not update those applications or prove native integration. Inspect and maintain those hosts only when they are included in the maintenance scope.

## Controlled maintenance

Keep the fork current through a pinned upstream commit and a separate integration branch. Preserve the patch classes above, run the complete gates, and record the upstream commit with the released fork version. Native agent applications are a separate update scope.

Hosted builds pin Bun 1.4.2 and suppress root install lifecycle scripts. Database migrations belong in the coordinated cutover, never in a build that can overlap an older running service. Build the application explicitly after dependency installation.

Keep automatic deployment disabled on all four services. Promote the same reviewed commit through a coordinated rollout; merging production code must not independently restart one old/new writer pair. Preserve the live nine-source roster and sync/embed schedule. A runtime update does not enable additional enrichment jobs or repeat initial bulk indexing.

Before a schema or writer-authority upgrade, verify a private PostgreSQL restore and a managed-file archive, stop all old writers and job producers, then run the new schema migration once. Resume only the matched server, worker and cron release. Do not blindly replay legacy jobs, overwrite source ownership, or use an executable-only rollback after a schema change.

The upstream CLI self-updater is not a fork integration tool: its release and attestation endpoints belong to upstream. Use the reviewed ActVox maintenance branch for this deployment and keep the previous binaries plus a compatible database recovery point.
