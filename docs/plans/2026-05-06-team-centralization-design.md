# GBrain Centralized Team Setup — 8 engineers × 6 GStack projects

**Date:** 2026-05-06
**Author:** CTO (Konstantin Nezovskii)
**Status:** Design approved, implementation deferred

## Context

Centralize 6 GStack-driven coding projects currently running with isolated local GBrains so 8 engineers can all read everything across every project. Personal/scratch brains stay local. The goal is one canonical knowledge layer that compounds across projects (typed-link knowledge graph spans all 6 repos), keeps in sync with `git push` automatically, and that every engineer's local GStack agent (`/investigate`, `/review`, `/plan-eng-review`, `/office-hours`) queries via OAuth-authenticated MCP. Cost is not a constraint; correctness, freshness, and the cross-project knowledge graph are.

---

## Architecture (1 brain, 6 sources, hybrid local+central)

```
┌────────────────────────────── CENTRAL ──────────────────────────────┐
│                                                                     │
│   Render Standard (long-running container)                          │
│   ├─ gbrain serve --http --port 3131                                │
│   │  (OAuth 2.1, /mcp, /admin dashboard, /webhooks/github)          │
│   ├─ gbrain jobs supervisor --concurrency 4                         │
│   │  (worker daemon: sync, dream cycle, extract, embed)             │
│   └─ /var/gbrain/repos/{project1..project6}                         │
│      (6 git clones with deploy keys, source of truth)               │
│                                                                     │
│   Supabase Pro Postgres + pgvector                                  │
│   └─ ONE database, ONE pages table, source_id discriminator         │
│      6 source rows in `sources`: project1, project2, ..., project6  │
│                                                                     │
│   Cloudflare R2 (S3-compatible)                                     │
│   └─ Binary file mirror via `gbrain files`                          │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTPS + OAuth bearer (per-engineer client_credentials)
                              │
┌────────────────────────── PER-ENGINEER ─────────────────────────────┐
│                                                                     │
│   ~/work/project-acme/   (.gbrain-source = "acme")                  │
│   ~/work/project-brain/  (.gbrain-source = "brain")                 │
│   ...                                                               │
│                                                                     │
│   Local GStack agent (Claude Code / OpenClaw / Hermes)              │
│   └─ ~/.claude/server.json points at central /mcp                   │
│      (every `gbrain query`, every code-def lookup hits central)     │
│                                                                     │
│   Local personal PGLite brain (optional, for scratch/private)       │
│   └─ ~/.gbrain/brain.pglite                                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Compute | **Render Standard** ($19/mo, 2GB RAM, persistent disk) | Long-running container, what gbrain README explicitly tests |
| Database | **Supabase Pro** ($25/mo, pgvector, PITR backups) | What gbrain CI E2E runs against, IPv4 + connection pooler |
| File storage | **Cloudflare R2** (S3-compatible, free egress) | Plugs into `gbrain files` |
| DNS / TLS | **Cloudflare** (proxied) | Free, gives you the public URL for `--public-url` |
| Worker | Same Render service via `gbrain jobs supervisor` | One container = one bill, supervisor restarts on crash |

**Total: ~$45/mo for the whole stack.**

Why not Convex or Vercel: GBrain is Postgres + pgvector with hybrid SQL search (RRF fusion, recursive CTEs for graph traversal, source-aware ranking baked into SQL CASE expressions in [src/core/search/sql-ranking.ts](../../src/core/search/sql-ranking.ts)). Convex's reactive-function model can't host this. Vercel Functions cap at 60–300s and have no persistent worker daemon, killing the dream cycle and long ingestions.

---

## Why one brain + six sources (not six brains)

GBrain's edge over plain RAG comes from typed-link knowledge graph extraction (`works_at`, `attended`, `invested_in`, `founded`, `advises`) wired automatically on every page write. **Six separate brains throws that away** — Alice the contractor in project-A and project-B becomes two unrelated entities, and cross-project queries ("which projects use library X?") don't work.

Multi-source has been mature since v0.18:
- `pages.source_id` discriminator on every row
- Source-aware ranking at the SQL layer (v0.22.0) — boost curated `originals/` over `openclaw/chat/` extends naturally to "boost project-X's docs when query intent matches project-X"
- Per-source `sources.last_commit` anchor (v0.22.5, PR #475) so each project's git sync has its own bookmark
- v0.22.13 hardened the writer lock + head-drift gate for concurrent multi-source syncs

`gbrain mounts` (the alternative) was designed for **publishing curated brains for external consumers**, not for an internal team of 8.

---

## Per-engineer routing (Q3 = both)

Each project repo ships a `.gbrain-source` dotfile committed at the root:

```bash
# ~/work/project-acme/.gbrain-source
acme
```

Auto-detected from cwd. `GBRAIN_SOURCE=other` env var overrides per shell session. This is the existing v0.18 6-tier resolution chain — nothing custom needed.

Each engineer's local GStack agent gets one OAuth `client_credentials` token registered via `gbrain auth register-client`:

```bash
# On the central server (one-time, per engineer)
gbrain auth register-client engineer-alice \
  --grant-types client_credentials \
  --scopes "read write"

