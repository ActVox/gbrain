# ActVox fork release notes

Fork-only entries that previously lived at the top of CHANGELOG.md. Upstream owns CHANGELOG.md; this file is ActVox-owned so upstream integrations never conflict with it.


## [0.60.27.0] - 2026-10-02

**ActVox integration of upstream garrytan/gbrain v0.60.27.0** (`ad7900d8dcd221e22b885fef0f4030b73a1d69c9`).

### Operator notes
- Schema migrations v179-v186 apply on first start: v179 builds two request indexes (`CONCURRENTLY` on Postgres), v180/v182 add columns, v183 touches persistence-brain state, v184-v186 add empty tables. They are roll-forward only; take a verified database backup before deploying.
- Upstream advises upgrading the service that runs the persistence consumer before connector hosts.
- Upstream now requires Bun >= 1.4.0 (`engines`); the fork's Bun 1.3.x CI legs were retired. Render already builds with Bun 1.4.2.

### Preserved ActVox patches
- Render topology and ops docs, operational-memory ranking policy and its call sites, federated/team `extract` fixes (`runExtractDbCore`), the asynchronous worker-diagnostics watchdog, the ActVox dashboard brand and theme, the fork's `ubuntu-24.04` runner policy, and the dependency security pins (`marked`, `@hono/node-server`, `fast-xml-parser`).

### Dropped because upstream now covers them
- Fork `scripts/native/setup-toolchain.ts` mirrored downloader (upstream ships the same Zig community-mirror, size-bounded, sha256-verified download) and its unit test.
- Fork double-FATAL guard in `test/postgres-engine-singleton-lifecycle.test.ts` (upstream's `!socket.writableEnded` guard covers the same race; 15/15 repeat runs pass).

## [0.60.17.0] - 2026-10-01

**The Team brain dashboard gains ActVox branding, light and dark themes, and clearer request monitoring on desktop and mobile.**

### Added
- ActVox logos, browser favicon, and touch icon identify the Team brain. The theme initially matches your system preference, then remembers the stored theme and any choice you make.
- Filter incoming requests by result, search by agent or operation, and inspect a request without leaving the dashboard. Mobile navigation keeps every admin page accessible.

### Fixed
- The live activity stream retries transient interruptions. Refresh restarts a disconnected stream; leaving the dashboard closes its connection.
- Unavailable statistics show an explicit error instead of healthy-looking zeroes. Failed refreshes retain the last successful snapshot with a stale-data notice.
- Metric labels distinguish registered clients from live connections and describe rolling 24-hour request counts and token expiry.

### To take advantage of v0.60.17.0
Deploy this ActVox fork release and reload `/admin/`. The UI adds no database migration or permission changes. Cabinet Grotesk and Switzer load through Fontshare's hosted CSS; system fonts remain available when that service is unreachable.

## [0.60.16.0] - 2026-09-30

**Team brains gain the current upstream memory and permission safeguards while keeping source-specific extraction and operational search policies.**

This release integrates upstream 0.60.15.0 into the production fork. Agents can use the newer retrieval and context tools, and the shared server retains the team's deployment layout, database-backed extraction jobs, and canonical operational pages. Canonical-page suggestions now pass through the same visibility and source checks as other search results. Image results also remain available when the text embedding provider is unavailable.

The upgrade crosses database and job-authority changes. Back up the database and managed files, verify a restore, and stop all old servers, workers and job producers before migration. Keep them stopped until every writer uses the new version. Rolling the executable back alone is not a database rollback.

| Area | Behavior |
| --- | --- |
| Operational recall | Canonical pages obey source grants and current page-read rules |
| Database extraction | Team jobs retain source scope and precise extraction watermarks |
| Builds | Local and hosted executable builds use pinned Bun 1.4.2 |

## To take advantage of v0.60.16.0

1. Read the intervening migration instructions, especially `skills/migrations/v0.49.0.0.md`, `v0.50.0.0.md`, `v0.51.0.0.md` and `v0.60.5.0.md`.
2. With the verified backup and old writers stopped, run the new executable's `gbrain apply-migrations --force-schema --yes`. Inspect legacy job authority and managed-writer state before resuming automation; do not bulk-grant or replay historical jobs.
3. Verify `gbrain stats`, representative source-scoped retrieval, a durable write/read, and worker health after restarting the coordinated release.

### Itemized changes

- Preserve the fork's HTTP origin checks, extraction adapter, lock handling, schema-pack lookup and production topology while integrating upstream.
- Route policy-selected search candidates through the current visibility and source-grant checks.
- Retain successful multimodal vectors when text embeddings fail.
- Make the local CI inventory agree with the no-key E2E lane and keep the shell guard compatible with macOS Bash.
- Keep watchdog termination independent of a blocked main thread or stderr pipe, with bounded diagnostic writes.
- Build the Linux test executable in an isolated container volume so a Mac build cannot contaminate the release gate.

