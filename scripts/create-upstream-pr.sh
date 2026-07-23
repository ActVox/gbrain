#!/usr/bin/env bash
# Create/update the guarded upstream-sync PR for ActVox/gbrain.
#
# Invariant:
#   garrytan/gbrain:master -> integration branch in ActVox/gbrain -> PR to ActVox/gbrain:master
#   ATX-HUB is rollback/reference only and must never be a PR base.

set -euo pipefail

BASE_BRANCH="${BASE_BRANCH:-master}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"
ORIGIN_REMOTE="${ORIGIN_REMOTE:-origin}"
PR_BRANCH="${PR_BRANCH:-automation/upstream-master}"
PR_TITLE="${PR_TITLE:-chore: sync upstream gbrain master}"
DRY_RUN=0
PUSH=1

usage() {
  cat <<'EOF'
Usage: scripts/create-upstream-pr.sh [--dry-run] [--no-push]

Environment overrides:
  BASE_BRANCH=master
  UPSTREAM_REMOTE=upstream
  UPSTREAM_BRANCH=master
  ORIGIN_REMOTE=origin
  PR_BRANCH=automation/upstream-master
  PR_TITLE="chore: sync upstream gbrain master"

Requires gh auth when pushing/opening PRs.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; PUSH=0; shift ;;
    --no-push) PUSH=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERROR: not inside a git repository" >&2
  exit 2
}
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is dirty; commit/stash before creating upstream PR" >&2
  exit 6
fi

origin_url="$(git remote get-url "$ORIGIN_REMOTE" 2>/dev/null || true)"
upstream_url="$(git remote get-url "$UPSTREAM_REMOTE" 2>/dev/null || true)"
if [[ "$origin_url" != *"ActVox/gbrain"* ]]; then
  echo "ERROR: $ORIGIN_REMOTE is not ActVox/gbrain: $origin_url" >&2
  exit 2
fi
if [[ "$upstream_url" != *"garrytan/gbrain"* ]]; then
  echo "ERROR: $UPSTREAM_REMOTE is not garrytan/gbrain: $upstream_url" >&2
  exit 2
fi

# Reuse the repository's existing ActVox-vs-upstream guard rails before
# preparing an automation branch. The inline checks below intentionally remain
# as defense-in-depth in case this script is invoked from a reduced checkout.
bash scripts/audit-branch-topology.sh
bash scripts/guard-gbrain-upstream-merge.sh

if git show-ref --verify --quiet refs/remotes/${ORIGIN_REMOTE}/ATX-HUB; then
  git fetch "$ORIGIN_REMOTE" ATX-HUB --quiet || true
fi
git fetch "$ORIGIN_REMOTE" "$BASE_BRANCH" --prune --quiet
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" --prune --quiet

base_ref="refs/remotes/${ORIGIN_REMOTE}/${BASE_BRANCH}"
upstream_ref="refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"

if [[ "$BASE_BRANCH" == "ATX-HUB" || "$PR_BRANCH" == "ATX-HUB" ]]; then
  echo "ERROR: ATX-HUB is rollback-only" >&2
  exit 3
fi

if git show-ref --verify --quiet refs/remotes/${ORIGIN_REMOTE}/ATX-HUB; then
  if ! git merge-base --is-ancestor "${ORIGIN_REMOTE}/ATX-HUB" "${ORIGIN_REMOTE}/${BASE_BRANCH}"; then
    echo "ERROR: ${ORIGIN_REMOTE}/${BASE_BRANCH} does not contain ${ORIGIN_REMOTE}/ATX-HUB; topology changed" >&2
    exit 5
  fi
fi

if git merge-base --is-ancestor "$upstream_ref" "$base_ref"; then
  echo "OK: ${ORIGIN_REMOTE}/${BASE_BRANCH} already contains ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}; no PR needed."
  exit 0
fi

