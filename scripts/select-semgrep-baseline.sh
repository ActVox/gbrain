#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s <pr-base-sha> <pr-head-sha>\n' "${0##*/}" >&2
  exit 64
}

[[ $# -eq 2 ]] || usage
base_sha=$1
head_sha=$2

git cat-file -e "${base_sha}^{commit}"
git cat-file -e "${head_sha}^{commit}"

merge_base=$(git merge-base "$base_sha" "$head_sha")
[[ -n "$merge_base" ]]

while IFS= read -r merge_commit; do
  [[ -n "$merge_commit" ]] || continue
  read -r -a parents <<<"$(git show -s --format='%P' "$merge_commit")"
  [[ ${#parents[@]} -eq 2 ]] || continue

  subject=$(git show -s --format='%s' "$merge_commit")
  if [[ ! "$subject" =~ [Ii]ntegrat(e|ing).*([Gg][Bb]rain|upstream) ]]; then
    continue
  fi

  upstream_parent=${parents[1]}
  release_tag=$(git tag --points-at "$upstream_parent" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)
  if [[ -z "$release_tag" ]]; then
    printf 'Semgrep baseline error: integration merge %s has no mirrored exact release tag on second parent %s\n' \
      "$merge_commit" "$upstream_parent" >&2
    exit 65
  fi

  printf 'Semgrep baseline: exact upstream release %s (%s) from integration merge %s\n' \
    "$release_tag" "$upstream_parent" "$merge_commit" >&2
  printf '%s\n' "$upstream_parent"
  exit 0
done < <(git rev-list --first-parent --merges "${merge_base}..${head_sha}")

printf 'Semgrep baseline: ordinary PR merge-base %s\n' "$merge_base" >&2
printf '%s\n' "$merge_base"
