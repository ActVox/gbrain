# Wave 18 lane 2, S1 fragments (PR 18a; scratch, the integrator applies these rows and deletes this file)

S1 items: #6729, #6741 A/B/C and #6749. **Every row in this file is S1** (each row is tagged). Non-S1 (S2) rows are in `.wave18-fragments/lane2.md`.

## #6729 inexact Git rename identity

### Registries (integrator-owned)

1. `src/commands/doctor/registry.ts`: `import { renameIdentityDowngradesEntry } from './checks/rename-identity-downgrades.ts';` and add `renameIdentityDowngradesEntry,` right after `ghostPagesEntry,` in `DOCTOR_CHECK_REGISTRY`.
2. `src/core/doctor-categories.ts` `BRAIN_CHECK_NAMES`: after `'ghost_pages',` add
   ```ts
     // #6729: inexact renames whose identity sync did not keep, until the pair gets a disposition (doctor/checks/rename-identity-downgrades.ts).
     'rename_identity_downgrades',
   ```
3. Regenerate the doctor goldens: `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/doctor-registry-golden.test.ts`, then the runtime ones (`test/doctor-content-golden.test.ts test/doctor-hot-checks-golden.test.ts test/doctor-json-golden.test.ts test/doctor-json-golden-latest.test.ts`, and the Postgres ones under `test/e2e/` with `DATABASE_URL` + `GBRAIN_TEST_ALLOW_DATABASE_URL=1`). The diff is additions only.
4. Without rows 1-2, `check:orphan-modules` fails on `src/commands/doctor/checks/rename-identity-downgrades.ts`.

The remedy repair kind is not in S1: it lands in its own commit after the S1 SHA (rows in `lane2.md`).

### BEHAVIOR_CHANGES (`src/core/behavior-change-notice.ts`, since = slot version)

- [S1] `{ since: '<slot>', text: 'An inexact Git rename (a move that also changed the file, reported as R<100) now keeps its page identity only when the files confirm it: the same frontmatter \`id\` on both sides that no other file or page carries, or, with no id on either side, a \`slug:\` line or title (the frontmatter \`title:\`, else the first \`# Heading\`, compared with the title the brain stores for the old page) that no other file in the sync and no other live page shares; a respelled path that keeps its slug keeps its page unless the ids conflict (#6729). Any other pair is imported as a delete plus an add: the new file starts a fresh page and the old page keeps its facts, links and aliases on its soft-deleted slug. The sync report prints each pair with \`gbrain restore <old-slug> --source-id <id> --force\`, \`gbrain sync status --json\` lists it under \`identity_downgrades\`, doctor \`rename_identity_downgrades\` names it, and the purge leaves the old page alone, with no time limit, until the pair gets a disposition (the old page restored, or, once the remedy ships, remedied or closed without merging). A new file whose frontmatter \`id\` uniquely matches a file deleted in the same sync range, with the same file name, title or bytes, is now its rename even when Git did not pair them; a template id reused by an unrelated new note stays a new page.' }`
- [S1] `{ since: '<slot>', text: 'A file moved and broken in the same commit (unreadable frontmatter, so Git reports an inexact rename) is no longer held with the old page identity: the old page is soft-deleted and recorded as above and the broken file is held as a new file (#6729). An exact move (R100) that is held still keeps the old page identity and \`rename_from\`. A managed sync refuses \`page_identity_changed\` (detail \`rename_identity_conflict\`) when a file would take over a page, or a held rename would carry one, whose frontmatter \`id\` differs from its own.' }`

### CHANGELOG

- [S1] Sync no longer moves one page's facts, links and aliases onto a different page when Git guesses an inexact rename between two similar files. Identity follows a shared frontmatter `id`, a unique `slug:` line or a unique title; anything else is a delete plus an add, reported with its restore command and held from the purge until the pair is settled (#6729). Contributed by @javieraldape (PR #6732, rewritten).

