# Wave 18b lane 4: shared-file manifest

Every edit lane 4 made to a file another lane or the integrator also owns. Each is a minimal append or a
one-line change; regenerate the generated files once after merging all lanes.

## Registries (append-only entries)

| File | Entry | Item |
|---|---|---|
| `src/core/error-registry.ts` | `ipc_path_too_long` (host_only) | 4.2 |
| `src/core/error-registry.ts` | `backup_too_large` (host_only, physical-copy fix) | 4.5 |
| `src/core/error-registry.ts` | `unmanaged_database_path` (host_only, physical-copy fix; the code was already thrown, now registered) | 4.5 |
| `src/core/error-registry.ts` | `pending_verify` (host_only, `exit: 13`) | 4.4 |
| `src/core/exit-codes.ts` | `HARNESS_PENDING_VERIFY_EXIT_CODE = 13` (header comment updated) | 4.4 |
| `test/exit-codes.test.ts` | two expectations: the constant is 13, `exitCodeForCode('pending_verify')` is 13 | 4.4 |
| `src/commands/doctor/registry.ts` | `ipcSocketPathEntry` after `pgliteDataDirEntry` | 4.2 |
| `src/core/doctor-categories.ts` | `ipc_socket_path` → `ops` | 4.2 |
| `test/fixtures/goldens/doctor/registry-build-checks.json` | 4 lines for the `ipc_socket_path` entry | 4.2 |
| `scripts/serial-files.tsv` | rows for `test/resolve-ipc-rebind.serial.test.ts` (4.1), `test/windows-ipc-long-path-6573.serial.test.ts` (4.2, R1) and `test/backup-preflight-6649.serial.test.ts` (4.5, R3) | 4.1, 4.2, 4.5 |
| `scripts/check-agent-contract.ts` | `READ_ONLY_SUBCOMMANDS` gains `bootstrap harness --status` (it takes no lock and writes nothing) | 4.4 |
| `scripts/check-windows-hide.ts` | `NOT_YET_MIGRATED` trimmed from 84 to 13 entries (`import.ts` and `facts/purge-verify.ts` migrated after #6787 merged), each naming its owner | 4.3 |
| `test/fixtures/guards/check-windows-hide.ts/{good,bad-stale-migration}` | fixture file moved from `src/core/tailscale.ts` to `src/core/persistence/topology-filesystem.ts` (still listed) | 4.3 |
| `test/scripts/windows-hide-guard.test.ts` | ratchet fixture repointed from `src/core/tailscale.ts` (migrated) to `src/core/persistence/topology-filesystem.ts` | 4.3 |
| `.github/workflows/persistence-validation.yml` | `test/e2e/transaction-cancel-held-lock.test.ts` added to the direct + pooled step (`Require canonical reconciliation through direct and pooled PostgreSQL`) so its PgBouncer arm runs in CI | 4.6 |
| `.github/workflows/test.yml` | Windows-only step `Long Windows PGLite IPC paths use the per-user run dir (#6573)` running `test/windows-ipc-long-path-6573.serial.test.ts`, after the #4992 hidden-console step | 4.2 |
| `test/fixtures/goldens/exports/types.json` | the registry code union gains the four codes (`regen:all --goldens`; justify in the PR body as new registered codes) | 4.2, 4.4, 4.5 |

## Generated docs (committed regenerated; regenerate once after merge)

- `docs/guides/error-codes.md` (`bun run build:error-codes`): the four codes above.
- `bun run build:agent-protocol` + `regen:all` copies of the exit-13 row: `skills/conventions/agent-operator-protocol.md`,
  `plugin/skills/conventions/agent-operator-protocol.md`, `plugin-variants/gbrain-{coding,daily}/skills/conventions/agent-operator-protocol.md`,
  `skills/skills.lock.json`.
- Not regenerated (integrator): `llms.txt` / `llms-full.txt` (`regen:all --check` reports them stale on this branch).

## Shared docs (hand-edited)

| File | Change | Item |
|---|---|---|
| `docs/guides/troubleshooting.md` | symptom rows and sections `#ipc-path-too-long`, `#backup-too-large` | 4.2, 4.5 |
| `docs/guides/in-agent-setup.md` | §6 preflight paragraph, new `### Large or non-standard brains: quiesced physical copy`, troubleshooting row | 4.5 |
| `docs/guides/bootstrap.md` | `#pending-verify` paragraph in the PGLite note | 4.4 |
| `docs/guides/exit-codes.md` | row for exit 13 | 4.4 |
| `docs/protocol/AGENT_OPERATOR_v1.md` | row for exit 13 in the exit-code table | 4.4 |
| `docs/architecture/key-files/{engines-2,mcp,core-services-1-continued,google-and-loops,agent-bootstrap}.md` | per-file entries for the touched modules | all |
| `vendor/README.md` | the `own()` cancel-and-discard hunk in the patch inventory | 4.6 |

## Driver patch (4.6, its own commit 255e2357)

`patches/postgres@3.4.9.patch` is the source of truth; `vendor/postgres/{src,cjs/src,cf/src}/index.js` and
`vendor/postgres/types/index.d.ts` were rebuilt with `bash vendor/update-postgres.sh` and `--check` is clean.

## Not touched

No `src/core/persistence/*` or `sync*` edits; VERSION, CHANGELOG headers, BEHAVIOR_CHANGES `since:` values and
`llms*.txt` are untouched (rows are in `lane4-release-notes.md`).
