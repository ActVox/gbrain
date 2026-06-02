#!/usr/bin/env bash
#
# sync-from-master.sh — pull upstream gbrain updates into the ATX-HUB deployment branch.
#
# Keeps ATX-HUB current with master WITHOUT an upstream PR. Auto-resolves the
# handful of conflicts that happen on every merge (always the same files, always
# the same resolution), runs the verify gate, and stops for manual help only on
# real source conflicts.
#
# Usage:
#   scripts/sync-from-master.sh                 # merge origin/master, no push
#   scripts/sync-from-master.sh --remote upstream   # pull from public garrytan/gbrain
#   scripts/sync-from-master.sh --push          # push ATX-HUB after a clean sync
#                                               #   (⚠ triggers a Render redeploy)
#
# Conflict policy (deterministic):
#   VERSION, package.json, CHANGELOG.md, bun.lock  -> take master's (ATX ships no release)
#   render.yaml, docs/plans/*                      -> keep ATX's (deployment config)
#   anything else (source, tests)                  -> STOP, resolve by hand
#
set -euo pipefail

REMOTE="origin"
PUSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="${2:?--remote needs a value}"; shift 2 ;;
    --push)   PUSH=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "ATX-HUB" ]; then
  echo "✗ Must be on ATX-HUB (currently on '$BRANCH')." >&2; exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Working tree is dirty — commit or stash first." >&2; exit 1
fi

echo "→ Fetching $REMOTE/master ..."
git fetch "$REMOTE" master

BEFORE="$(git rev-parse HEAD)"
echo "→ Merging $REMOTE/master into ATX-HUB ..."
if git merge --no-edit "$REMOTE/master"; then
  echo "✓ Clean merge (no conflicts)."
else
  echo "→ Resolving deterministic conflicts ..."
  # master always owns the release artifacts
  for f in VERSION package.json CHANGELOG.md bun.lock; do
    if git diff --name-only --diff-filter=U | grep -qx "$f"; then
      git checkout --theirs -- "$f" && git add -- "$f" && echo "    $f → master"
    fi
  done
  # ATX always owns its deployment config
  for f in render.yaml; do
    if git diff --name-only --diff-filter=U | grep -qx "$f"; then
      git checkout --ours -- "$f" && git add -- "$f" && echo "    $f → ATX"
    fi
  done
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    git checkout --ours -- "$f" && git add -- "$f" && echo "    $f → ATX"
  done < <(git diff --name-only --diff-filter=U | grep '^docs/plans/' || true)

  REMAIN="$(git diff --name-only --diff-filter=U || true)"
  if [ -n "$REMAIN" ]; then
    echo ""
    echo "✗ Manual resolution needed (real source/test conflicts):" >&2
    echo "$REMAIN" | sed 's/^/    /' >&2
    echo "" >&2
    echo "  Resolve them, then:" >&2
    echo "    git add <files> && git commit --no-edit && bun run verify" >&2
    exit 3
  fi
  git commit --no-edit
  echo "✓ Conflicts auto-resolved."
fi

if [ "$(git rev-parse HEAD)" = "$BEFORE" ]; then
  echo "✓ Already up to date with $REMOTE/master — nothing to do."
  exit 0
fi

echo "→ Refreshing lockfile ..."
bun install >/dev/null 2>&1 || true
if ! git diff --quiet -- bun.lock; then
  git add -- bun.lock && git commit --amend --no-edit
fi

echo "→ Running verify gate ..."
if ! bun run verify; then
  echo "✗ verify FAILED — fix before pushing." >&2; exit 4
fi

echo ""
echo "Version consistency:"
echo "    VERSION:      $(cat VERSION)"
echo "    package.json: $(node -e 'process.stdout.write(require("./package.json").version)')"
echo "    CHANGELOG:    $(grep -E '^## \[' CHANGELOG.md | head -1)"
echo ""

if [ "$PUSH" = "1" ]; then
  echo "→ Pushing ATX-HUB (⚠ triggers a Render redeploy of web + worker) ..."
  git push origin ATX-HUB
  echo "✓ Synced and pushed."
else
  echo "✓ Synced locally. Review, then push when ready:"
  echo "    git push origin ATX-HUB      # ⚠ triggers a Render redeploy"
fi
