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

cat <<'EOF'
OK: branch topology guard passed.

Safe upstream merge path (merges in its own temporary worktree; this checkout is untouched):
  scripts/sync-from-upstream.sh            # prepare locally, keep the worktree for any residual conflicts
  scripts/sync-from-upstream.sh --push     # push the integration branch and open/update the PR

Hard rule: PR base is master. ATX-HUB is rollback/reference only.
EOF
