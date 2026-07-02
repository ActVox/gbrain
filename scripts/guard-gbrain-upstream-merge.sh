#!/usr/bin/env bash
# Guard the ActVox GBrain upstream-integration path.
#
# Invariant:
#   upstream/master      = external garrytan/gbrain
#   origin/master        = ActVox production/integration
#   origin/ATX-HUB       = legacy rollback/reference only
#
# This script does not merge anything. It validates branch topology and prints
# the only blessed worktree command for upstream integration.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERROR: not inside a git repository" >&2
  exit 2
}
cd "$repo_root"

origin_url="$(git remote get-url origin 2>/dev/null || true)"
upstream_url="$(git remote get-url upstream 2>/dev/null || true)"
if [[ "$origin_url" != *"ActVox/gbrain"* ]]; then
  echo "ERROR: origin is not ActVox/gbrain: $origin_url" >&2
  exit 2
fi
if [[ "$upstream_url" != *"garrytan/gbrain"* ]]; then
  echo "ERROR: upstream is not garrytan/gbrain: $upstream_url" >&2
  exit 2
fi

branch="$(git branch --show-current)"
upstream_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"

if [[ "$branch" == "ATX-HUB" || "$upstream_ref" == "origin/ATX-HUB" ]]; then
  echo "ERROR: ATX-HUB is rollback-only. Do not base upstream merges on it." >&2
  exit 3
fi

# Refresh only the refs this guard reasons about.
git fetch origin master --prune --quiet
git fetch upstream master --prune --quiet

if ! git show-ref --verify --quiet refs/remotes/origin/master; then
  echo "ERROR: missing origin/master" >&2
  exit 4
fi
if ! git show-ref --verify --quiet refs/remotes/upstream/master; then
  echo "ERROR: missing upstream/master" >&2
  exit 4
fi

if git show-ref --verify --quiet refs/remotes/origin/ATX-HUB; then
  if ! git merge-base --is-ancestor origin/ATX-HUB origin/master; then
    echo "ERROR: origin/master does not contain origin/ATX-HUB. Branch topology changed; stop." >&2
    exit 5
  fi
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is dirty; commit/stash before creating an upstream merge worktree." >&2
  exit 6
fi

cat <<'EOF'
OK: branch topology guard passed.

Safe upstream merge path:
  TS=$(date +%Y%m%d%H%M%S)
  WT=/Users/nezovskii/workspace/tmp/gbrain-upstream-merge-$TS
  git worktree add -b upgrade/gbrain-upstream-$TS "$WT" origin/master
  git -C "$WT" merge --no-commit --no-ff upstream/master

Hard rule: PR base is master. ATX-HUB is rollback/reference only.
EOF
