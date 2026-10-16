#!/usr/bin/env bash
# #6756: ci:local mounts the named volume gbrain-ci-admin-dist over
# /app/admin/dist (so the container's builds never write the host checkout),
# and a new named volume starts empty: a fresh checkout's `bun run build` then
# failed on the hashed bundles src/admin-embedded.ts imports. The runner calls
# this before the build to make the volume an exact copy of the worktree's
# admin/dist (mounted read-only at /ci-src/admin-dist): the current worktree
# bytes, uncommitted changes included, with stale hashed files from an older
# build removed. Usage: ci-hydrate-admin-dist.sh <worktree admin/dist> <volume admin/dist>
set -euo pipefail
src="${1:?usage: ci-hydrate-admin-dist.sh <worktree admin/dist> <volume admin/dist>}"
dest="${2:?usage: ci-hydrate-admin-dist.sh <worktree admin/dist> <volume admin/dist>}"
if [ ! -f "$src/index.html" ]; then
  echo "[runner] ERROR: $src/index.html is missing, so the worktree's committed admin/dist is absent and the CLI build cannot embed it. Restore it with git checkout -- admin/dist (or rebuild it with bun run build:admin) and rerun ci:local." >&2
  exit 1
fi
mkdir -p "$dest"
find "$dest" -mindepth 1 -delete
cp -R "$src/." "$dest/"
echo "[runner] admin/dist hydrated from the worktree ($(find "$dest" -type f | wc -l | tr -d ' ') files)"
