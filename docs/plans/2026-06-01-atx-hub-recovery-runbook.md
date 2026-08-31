---
title: "ATX-HUB GBrain — Company-Brain Tutorial Status & 2026-06-01 Recovery Runbook"
type: ops
status: RESOLVED
tags: [atx-hub, gbrain, infrastructure, centralization, incident, render, supabase, migrations, ops-status]
---

# ATX-HUB GBrain — Company-Brain Tutorial Status & Recovery Runbook

**Captured:** 2026-06-01 (live MCP state; OAuth client `engineer-nezovskii`, scopes read+write+admin)
**Brain:** gbrain.actvox.dev · v0.42.1.0 · engine postgres (Supabase) · `/health` 200
**Verdict (RESOLVED 2026-06-01):** Brain recovered — `search` / `query` / `think` / `put_page` all
work; sync + embed pipelines restored (538 → 818+ pages). **Root cause:** gbrain's DDL/bulk "direct
pool" targeted Supabase's IPv6-only direct host (`db.<ref>.supabase.co`), unreachable from Render →
schema stuck 73 versions behind (v38 → v111) → search/writes/sync broken and the graph layer
silently empty (link-inserts failed on the same host). **Fix:** applied migrations via the session
pooler `:5432`; set `GBRAIN_DIRECT_DATABASE_URL` = session pooler + `ZEROENTROPY_API_KEY` on
web + worker (now declared in `render.yaml`'s `gbrain-shared` group); redeployed. The sections below
are the ORIGINAL incident assessment (kept for the record); the live resolved record is the brain
page `ops/atx-hub-recovery-2026-06-01`.

> This runbook lives in the repo because the brain's write path is itself broken (see Blocker 1). Ingest it into the brain — or let me `put_page` it — once migrations are applied.

---

## TL;DR — one unifying root cause

**Migrations were never applied to the live Supabase DB.** The binary is v0.42.1.0 but the live schema is behind it, missing at least three columns. WHY migrations never ran: the migration / schema-probe connection fails with `connect ECONNREFUSED <ipv6>:5432` on every web + worker boot — `DATABASE_URL` points at Supabase's **direct/IPv6 `:5432`** endpoint instead of the transaction **pooler `:6543`** (IPv4). Normal pooled reads work (538 pages serve fine via `list_pages`/`get_stats`), but the heavier migration connection hits the refused IPv6 path.

That one gap takes down search, sync, AND writes:

| # | Blocker | Verified evidence (live, 2026-06-01) |
|---|---|---|
| 1a | **Search / query / think broken.** Schema missing `pages.effective_date`. | `search("…")` → `column p.effective_date does not exist`; `think(…)` → `pagesGathered:0`. |
| 1b | **Writes broken.** Schema missing `pages.source_kind`. | `put_page(...)` → `column "source_kind" does not exist`. |
| 2 | **Every sync job dead-letters.** Schema missing `gbrain_cycle_locks.last_refreshed_at`. | Jobs 9364–9370 (one/source, cron 09:30) all `status:dead`, `column "last_refreshed_at" of relation "gbrain_cycle_locks" does not exist`. PLUS all 7 git clones `clone_state:"missing"`. |
| 3 | **Every embed job dies.** Embed model is ZeroEntropy, key unset. | Job 9363 `status:dead`, `Embedding model "zeroentropyai:zembed-1" requires ZEROENTROPY_API_KEY`. |

**Knock-on (verified):** brain 26 days stale (newest `last_sync_at` 2026-05-06); 2 empty sources (basaev-app, mandala-estate); graph effectively empty — **22 links / 2 timeline across 538 pages, 520 orphans, brain_score 46/100, link_coverage 0** — because extract/dream die on the lock-column drift before any extract phase runs.

---

## Recovery procedure (run in this order)

**1. Apply migrations against the live DB — KEYSTONE (unblocks search, writes, AND sync).**
Fastest from any machine that reaches the DB on IPv4. Use the Supabase **transaction pooler** string (Supabase dashboard → Project Settings → Database → Connection string → *Transaction pooler*, port 6543):
```bash
DATABASE_URL='postgresql://postgres.<PROJECT_REF>:<PW>@aws-0-<REGION>.pooler.supabase.com:6543/postgres' \
  gbrain apply-migrations --yes
DATABASE_URL='…pooler…:6543/postgres' gbrain doctor --json   # expect no missing-column warnings
```
Do NOT set `GBRAIN_PREPARE=true` (gbrain auto-disables prepared statements on :6543).

**2. Repoint Render `DATABASE_URL` to the pooler :6543** (gbrain-shared env group) — replace the direct `:5432` URL. Durable reachability so the worker stops flaking every boot.

**3. Set `ZEROENTROPY_API_KEY`** on the gbrain-shared env group (embed model is `zeroentropyai:zembed-1`).

**4. Restore the 7 git clones** (all `clone_state:"missing"`). Verify `GIT_PAT` is a fine-grained PAT with **contents:read** on all 7 ActVox repos, redeploy the worker so its startup clone loop re-populates `/var/gbrain/repos/`, confirm with `ls -la /var/gbrain/repos/*/.git`.

**5. Restart web + worker**; let the 30-min cron resubmit sync/embed (or submit manually).

**6. Verify:** `search` returns rows; `think("what is our infra strategy")` returns `pagesGathered > 0` with citations; `sources_status` → `clone_state:"healthy"`; `get_stats` → fresh `last_sync_at` + growing `link_count`.

---

## 14-part company-brain tutorial status

**Score:** done 2 · partial 7 · missing 5.

| # | Part | Status | Note |
|---|------|--------|------|
| 1 | Mental model (multi-source, per-user OAuth, per-person folders/crons/skills) | partial | Multi-source + OAuth real; ZERO per-person folders/crons/skills. Ours is per-PROJECT, not the tutorial's per-PERSON frame — decide explicitly. |
| 2 | Multi-user Postgres/Supabase backend | done | Live. Harden: DATABASE_URL → pooler. |
| 3 | Carve into sources + per-person subfolders + sync --all | partial | 8 sources per-PROJECT, all `federated:true`, no `partners/<slug>/`. Neither tutorial model cleanly. |
| 4 | HTTP MCP + OAuth (`--bind 0.0.0.0`, `--public-url`) | done | Verified live; fixed today. Commit render.yaml + re-enable Blueprint auto-sync; set CORS if needed. |
| 5 | One OAuth client per teammate (`--source`+`--federated-read`); verify isolation | partial | All federated; my client is admin → isolation NEVER leak-checked. Register a single-source test client and confirm it can't read others. |
| 6 | Per-person crons | missing | Only 2 global crons. Gated on Part 1. |
| 7 | Per-person skills (`allowed_clients`) + shared `_*-rules.md` | missing | No client-scoped skills. Repo-side, gated on Part 1. |
| 8 | Wire Slack | missing | No Slack integration. Greenfield. |
| 9 | Botmaster onboarding | missing | No per-teammate slices/onboarding. |
| 10 | Teammates connect AI client (thin-client) | partial | Mechanism works (this session); only the admin client proven. |
| 11 | First real query (`gbrain think`) | missing | BLOCKED — `pagesGathered:0` (search broken). The headline payoff. |
| 12 | Operating (autopilot, doctor --remediate, sources status, /admin) | partial | Surfaces work; health 46/100; remediate not run. |
| 13 | Cost/speed (ZeroEntropy, ~122ms) | partial | Model IS ZeroEntropy but key unset → embeds die; latency unmeasurable while search down. |
| 14 | Common gotchas | partial | Live now: stale answers, no leak check, DB on direct :5432 not pooler. /token 401 fixed. |

---

## 2026-06-01 deploy-fix runbook (already fixed today)

**Incident:** `gbrain-web` had NEVER deployed (every attempt `update_failed`). Root cause: startCommand omitted `--bind 0.0.0.0`; gbrain v0.34.1+ defaults `serve --http` to `127.0.0.1`, so Render's port scan found nothing on the public interface → timeout.

**Fix (live, via Render REST API PATCH — CLI `services update` silently no-op'd the field):** added `--bind 0.0.0.0` + `GBRAIN_HTTP_TRUST_PROXY=1` to gbrain-web. Result: all 4 services LIVE; `/health` 200. render.yaml committed at `75f78431`.

**Open follow-ups from the deploy fix:** Blueprint auto-sync is OFF (working config lives only as a live Render PATCH); DATABASE_URL still on direct :5432 (the root cause above); CORS unset. The three data-plane blockers PREDATE and are separate from the deploy fix.

---

## Notes for the record

- **Prior incident:** `infra/incidents/2026-05-17-team-brain-stall` ("Stale gbrain-sync Lock + Multi-Source SQL Bug") — same stall class.
- **Embeddings:** running config is ZeroEntropy (`zeroentropyai:zembed-1`), aligned with tutorial Part 13; blocker is the missing key, not a wrong provider. The 4844 existing vectors are stale OpenAI from the 2026-05-06 import → full re-embed needed once the key is set (different dims/space).
- **Carving is intentional:** per-PROJECT sources (not per-access-tier) is the design doc's deliberate choice for one cross-project graph. Valid — just not either tutorial model, so leak-free per-person isolation is a future state.