### KEY_FILES (`docs/architecture/key-files/files-and-sync-*.md`, `commands-*.md`)

- [S1] `src/core/sync-rename-identity.ts`: the one confirmation stage for inexact Git renames (#6729). `confirmRenameIdentities` reads committed sides through one `git cat-file --batch` stream (64 KiB heads) and the dirty tree's working side from disk, with id and `slug:` from the frontmatter and the title by parseMarkdown precedence (frontmatter, then the first H1, no filename fallback; `markdown.ts` `explicitMarkdownTitle`), the old side taking the title its page row stores; it keeps an R<100 pair on a same-slug respelling, a unique shared `id`, or with no id on either side a unique `slug:` line or title (titles also unique among live pages). `explicitIdVeto` is the one explicit-id veto the managed takeovers consult. An add whose id uniquely matches a delete in the range becomes a rename only with continuity (same file name, title or bytes; `digest` is the sha256 of a file that fits the head read), as decideImportIdentity asks of a move. Downgraded pairs record `read.from` / `read.to`. A dirty-tree verdict is bound to the bytes it read: each kept rename carries `identityHead` (sha256 of the first 64 KiB), classic `applyRename` re-checks it before the identity moves and managed `readSyncContent` refuses `source_changed` on frozen bytes that differ.
- [S1] `src/core/sync-identity-downgrades.ts`: durable records of downgraded pairs (`op_checkpoints` op `sync-identity-downgrade`, fingerprint = old page id, open until a disposition is set or the old page is restored or purged; no time window; the checkpoint sweep keeps open records), the purge-hold SQL predicate, the live list (new slug read live), the report lines and the restore argv; `identityRestoreAvailable` (the decideUnboundWrite rule) keeps the restore off the report and doctor on an unbound Postgres source with a checkout, where it would refuse `owner_unavailable`.
- [S1] `src/commands/doctor/checks/rename-identity-downgrades.ts`: doctor `rename_identity_downgrades` (warn while a record is open; fix = restore the first old page, behind ask_user).

### Tests that changed for the intended behaviour

- [S1] `test/sync.test.ts` (3) and `test/sync-git-paths.test.ts` (3 platform cases): `buildSyncManifest` rename entries now carry Git's `similarity`.
- [S1] Held-rename hold-lane tests whose fixture was an inexact move onto a broken file now use an exact move (R100) held by a stale `slug:` line; every hold-lane assertion is unchanged: `test/persistence-sync-holds.test.ts` (2), `test/repair-frontmatter.test.ts` (2), `test/hold-action-chain-6712.test.ts` (1), `test/sync-legacy-holds.test.ts` (3), `test/write-attribution-sync.test.ts` (1). The inexact-onto-broken fixture keeps a test per path asserting its new outcome.
- [S1] `test/large-pages/managed-sync-segmented-rename.test.ts`: the fixture carries a frontmatter `id`, so the edited rename whose title follows the slug is still confirmed.

## #6741 (sub-lane: parts A, B, C)

### #6741 A fragment — Codex sub-agent rollouts and the --since last watermark

Commit: fix(transcripts): Codex sub-agent rollouts no longer hold the --since last watermark (#6741)

#### BEHAVIOR_CHANGES row (src/core/behavior-change-notice.ts; rows are `{ since, text }`)

```ts
// S1
{ since: '<this release>', text: '`gbrain transcripts ingest --since last` now advances past Codex sub-agent rollouts (session_meta source {subagent: ...}, such as the guardian auto-reviewer). They have no user turn by design, so they are reported as "N sub-agent rollouts (no user turns by design)" (JSON: subagentRollouts), not as drift. An ordinary rollout with assistant turns and no user turn is still drift and still holds the watermark.' },
```

#### CHANGELOG line (integrator)

- [S1] `gbrain transcripts ingest --since last` no longer rescans every session forever when Codex guardian or other sub-agent rollouts are present: those rollouts are counted as "sub-agent rollouts (no user turns by design)" and the watermark advances. Real drift still holds it. (#6741)

#### Docs rows

- [S1] docs/architecture/key-files/commands-6.md, the `src/commands/transcripts.ts` entry: after "advanced ONLY after a clean, untruncated, non-dry scan" add: "(a Codex sub-agent rollout, `session_meta` payload.source.subagent, has no user turn by design: the adapter reports `subagentRollout`, the scan counts it in `subagentRollouts` and prints `N sub-agent rollouts (no user turns by design)`, and it keeps the scan clean; an ordinary assistant-only rollout is still `userTurnsMissing` drift)". (Not committed by the sub-lane to keep shared doc edits with the integrator; safe to commit as-is if the integrator prefers, it is not a generated doc. Run `bun run build:llms` only if llms bundles inline this file — they inline CLAUDE.md and listed docs; check scripts/llms-config.ts.)

#### Registry rows / regeneration

None. No error code, doctor check, CLI flag or migration.

#### JSON contract note

`gbrain transcripts ingest --json` gains `subagentRollouts` (number) at the top level and `subagentRollout: true` on a file outcome. Additive. If a JSON-shape golden for transcripts ingest exists in the integrator's tree, regenerate it.

### #6741 B fragment — unchanged transcript parts take no request id

Commit: fix(transcripts): an unchanged transcript part takes no write request id on a managed brain (#6741)

#### Design (binding override followed)

No hash shortcut. `src/core/persistence/put-page-screen.ts` `unchangedPutPage(ctx, params, snapshot)` reuses master's preparer-backed,
request-free no-op decision: `preparePageAdmission` builds the admission without admitting it, `screeningRequest` + `preparePageMutation`
(the page publication preparer) run on the unadmitted request, `inspectUnchanged` (noop-kernel.ts) judges it, and the preparer's own
`validate` must hold — the same path as import-mutations.ts `unchangedManagedImport`. Called from `submitTranscriptPart` in
src/core/transcripts/ingest.ts after `preserveForeignFrontmatter` has finalized the part content.

Guards kept:
- [S1] pending-request guard: any request for (source, slug) with an intent, not compacted, non-terminal or with `recovery` set (the
  `persistence_requests_slug_intent` index shape) admits.
- [S1] revert/drift safeguard: the preparer's `prepareFileTarget` still refuses a canonical file edited outside coordination (screen fails → admit),
  a missing file admits (`canonical_file_differs` waiver never covers a missing file), and the revision is re-read by the kernel.
- [S1] segmented-body fallback: a segmented (large) page is never screened; its publication decides the no-op.
- [S1] only `mutation.noop === true` skips; any projection work (safe-chunk fence, text projection behind the revision) admits.

One waiver applies: `canonical_file_differs` for an existing file the preparer already accepted as this page. Reason: the stored frontmatter
comes back from JSONB in another key order, so `serializePageToMarkdown(snapshot)` never byte-equals the published file, and a no-op
publication never rewrites it — without the waiver every bound transcript page would admit forever (verified: 3 admissions on 3 runs).

#### BEHAVIOR_CHANGES row (src/core/behavior-change-notice.ts; rows are `{ since, text }`)

```ts
// S1
{ since: '<this release>', text: 'On a writer-claimed brain, `gbrain transcripts ingest` no longer submits a write request for a session part whose page would not change: an unchanged re-ingest takes no permanent request id. A part with pending projection work, a pending request, a missing or edited canonical file, or a large (segmented) page is still submitted.' },
```

#### CHANGELOG line

- [S1] Managed brains: re-ingesting unchanged transcripts no longer burns a permanent write-request id per session part (an unchanged part is screened by the publication preparer and the no-op kernel before admission). (#6741)

#### Docs rows

- [S1] docs/architecture/key-files/core-persistence-continued.md, the `noop-kernel.ts` entry: "Used by connector sync, `import-mutations.ts`,
  `sync-run.ts` ..." → add "and `put-page-screen.ts` (the managed transcript import's `put_page`, waiving `canonical_file_differs` for a file the
  preparer accepted)". Add an entry: "`src/core/persistence/put-page-screen.ts` — #6741 B: `unchangedPutPage` screens a trusted local put_page
  (the transcript import) through `preparePageAdmission` (unadmitted), the page publication preparer and the no-op kernel; skips admission only on a
  genuine no-op with no pending request, no segmented body and no projection work. Tests: `test/transcripts-managed-noop.test.ts`."
- [S1] docs/architecture/key-files/commands-6.md, `src/commands/transcripts.ts` entry: after "submitted as a `put_page` write request naming the
  page's current revision" add "(a part whose publication would change nothing is screened request-free first and takes no admission)".

#### Registry rows / regeneration

None.

#### Not covered by a test

The segmented-page fallback (no fixture builds a segmented transcript page cheaply). It is one early return.

### #6741 C fragment — managed purge parks tombstones it cannot purge; background admissions refuse a worktree in recovery

Commit: fix(persistence): the managed purge parks tombstones it cannot purge and skips sources in recovery (#6741)

#### Design (binding followed)

- [S1] `purgeDeletedPagesCoordinated(engine, hours, { retryParked })` (src/core/persistence/purge-deleted.ts) reads writer state once per run
  through `writerOnboardingPreflight(engine).sources`. A source whose writer state is `recovery_required` (worktree not active or physical
  root unverified) is not submitted at all: each of its expired tombstones goes into `blocked` with `code: 'writer_not_active'` and
  `binding_state`, counted in the new `inactive` field (not in `failed`, so it does not raise `managed_purge_failed`).
- [S1] Parks live in `op_checkpoints` (op `purge-deleted-park`, src/core/persistence/purge-parks.ts), fingerprint
  `[source_id, slug, deleted_at in µs]`, so a re-deleted page starts fresh. Only non-deferral failures count (revision_conflict,
  page_not_found and page_identity_changed stay deferrals). At `PURGE_PARK_LIMIT = 5` the tombstone is skipped with
  `code: 'purge_parked'` and counted in `parked`. A success clears its park. Parks of a source seen inactive rearm (are deleted) the first
  run its writer is active again (`notePurgeSourceWriter`). `purgeStaleCheckpoints` exempts the op; `prunePurgeParks` drops parks whose
  tombstone is gone.
- [S1] Every attempt still mints a fresh `randomUUID()` request id; a parked tombstone mints none.
- [S1] Retry path: `gbrain pages purge-deleted --retry-parked` (strict-args flag, PurgeArgs.retryParked). It reuses `purgeConsentRequest`
  (new trailing `retryParked` arg adds `--retry-parked` to argv and preview_argv) and the existing `--dry-run` preview, which now lists
  `parked` and `retry_parked`. No new hard-purge path.
- [S1] Doctor `purge_parked_pages` (src/commands/doctor/checks/purge-parks.ts, NOT registered — integrator row below) names each parked page
  with its last error; warn fix argv `gbrain pages purge-deleted --retry-parked --yes`, preview_argv
  `gbrain pages purge-deleted --retry-parked --dry-run --json`, consent destructive, ask_user, verify `doctorVerify('purge_parked_pages')`.
- [S1] Admission: `assertWorktreeAdmission` (journal.ts) now reads the worktree `state` under its existing FOR SHARE lock and throws
  `backgroundWorktreeInactive` (admission-origin.ts, `recovery_required`, read-only fix `gbrain sources writer status --source <id> --json`)
  for a background-origin admission when the worktree is `recovering`, before any receipt. **Scoped to `recovering`, not every non-active
  state:** a `draining` (paused) owner is a documented admit-and-replay state — refusing it broke 6 existing tests in
  test/persistence-connectors.test.ts (paused connector owner returns one stable receipt, restarted paused owner, resident replay…). Those
  tests were not touched; the scope was narrowed instead.
- [S1] `deleteStaleTranscriptPart` (transcripts/ingest.ts) now submits with `admissionOrigin: 'background'`, so the stale-part reconciliation
  is refused pre-receipt against a worktree in recovery and the session errors, instead of each run taking a new request id.

#### Intentional assertion update (report to integrator)

test/pages-purge-deleted-args.test.ts: the existing `parsePurgeArgs` `toEqual` expectations gained `retryParked: false` (the parsed shape
grew a field; nothing was weakened), plus one new `--retry-parked` case.

#### BEHAVIOR_CHANGES row

Superseded by the two #6741 C v3 rows below (the background refusal is `owner_unavailable`, not `recovery_required`).

#### Doctor registration (integrator-owned; not in the commit)

1. Register `purgeParkedPagesEntry` (src/commands/doctor/checks/purge-parks.ts) in src/commands/doctor/registry.ts `DOCTOR_CHECK_REGISTRY`, right after `renameIdentityDowngradesEntry`.
2. src/core/doctor-categories.ts: add `purge_parked_pages` to the same category as `parked_effects`.
3. Regenerate any doctor/contract goldens that enumerate check names.

#### CLI flag registry regeneration

`bun run build:flag-registry` (scripts/generate-flag-registry.ts) to pick up `--retry-parked` in src/core/cli-flag-registry.generated.ts.

#### Docs rows

- [S1] KEY_FILES (persistence key-files page next to purge-deleted.ts): add "`src/core/persistence/purge-parks.ts` — #6741 C: per-tombstone
  purge parks in op_checkpoints (op `purge-deleted-park`, key source+slug+deleted_at); park at 5 non-deferral failures, rearm when the
  source's writer is active again. Tests: `test/purge-deleted-parks.test.ts`."
- [S1] purge-deleted.ts entry: append "skips sources whose writer is recovery_required (`writer_not_active`), parks repeat failures, `--retry-parked`".
- [S1] admission-origin.ts entry: append "background admissions to a `recovering` worktree refuse `recovery_required` pre-receipt (`backgroundWorktreeInactive`); draining still admits".
- [S1] Doctor checks key-files page: "`src/commands/doctor/checks/purge-parks.ts` — `purge_parked_pages`: names parked purges; fix `gbrain pages purge-deleted --retry-parked --yes` (preview `--dry-run --json`)."
- [S1] commands page, `src/commands/pages.ts`: "`purge-deleted --retry-parked` retries parked tombstones once; the dry run lists `parked`."
- [S1] docs/guides/troubleshooting.md symptom row (optional): "doctor `purge_parked_pages` warn → fix the named cause, preview with `--retry-parked --dry-run --json`, ask the user, run the fix."

#### CHANGELOG line

Superseded by the #6741 C v3 line below.

#### Test evidence

- [S1] test/purge-deleted-parks.test.ts (7 tests). Fail-before on master cadaf5cd7: as committed the file cannot load (the doctor module does not
  exist); with only that import stubbed all 7 fail (master submits for a recovering source, never parks, admits background writes to a
  recovering worktree). ~/.capy/work/lane2-sub/6741C-fail-before.txt
- [S1] Pass-after: ~/.capy/work/lane2-sub/6741C-pass-after.txt (11 files incl. persistence-connectors, op-checkpoint, background-pause).

#### Not done

- [S1] Doctor registration, category row, flag-registry regeneration (integrator-owned, above).
- [S1] The `draining` worktree state is deliberately not refused (see Design).

### #6741 C v3 follow-up (S1)

Every row below is **S1**. This fragment supersedes the #6741 C rows in 6741C-fragment.md where they disagree (the background refusal code is now `owner_unavailable`, not `recovery_required`).

#### Commits

| Item | SHA | Subject |
|---|---|---|
| 1 refusal code | 3e7d81472 | fix(persistence): a background admission to a worktree in recovery refuses owner_unavailable with the owner-status fix (#6741) |
| 2 interactive paths | e9454e3f1 | test(persistence): interactive paths still admit against a worktree in recovery (#6741) |
| 3, 4, 5 (+ tests for 6, 7) | ed312048e | fix(persistence): one purge eligibility selector for the preview, the consent and the run; the purge phase warns on a writer in recovery or a parked page (#6741) |
| final review 5: owner verification | 3c26bbd6d | fix(persistence): background producers run the claim's owner verification once per source per run and skip a source that fails it (#6741) |
| final review 7: GC | 85bb1d3a8 | test(persistence): a purge park survives the op_checkpoints GC at 8 days (#6741) |

#### BEHAVIOR_CHANGES rows (src/core/behavior-change-notice.ts; `{ since, text }`) — S1

```ts
// S1
{ since: '<this release>', text: 'On a writer-claimed brain, background writes are refused before any receipt, so they spend no write-request id, when their source cannot publish: the worktree is in recovery, or the claim\'s owner verification fails on the owner host (a missing canonical or coordination path, or a physical root whose owner marker .gbrain-owner.json or reservation is gone or changed; a device-only change is still re-stamped by the write). The refusal is owner_unavailable with the fix `gbrain sources writer status --source <id> --json`, checked once per source per run. Background writes are every write not made from an interactive surface: the autopilot cycle and its maintenance phases (extraction, synthesis, patterns, consolidation, fence and content repair, lint fixes), Minion jobs (sync, extract and the other job handlers), connector syncs, delegated serve syncs started as background, the keep-DB reconcile, autopilot and job managed syncs, and the transcript stale-part delete. Interactive CLI, MCP and repair writes are unaffected; a paused (draining) owner still accepts and replays.' },
// S1
{ since: '<this release>', text: 'The managed purge (autopilot purge phase, the purge job and `gbrain pages purge-deleted`) submits nothing for a source whose writer needs recovery (reported `writer_not_active` with its state and reason) and parks a page after five failed purges (doctor `purge_parked_pages`: actor agent on the CLI, host_admin remotely). The cycle purge phase reports warn, not fail, for either. `gbrain pages purge-deleted --retry-parked` retries parked pages once; it obeys `--older-than` (a parked page younger than the cutoff is not retried) and the rename-recovery hold, and its preview, its consent text (which names the parked count) and its run come from one selector.' },
```

#### CHANGELOG line — S1

- [S1] Managed brains: background writes no longer spend permanent request ids on a source that cannot publish (a worktree in recovery, or a failed owner check such as a deleted .gbrain-owner.json); they are refused owner_unavailable before any receipt. The purge skips such sources and parks pages that keep failing, the cycle warns instead of failing, and `gbrain pages purge-deleted --retry-parked` retries parked pages within the cutoff and rename holds. (#6741)

#### Docs rows — S1

- [S1] KEY_FILES (persistence page): "`src/core/persistence/owner-verification.ts` — #6741 C: the claim's owner verification (`verifyOwnerRoot`: paths recorded, physical root, marker and reservation intact; a device-only change is `restampable`), shared by writer onboarding and background admissions; `assertBackgroundOwner` refuses a background admission `owner_unavailable` once per source per run (cache: admission-origin.ts `backgroundOwnerCheck`). Tests: `test/background-owner-verification.test.ts`."
- [S1] KEY_FILES `admission-origin.ts` entry: the scope carries the per-run owner cache; `backgroundWorktreeInactive` and `backgroundOwnerUnverified` refuse `owner_unavailable` with the owner-status fix.
- [S1] KEY_FILES `purge-deleted.ts` entry: "`selectPurgeCandidates` is the one eligibility selector (preview, consent, `purge_deleted_pages` op, run); `purgePhaseStatus`/`purgePhaseNote` shape the cycle purge phase (warn on `writer_not_active` or parked)."
- [S1] Commands page, `pages.ts`: "`purge-deleted --retry-parked` honours `--older-than` and rename holds; the dry run lists `parked` (with `retried`) and `blocked`; the consent names the parked count."
- [S1] Troubleshooting symptom row: "background work refused `owner_unavailable` 'its canonical owner could not be verified' → run the fix (`gbrain sources writer status --source <id> --json`); a deleted owner marker is repaired by a writer self-transfer (the user's decision)."

#### Registry rows / regeneration — S1

- [S1] No new error code (`owner_unavailable` is reused). No new CLI flag beyond `--retry-parked` (already in strict-args; run `bun run build:flag-registry` if not yet done).
- [S1] Doctor `purge_parked_pages` registration as in 6741C-fragment.md (already pushed through `checks[]` by d753f43ef).

#### Decisions and notes — S1

- [S1] Final review item 5: chose the owner verification, not per-target parking after N recovery_required receipts. A device-only change (#5604) is exempt for background admissions because the publication's locked acquisition re-stamps it; refusing it broke the two re-stamp tests in `test/persistence-physical-root-device.test.ts`. Writer onboarding still reports a device-only change as `recovery_required` (unchanged), so the purge keeps skipping that source until a locked write re-stamps it.
- [S1] The cache is per run: inside one `withAdmissionOrigin('background')` scope, a source verified before its marker disappears keeps admitting, and that admission then fails at publication (`recovery_required` receipt); the next run refuses. Admissions outside any scope (Minion job handlers and other default-background callers) verify per admission: one indexed binding read plus the marker and reservation reads.
- [S1] Item 2: writer transfer and `repair stuck-recovery` do not pass through page admission, so the refusal cannot touch them; the tests pin that they still work. An interactive `gbrain sync` against a worktree in recovery was already refused by the sync's own owner check (`owner_unavailable` "Sync must run on the active registered worktree owner.") before this work; the test pins that it meets only that check and admits again once the worktree is active.
- [S1] Items 4 and 6 and the GC exemption already held on the pushed base; their tests pin them (the GC test is proven by a forced probe that removes the exemption).
- [S1] Pre-existing and not touched: `test/persistence-managed-sync.test.ts` "repeated slices reuse one manifest and hold an intervening page identity change instead of rejecting the run" also fails on the pushed base 9862e71d3.

## #6749 repair slug-conflicts: style-only NESTED_QUOTES (S1, moved from S2 by the Captain)

### [S1] BEHAVIOR_CHANGES row (src/core/behavior-change-notice.ts)

Suggested row (fill `since` with the wave version):

- id: `slug_conflicts_style_only_nested_quotes`
- text: "`gbrain repair content` / `repair slug-conflicts` now clears a frontmatter_slug_conflict hold deterministically (remove_slug) when the only other change autoFixFrontmatter would make is a style-only NESTED_QUOTES re-quote of a valid JSON-style tag or alias array. Only the slug: line is removed; the array is left as written and listed as style_only in the preview, the run result and the content_repair receipt. Such holds used to stay still_invalid and needed `repair frontmatter --include-ambiguous`. When the lane still cannot clear a hold because the frontmatter needs other fixes, the still_invalid message now names those fix codes (for example NULL_BYTES)."

### [S1] Receipt shape note

`ContentRepairReceipt` (src/core/content-repair/receipt.ts) gained an optional `style_only: string[]` (remove_slug only, 1-8 upper-case fix codes); `parseContentRepairReceipt` validates it and omits it when absent, so receipts without it are byte-identical to before and the commit trailer is unchanged.

### [S1] Registry / regeneration

None. No error code, doctor check or repair registry change. Docs: docs/architecture/key-files/core-utilities-2.md updated in the commit (now 59912/60000 bytes; the next edit there needs a split). Run `bun run build:llms` after merge.
