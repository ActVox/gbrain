#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
selector="$script_dir/select-semgrep-baseline.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/gbrain-semgrep-baseline-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

repo="$tmp/repo"
git init -q -b master "$repo"
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.invalid
printf 'base\n' >"$repo/app.txt"
git -C "$repo" add app.txt
git -C "$repo" commit -q -m base
base=$(git -C "$repo" rev-parse HEAD)

git -C "$repo" switch -q -c ordinary
printf 'ordinary\n' >>"$repo/app.txt"
git -C "$repo" commit -qam 'fix: ordinary pull request'
ordinary=$(git -C "$repo" rev-parse HEAD)
actual=$(cd "$repo" && bash "$selector" "$base" "$ordinary")
[[ "$actual" == "$base" ]]

git -C "$repo" switch -q -c upstream-release "$base"
printf 'release\n' >"$repo/upstream.txt"
git -C "$repo" add upstream.txt
git -C "$repo" commit -q -m 'v0.47.7.0 release'
upstream=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" tag v0.47.7.0 "$upstream"

git -C "$repo" switch -q ordinary
git -C "$repo" merge -q --no-ff upstream-release -m 'chore: integrate GBrain v0.47.7.0'
integration=$(git -C "$repo" rev-parse HEAD)
actual=$(cd "$repo" && bash "$selector" "$base" "$integration")
[[ "$actual" == "$upstream" ]]

git -C "$repo" switch -q -c untagged "$base"
printf 'untagged\n' >"$repo/untagged.txt"
git -C "$repo" add untagged.txt
git -C "$repo" commit -q -m 'candidate without release tag'
untagged_parent=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" switch -q -c untagged-integration "$base"
printf 'fork\n' >"$repo/fork.txt"
git -C "$repo" add fork.txt
git -C "$repo" commit -q -m 'fix: fork overlay'
git -C "$repo" merge -q --no-ff "$untagged_parent" -m 'chore: integrate GBrain untagged candidate'
untagged_merge=$(git -C "$repo" rev-parse HEAD)
if (cd "$repo" && bash "$selector" "$base" "$untagged_merge" >/dev/null 2>&1); then
  printf 'selector accepted an untagged integration merge\n' >&2
  exit 1
fi

if (cd "$repo" && bash "$selector" deadbeef "$ordinary" >/dev/null 2>&1); then
  printf 'selector accepted a missing base commit\n' >&2
  exit 1
fi

printf 'semgrep baseline selector: PASS\n'
