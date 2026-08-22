#!/usr/bin/env bash
# Audit the ActVox GBrain branch-topology invariant.
# Exits non-zero when active local state or active instructions can steer agents
# back to ATX-HUB for upstream integration.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERROR: not inside a git repository" >&2
  exit 2
}
cd "$repo_root"

fail=0

section() { printf '\n== %s ==\n' "$1"; }
problem() { echo "ERROR: $*" >&2; fail=1; }

section "repository"
git status --short --branch
git remote -v

origin_url="$(git remote get-url origin 2>/dev/null || true)"
upstream_url="$(git remote get-url upstream 2>/dev/null || true)"
[[ "$origin_url" == *"ActVox/gbrain"* ]] || problem "origin is not ActVox/gbrain: $origin_url"
[[ "$upstream_url" == *"garrytan/gbrain"* ]] || problem "upstream is not garrytan/gbrain: $upstream_url"

branch="$(git branch --show-current)"
upstream_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [[ "$branch" == "ATX-HUB" || "$upstream_ref" == "origin/ATX-HUB" ]]; then
  problem "current branch/upstream points at ATX-HUB; it is rollback-only"
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "WARN: working tree is dirty; this is OK while editing, not OK before upstream integration." >&2
fi

section "remote divergence"
git fetch origin master --prune --quiet
git fetch upstream master --prune --quiet
printf 'origin/master...upstream/master: '
git rev-list --left-right --count origin/master...upstream/master
if git show-ref --verify --quiet refs/remotes/origin/ATX-HUB; then
  printf 'origin/master...origin/ATX-HUB: '
  git rev-list --left-right --count origin/master...origin/ATX-HUB
  if ! git merge-base --is-ancestor origin/ATX-HUB origin/master; then
    problem "origin/master does not contain origin/ATX-HUB; topology changed"
  fi
fi

section "local ATX affordances"
local_atx_refs="$(git for-each-ref --format='%(refname:short) %(upstream:short)' refs/heads | grep -E '(^ATX-HUB |origin/ATX-HUB$|^upgrade/gbrain)' || true)"
if [[ -n "$local_atx_refs" ]]; then
  echo "$local_atx_refs"
  problem "local ATX/old upgrade branches exist; delete/quarantine them before upstream integration"
else
  echo "OK: no local ATX-based upgrade branches"
fi

worktree_atx="$(git worktree list --porcelain | awk '
  /^worktree / { path=$2 }
  /^branch refs\/heads\// { branch=$0; sub(/^branch refs\/heads\//, "", branch); if (branch == "ATX-HUB" || branch ~ /^upgrade\/gbrain/) print path " " branch }
' || true)"
if [[ -n "$worktree_atx" ]]; then
  echo "$worktree_atx"
  problem "ATX/old upgrade worktrees exist; remove/quarantine them before upstream integration"
else
  echo "OK: no ATX/old upgrade worktrees"
fi

section "active instruction scan"
active_patterns=(
  'worktree add.*ATX-HUB'
  '--base ATX-HUB'
  'production currently tracks.*ATX-HUB'
  'aligned with `origin/ATX-HUB`'
)
for pattern in "${active_patterns[@]}"; do
  matches="$(grep -RInE --exclude='audit-branch-topology.sh' -- "$pattern" scripts docs .github 2>/dev/null || true)"
  if [[ -n "$matches" ]]; then
    echo "$matches"
    problem "active ATX instruction pattern found: $pattern"
  fi
done

section "result"
if [[ "$fail" -ne 0 ]]; then
  echo "FAIL: branch topology invariant is not clean." >&2
  exit 1
fi

echo "OK: branch topology invariant holds. Use origin/master for upstream integration; ATX-HUB is rollback-only."