left_right="$(git rev-list --left-right --count "$base_ref...$upstream_ref")"
base_only="${left_right%%[[:space:]]*}"
upstream_only="${left_right##*[[:space:]]}"
base_sha="$(git rev-parse "$base_ref")"
upstream_sha="$(git rev-parse "$upstream_ref")"

# Recreate the automation branch from the production base every run. It is not
# production and force-pushing it is intentional: one PR represents latest upstream.
git checkout -B "$PR_BRANCH" "$base_ref" >/dev/null

merge_exit=0
git merge --no-ff --no-edit "$upstream_ref" || merge_exit=$?
if [[ "$merge_exit" -ne 0 ]]; then
  conflict_files_raw="$(git diff --name-only --diff-filter=U)"
  if [[ -z "$conflict_files_raw" ]] || ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    echo "ERROR: upstream merge failed without resolvable conflict state (exit ${merge_exit})" >&2
    exit "$merge_exit"
  fi
  conflict_files="$(printf '%s\n' "$conflict_files_raw" | sed 's/^/- /')"
  if ! git merge --abort; then
    echo "ERROR: failed to abort conflicted upstream merge" >&2
    exit 11
  fi
  cat > /tmp/gbrain-upstream-conflict.md <<EOF
## Upstream sync conflict

Automated merge failed.

