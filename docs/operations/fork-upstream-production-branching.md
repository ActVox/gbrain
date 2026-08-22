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

## OpenClaw equivalent policy

Use the same conceptual split for OpenClaw, but not the same mechanics unless ActVox actually runs from a source fork.

Current production OpenClaw on Konstantin's host is the stable npm/global package, not a Render-style source deploy. Therefore:

- default path: `npm openclaw latest` → global stable package → LaunchAgent `ai.openclaw.gateway`;
- only keep an ActVox fork branch when we carry real source patches;
- if ActVox starts deploying OpenClaw from source, then use the same model: `upstream/main` → `ActVox/openclaw:main` → production runtime, with ActVox patches documented and guarded.

Do not leave a stale fork branch pretending to be production when the running system is actually the npm package.