# On the engineer's laptop, ~/.claude/server.json
{
  "mcpServers": {
    "gbrain": {
      "type": "http",
      "url": "https://brain.yourcompany.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

`scope: write` lets them put_page (write meeting notes, decisions); `scope: admin` is reserved for the CTO. `sync_brain` and `file_upload` are `localOnly` — rejected over HTTP so engineers can't accidentally mutate the central server's filesystem.

---

## Sync model (Q4 = webhook + polling fallback)

**Primary path — GitHub webhook → instant sync:**

1. Each of 6 repos points a webhook at `https://brain.yourcompany.com/webhooks/github`
2. Webhook fires on `push` events to default branch
3. Central server validates HMAC signature, looks up repo → source_id, submits a `sync` minion job: `{ name: 'sync', params: { source: 'acme', repo: '/var/gbrain/repos/project-acme' } }`
4. Worker runs `git pull && gbrain sync --source acme --repo /var/gbrain/repos/project-acme`
5. Idempotency key per commit SHA prevents double-sync on webhook redelivery

**Fallback path — polling cron every 30 min:**

`gbrain jobs submit autopilot-cycle` runs every 30 min via `cron-scheduler`, walks all 6 sources, runs `git fetch + sync` for any with new commits. Catches webhook delivery failures (GitHub auto-disables hooks after 5 consecutive failures — this is the real-world recovery mechanism).

**Why both:** webhook gives you ~5-second freshness, polling guarantees recovery within 30 min if a webhook silently fails. This is the production-correct shape.

---

## GStack ↔ GBrain wiring

GStack's coding skills (`/investigate`, `/review`, `/plan-eng-review`, `/office-hours`, `/qa`) already know to check the brain first when `hosts/gbrain.ts` is present. The README's Cathedral II five magical commands all hit the configured MCP server:

```bash
gbrain code-callers searchKeyword         # who calls this symbol (across all 6 projects)?
gbrain code-callees searchKeyword         # what does this symbol call?
gbrain code-def BrainEngine               # where is X defined?
gbrain code-refs BrainEngine              # all reference sites
gbrain query "how does N+1 handling work" --near-symbol BrainEngine.searchKeyword --walk-depth 2
```

Each engineer indexes each project they work on as a code-strategy source on the central brain:

```bash
# One-time, run from central server (or by an engineer with admin scope)
gbrain sources add project-acme --strategy code --repo /var/gbrain/repos/project-acme
gbrain sources add project-brain --strategy code --repo /var/gbrain/repos/project-brain
# ...for all 6
```

After that every `code-def` / `code-refs` query an engineer runs from any laptop walks the call graph across all 6 projects. Cross-project refactoring becomes observable.

---

## Personal brain (the hybrid part)

Each engineer keeps their own local PGLite brain at `~/.gbrain/brain.pglite` for:
- Personal notes / drafts / scratch
- Daily journaling (`signal-detector` captures into the personal brain by default)
- Anything they don't want on the team server

GBrain's mount system handles "central + local" cleanly via brain routing (the `--brain` flag, `GBRAIN_BRAIN_ID` env, `.gbrain-mount` dotfile). The 6-tier resolver picks central when an engineer is in a project repo (`.gbrain-mount = team`) and personal otherwise (default = `host`).

Set up once per engineer:

```bash
# On engineer's laptop, one-time
gbrain mounts add team \
  --url https://brain.yourcompany.com/mcp \
  --token "$GBRAIN_TEAM_TOKEN" \
  --readwrite

# In each project repo
echo "team" > .gbrain-mount
git add .gbrain-mount && git commit -m "route to team brain"
```

---

## Critical files / docs to reference

- [docs/architecture/brains-and-sources.md](../architecture/brains-and-sources.md) — topology diagrams (mounts vs sources)
- [skills/conventions/brain-routing.md](../../skills/conventions/brain-routing.md) — 6-tier resolution decision table
- [docs/mcp/](../mcp/) — per-client OAuth setup guides
- [SECURITY.md](../../SECURITY.md) — hardening defaults for `gbrain serve --http`
- [src/commands/serve-http.ts](../../src/commands/serve-http.ts) — OAuth provider + admin dashboard
- [src/core/oauth-provider.ts](../../src/core/oauth-provider.ts) — `client_credentials` flow used by agent connections
- [src/commands/sync.ts](../../src/commands/sync.ts) — `performSync()` entrypoint (consumed by webhook + polling)
- [src/core/cycle.ts](../../src/core/cycle.ts) — `runCycle()` for the dream maintenance loop

---

## Implementation phases

### Phase 0 — Provision (1 day)

1. Render Standard service from gbrain repo (Dockerfile + start script)
2. Supabase Pro project, copy `DATABASE_URL` into Render env
3. Cloudflare R2 bucket + access key, set `GBRAIN_STORAGE_*` env
4. Cloudflare DNS: `brain.yourcompany.com` → Render service
5. Render persistent disk mounted at `/var/gbrain` (10GB to start)

### Phase 1 — Bootstrap central brain (~30 min)

1. SSH to Render shell or run via Render Job: `gbrain init --postgres "$DATABASE_URL"`
2. `gbrain apply-migrations --yes` (verify schema is current)
3. `gbrain serve --http --port 3131 --public-url https://brain.yourcompany.com` started by the container's start command
4. Open `https://brain.yourcompany.com/admin`, paste bootstrap token, verify dashboard loads

### Phase 2 — Add 6 sources (~30 min)

1. Generate one GitHub deploy key per project, add to each repo (read-only)
2. `git clone` each project into `/var/gbrain/repos/`
3. `gbrain sources add <project> --repo /var/gbrain/repos/<project> --strategy code` × 6
4. `gbrain sync --source <project>` × 6 (initial bulk import)
5. `gbrain extract links --source db && gbrain extract timeline --source db` to wire the cross-project graph
6. `gbrain embed --stale` to fill embeddings

### Phase 3 — Webhook plumbing (~1 hour)

1. Generate webhook secret, set `GITHUB_WEBHOOK_SECRET` env on Render
2. Add `/webhooks/github` route to `serve-http.ts` that validates HMAC + submits a `sync` minion job (this is the only new code in the rollout)
3. Add webhook to all 6 GitHub repos pointing at `https://brain.yourcompany.com/webhooks/github`
4. Push a test commit to one repo, verify central brain picks it up within 5s

### Phase 4 — Per-engineer onboarding (~10 min × 8 engineers)

1. CTO runs `gbrain auth register-client engineer-<name> --grant-types client_credentials --scopes "read write"` for each engineer
2. Hand each engineer their token + setup snippet for `~/.claude/server.json`
3. Engineers add `.gbrain-source` to each project repo they actively work on (commit it)
4. Optional: `gbrain mounts add team --url ... --token ...` for the hybrid personal+team flow

### Phase 5 — Autopilot loop (~10 min)

1. Schedule 30-min polling fallback: `gbrain jobs submit autopilot-cycle` via cron-scheduler at `*/30 * * * *`
2. Schedule nightly dream cycle: `gbrain dream` at 2am local for synthesize + patterns + maintenance
3. Wire `gbrain doctor --json` into a daily Slack/email so degradation surfaces

---

## Verification

End-to-end smoke test after rollout:

```bash
# From any engineer's laptop, in any project repo:
gbrain query "what is our overall infra strategy" --top 5
# Expect: results spanning multiple sources, source_id visible per result

gbrain code-def runCycle
# Expect: hits across whichever projects import gbrain (or all 6 if internal symbol)

# Push a test commit to project-acme:
cd ~/work/project-acme
echo "test sync $(date)" >> wiki/test.md
git commit -am "sync test" && git push

# Wait 10s, then from a different engineer's laptop:
gbrain get test --source acme
# Expect: page exists, content matches the commit

# Verify the graph wired itself:
gbrain graph-query people/cto --type attended --depth 2
# Expect: cross-project edges visible
```

If any step fails: `gbrain doctor --json` on the central server, check `~/.gbrain/audit/*.jsonl` and Render logs.

---

## Open questions (deferred, not blocking)

- **Per-project ACL** — currently all engineers read all 6. If/when one project becomes privileged (M&A, security), use OAuth scopes + `--allowed-slug-prefixes` on the engineer's token rather than splitting into separate brains.
- **Personal brain → team brain promotion** — if an engineer drafts a doc in their personal brain and wants to publish it to team, what's the workflow? Probably `gbrain export --slug X | ssh central "gbrain put X --source <project>"`. Worth a wrapper script later.
- **Stale data retention** — when an engineer leaves, revoke their OAuth client (`gbrain auth revoke-client engineer-<name>`), but their meeting notes / decisions stay (correctly). Their personal brain stays on their laptop (correctly).
