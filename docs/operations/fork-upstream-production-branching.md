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

## Integrating an upstream release

One entry point: `scripts/create-upstream-pr.sh` (the scheduled watcher runs it; locally use `scripts/sync-from-upstream.sh`, a thin wrapper). It merges `upstream/master` into a branch created from `origin/master` **in a temporary worktree**. Your checkout, including uncommitted work, is never touched. `master` is never pushed directly; every integration lands through a PR.

```bash
scripts/sync-from-upstream.sh          # prepare locally; keeps the worktree if a human is needed
scripts/sync-from-upstream.sh --push   # push automation/upstream-master and open/update the PR
```

Conflicts are resolved by `scripts/actvox/resolve-upstream-merge.ts` according to `scripts/actvox/merge-policy.tsv` (first matching glob wins):

| Action | Used for |
|---|---|
| `upstream` | version stamps, CHANGELOG.md, llms bundles, plugin trees, template repo, goldens; generators rerun afterwards |
| `package-pins` | `package.json`: upstream's file with `scripts/actvox/package-pins.json` re-applied as version **floors** (an upstream bump past a floor is kept) |
| `ratchet` | module/function/structural ratchet TSVs: upstream's file with `scripts/actvox/ratchet-overrides.tsv` re-applied |
| `claude-md` | `CLAUDE.md`: upstream's file with `docs/operations/actvox-claude-md-snippet.md` re-inserted after its anchor |
| `admin-rebuild` | `admin/dist`, `src/admin-embedded.ts`: rebuilt from the merged, ActVox-branded `admin/src` |
| `runner-labels` | workflows: upstream's file with Ubicloud labels swapped to hosted Ubuntu, **only** when the fork's side is exactly that swap of the merge base |
| `ours` | ActVox-owned files (`render.yaml`, `docs/operations/*`, `scripts/actvox/*`, fork workflows) |

Anything else that conflicts fails the run (exit 10) and updates one "Upstream sync conflict" issue. A green watcher run therefore means the integration PR exists, not that a conflict was skipped. Proof (2026-10-02): integrating v0.60.28.0 into the 0.60.27.1 fork had 15 conflicts, and all 15 were resolved by policy; the merged tree passed typecheck and `bun run verify` 66/66.

**Versions.** An integration carries upstream's exact version (the `upstream` action does this). A fork-only release between integrations bumps only the `.MICRO` slot (`0.60.27.1`, `0.60.27.2`, …), never PATCH, because PATCH numbers belong to upstream. Fork release notes go in `CHANGELOG.actvox.md`. The same rule is re-inserted into `CLAUDE.md` by the resolver. To make room for that paragraph, the fork raises the CLAUDE.md size cap in `scripts/check-key-files-current-state.sh` from 35000 to 36000 bytes. If an integration's `verify` fails on that cap because upstream grew CLAUDE.md, raise it again in a reviewed commit and update its inventory row.

**Fork-delta ratchet.** `scripts/actvox/upstream-base` records the upstream commit last integrated; the integration script updates it. `bun scripts/actvox/check-delta.ts` (workflow `actvox-delta.yml`) fails when a fork edit to an upstream-owned file is not in `scripts/actvox/patch-inventory.tsv`, exceeds its line budget, or a hand-edited row no longer matches anything. Raise a budget or add a row only in a reviewed commit, and remove a row in the same commit that removes its patch. `--print` lists the current delta in inventory format.

**Watcher credential.** `.github/workflows/upstream-watch.yml` uses a GitHub App installation token, because `GITHUB_TOKEN` cannot push commits that touch `.github/workflows/`, and PRs it opens do not trigger CI. One-time setup by an org owner:

1. Create a GitHub App owned by the ActVox org (no webhook). Repository permissions: Contents, Pull requests, Issues and Workflows: read & write.
2. Install it on `ActVox/gbrain` only.
3. Set repo variable `ACTVOX_UPSTREAM_APP_CLIENT_ID` to the App's client ID, and repo secret `ACTVOX_UPSTREAM_APP_PRIVATE_KEY` to a generated private key.
4. Run the workflow manually (`workflow_dispatch`). It must either open or update the PR with required checks running, or fail red with the conflict issue updated.

Until the credential exists, every run fails with "Upstream watcher credential missing".

## Current ActVox patch classes

These are intentional and should not be discarded during upstream sync:

- Render topology: `render.yaml`, `GBRAIN_DIRECT_DATABASE_URL`, ZeroEntropy env wiring, `--bind 0.0.0.0`, trust proxy, web/worker/cron services.
- Team source corpus: Render worker/cron source list and persistent `/var/gbrain/repos` behavior.
- MCP/extract fixes for federated/team sources.
- Schema-pack lookup and extraction watermark fixes.
- Local/private-brain CLI reliability fixes around PGLite shutdown.
- Operational-memory ranking policy for ActVox agent retrieval.

Before deleting a patch, prove it is either upstream-equivalent or no longer used in production. The file-level list with budgets and upstream status is `scripts/actvox/patch-inventory.tsv`.

## Agent host boundary

A local GBrain CLI can be a thin client of the team server; verify the endpoint, credential and source before treating it as a separate private brain. Deduplicate aliases only when both endpoint and authorization identity match. Keep private knowledge separate and promote sanitized shared notes deliberately.

Hermes and OpenClaw on other machines have independent application lifecycles. A Team GBrain upgrade does not update those applications or prove native integration. Inspect and maintain those hosts only when they are included in the maintenance scope.

## Controlled maintenance

Keep the fork current through a pinned upstream commit and a separate integration branch. Preserve the patch classes above, run the complete gates, and record the upstream commit with the released fork version. Native agent applications are a separate update scope.

For an exact-release integration, verify the upstream release tag resolves to the pinned second parent, then mirror it to the fork as `upstream/v<VERSION>` without force. Reserve bare `v<VERSION>` tags for fork releases so identical version numbers cannot collide. Stop on a conflicting existing namespaced tag. The Semgrep baseline selector requires exact-parent provenance and blocks when it is missing; historical bare upstream tags remain compatible. Mirroring a tag does not mark the fork release deployed.

Hosted builds pin Bun 1.4.2 and suppress root install lifecycle scripts. Database migrations belong in the coordinated cutover, never in a build that can overlap an older running service. Build the application explicitly after dependency installation.

Keep automatic deployment disabled on all four services. Promote the same reviewed commit through a coordinated rollout; merging production code must not independently restart one old/new writer pair. Preserve the live nine-source roster and sync/embed schedule. A runtime update does not enable additional enrichment jobs or repeat initial bulk indexing.

Before a schema or writer-authority upgrade, verify a private PostgreSQL restore and a managed-file archive, stop all old writers and job producers, then run the new schema migration once. Resume only the matched server, worker and cron release. Do not blindly replay legacy jobs, overwrite source ownership, or use an executable-only rollback after a schema change.

The upstream CLI self-updater is not a fork integration tool: its release and attestation endpoints belong to upstream. Use the reviewed ActVox maintenance branch for this deployment and keep the previous binaries plus a compatible database recovery point.
