#!/usr/bin/env bash
#
# sync-from-upstream.sh — local entry point for integrating garrytan/gbrain into
# the ActVox fork. Thin wrapper over scripts/create-upstream-pr.sh, which merges
# in a dedicated temporary worktree (the caller's checkout is never modified),
# resolves conflicts per scripts/actvox/merge-policy.tsv and stops on anything
# the policy does not cover.
#
# Usage:
#   scripts/sync-from-upstream.sh               # prepare the integration branch locally, keep the worktree
#   scripts/sync-from-upstream.sh --push        # also push the branch and open/update the PR against master
#   scripts/sync-from-upstream.sh --remote foo  # advanced: integrate foo/master
#
# master is never pushed directly; every integration lands through a PR.
set -euo pipefail

args=(--keep-worktree)
push=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) export UPSTREAM_REMOTE="${2:?--remote needs a value}"; shift 2 ;;
    --push)   push=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ "$push" -eq 1 ] || args+=(--no-push)
exec bash "$(dirname "$0")/create-upstream-pr.sh" "${args[@]}"
