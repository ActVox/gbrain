#!/usr/bin/env bash
#
# sync-from-upstream.sh — pull garrytan/gbrain updates into the ActVox
# production/integration branch.
#
# Branch model:
#   upstream/master = external upstream (garrytan/gbrain)
#   origin/master   = ActVox production/integration branch (Render deploy target)
#   origin/ATX-HUB  = legacy rollout branch / rollback reference only
#
# Usage:
#   scripts/sync-from-upstream.sh               # merge upstream/master, no push
#   scripts/sync-from-upstream.sh --push        # push origin/master after verify
#   scripts/sync-from-upstream.sh --remote foo  # advanced: merge foo/master
#
# Conflict policy (deterministic):
#   VERSION, package.json, CHANGELOG.md, bun.lock  -> take upstream's release artifacts
#   render.yaml, docs/plans/*, docs/operations/*   -> keep ActVox's operational config/docs
#   anything else (source, tests)                  -> STOP, resolve by hand
#
set -euo pipefail

REMOTE="upstream"
PUSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="${2:?--remote needs a value}"; shift 2 ;;
    --push)   PUSH=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "master" ]; then
  echo "✗ Must be on ActVox production branch 'master' (currently on '$BRANCH')." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Working tree is dirty — commit or stash first." >&2
  exit 1
fi

echo "→ Fetching $REMOTE/master ..."
git fetch "$REMOTE" master

BEFORE="$(git rev-parse HEAD)"
echo "→ Merging $REMOTE/master into ActVox master ..."
if git merge --no-edit "$REMOTE/master"; then
  echo "✓ Clean merge (no conflicts)."
else
  echo "→ Resolving deterministic conflicts ..."
  # Upstream owns release artifacts.
  for f in VERSION package.json CHANGELOG.md bun.lock; do
    if git diff --name-only --diff-filter=U | grep -qx "$f"; then
      git checkout --theirs -- "$f" && git add -- "$f" && echo "    $f → upstream"
    fi
  done
  # ActVox owns deployment config and operations docs.
  for f in render.yaml; do
    if git diff --name-only --diff-filter=U | grep -qx "$f"; then
      git checkout --ours -- "$f" && git add -- "$f" && echo "    $f → ActVox"
    fi
  done
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    git checkout --ours -- "$f" && git add -- "$f" && echo "    $f → ActVox"
  done < <(git diff --name-only --diff-filter=U | grep -E '^(docs/plans/|docs/operations/)' || true)

  REMAIN="$(git diff --name-only --diff-filter=U || true)"
  if [ -n "$REMAIN" ]; then
    echo "" >&2
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
  echo "✗ verify FAILED — fix before pushing." >&2
  exit 4
fi

echo ""
echo "Version consistency:"
echo "    VERSION:      $(cat VERSION)"
echo "    package.json: $(node -e 'process.stdout.write(require("./package.json").version)')"
echo "    CHANGELOG:    $(grep -E '^## \\[' CHANGELOG.md | head -1)"
echo ""

if [ "$PUSH" = "1" ]; then
  echo "→ Pushing master (⚠ production deploy if Render tracks master) ..."
  git push origin master
  echo "✓ Synced and pushed."
else
  echo "✓ Synced locally. Review, then push when ready:"
  echo "    git push origin master      # ⚠ production deploy if Render tracks master"
fi