- Base: \`${ORIGIN_REMOTE}/${BASE_BRANCH}\` @ \`${base_sha}\`
- Upstream: \`${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}\` @ \`${upstream_sha}\`
- Commits ahead upstream: ${upstream_only}

### Conflicted files
${conflict_files:-none reported}

Manual path:
\`\`\`bash
git checkout ${BASE_BRANCH}
git pull --ff-only ${ORIGIN_REMOTE} ${BASE_BRANCH}
scripts/guard-gbrain-upstream-merge.sh
# then create a temporary worktree and resolve the merge into a PR against master
\`\`\`
EOF
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'merge_conflict=true\n' >> "$GITHUB_OUTPUT"
  fi
  if [[ "$PUSH" -eq 1 ]]; then
    if ! issues_enabled="$(gh repo view ActVox/gbrain --json hasIssuesEnabled --jq '.hasIssuesEnabled')"; then
      echo "ERROR: could not query ActVox/gbrain Issues capability" >&2
      exit 12
    fi
    if [[ "$issues_enabled" == "true" ]]; then
      gh issue create \
        --repo ActVox/gbrain \
        --title "Upstream sync conflict: garrytan/gbrain master" \
        --body-file /tmp/gbrain-upstream-conflict.md
    elif [[ "$issues_enabled" == "false" ]]; then
      echo "INFO: repository Issues are disabled; conflict report kept as a workflow artifact."
    else
      echo "ERROR: unexpected hasIssuesEnabled value for ActVox/gbrain: $issues_enabled" >&2
      exit 12
    fi
  else
    cat /tmp/gbrain-upstream-conflict.md
  fi
  if [[ "${CONFLICT_IS_WARNING:-0}" == "1" ]]; then
    echo "::warning title=Upstream merge conflict::Manual semantic integration is required; see the uploaded conflict report."
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      cat /tmp/gbrain-upstream-conflict.md >> "$GITHUB_STEP_SUMMARY"
    fi
    exit 0
  fi
  exit 10
fi

range="${base_ref}..HEAD"
changed_files="$(git diff --name-only "$range" | sort)"
commit_subjects="$(git log --no-merges --format='- %h %s' "$range" | head -80)"

risk_lines=()
add_risk() {
  local level="$1" area="$2" reason="$3"
  risk_lines+=("- **${level} / ${area}** — ${reason}")
}

if echo "$changed_files" | grep -Eq '(^|/)(src/mcp/|src/core/operations\.ts|src/commands/serve-http\.ts|src/oauth/|src/core/auth|src/core/file|file_upload)'; then
  add_risk "HIGH" "security" "MCP/auth/OAuth/file-operation surface changed; human security review required."
fi
if echo "$changed_files" | grep -Eq '(^|/)(migrations/|src/core/schema|schema|sql/)'; then
  add_risk "HIGH" "database" "Schema/migration surface changed; take/verify DB backup before merge."
fi
if echo "$changed_files" | grep -Eq '(^|/)(package\.json|bun\.lock|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$'; then
  add_risk "MED" "dependencies" "Dependency graph changed; run audit and inspect transitive updates."
fi
if echo "$changed_files" | grep -Eq '(^|/)(src/core/db-lock\.ts|src/core/minions/|src/commands/jobs\.ts|src/commands/autopilot\.ts)'; then
  add_risk "MED" "worker" "Minions/jobs/lock behavior changed; watch worker deploy and queue health."
fi
if echo "$changed_files" | grep -Eq '(^|/)(render\.yaml|Dockerfile|docker-compose|\.github/workflows/)'; then
  add_risk "MED" "ops" "Deploy/CI infrastructure changed; review Render/GitHub behavior before merge."
fi
if [[ ${#risk_lines[@]} -eq 0 ]]; then
  risk_lines=("- **LOW / routine** — no obvious security, DB, dependency, worker, or deploy hot spots matched.")
fi

changed_preview="$(printf '%s\n' "$changed_files" | sed 's/^/- /' | head -120)"
if [[ "$(printf '%s\n' "$changed_files" | wc -l | tr -d ' ')" -gt 120 ]]; then
  changed_preview+=$'\n- ... truncated after 120 files'
fi

cat > /tmp/gbrain-upstream-pr.md <<EOF
## Automated upstream sync

This PR merges \`${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}\` (garrytan/gbrain) into \`${ORIGIN_REMOTE}/${BASE_BRANCH}\` (ActVox production/integration).

**Hard invariant:** PR base is \`${BASE_BRANCH}\`; \`ATX-HUB\` is rollback/reference only.

### Range

- Base: \`${base_sha}\`
- Upstream: \`${upstream_sha}\`
- Commits only on ActVox base: ${base_only}
- Commits only on upstream: ${upstream_only}

### Risk report

$(printf '%s\n' "${risk_lines[@]}")

### Upstream commit subjects

${commit_subjects:-_No non-merge commits listed._}

### Changed files

${changed_preview:-_No changed files._}

### Required before merge

- [ ] CI green: guard, gitleaks, verify, serial-tests, slow-tests, test-status
- [ ] \`bun audit --audit-level high\` clean or intentionally waived
- [ ] Security-sensitive diffs reviewed if risk report marks HIGH/MED
- [ ] DB backup verified if migrations/schema changed
- [ ] After merge: Render deploy observed and production probes pass

### Production probes after merge

\`\`\`bash
curl -fsS https://gbrain.actvox.dev/health
curl -sS -o /dev/null -w '%{http_code}' https://gbrain.actvox.dev/mcp
curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS https://gbrain.actvox.dev/token \\
  -H 'Origin: https://evil.example' \\
  -H 'Access-Control-Request-Method: POST'
\`\`\`
EOF

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: upstream PR branch prepared locally: $PR_BRANCH"
  echo "DRY RUN: PR body: /tmp/gbrain-upstream-pr.md"
  cat /tmp/gbrain-upstream-pr.md
  exit 0
fi

if [[ "$PUSH" -eq 1 ]]; then
  git push --force-with-lease "$ORIGIN_REMOTE" "${PR_BRANCH}:${PR_BRANCH}"

  existing_pr="$(gh pr list --head "$PR_BRANCH" --base "$BASE_BRANCH" --state open --json number --jq '.[0].number // empty')"

  if [[ -n "$existing_pr" ]]; then
    gh pr edit "$existing_pr" --title "$PR_TITLE" --body-file /tmp/gbrain-upstream-pr.md
    echo "OK: updated upstream PR #${existing_pr}"
  else
    gh pr create --base "$BASE_BRANCH" --head "$PR_BRANCH" --title "$PR_TITLE" --body-file /tmp/gbrain-upstream-pr.md
  fi
fi
