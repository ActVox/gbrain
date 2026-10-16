# Wave 18 lane 2 fragments (scratch; the integrator applies these rows and deletes this file)

## #6729 inexact Git rename identity

### Registries (integrator-owned)

The `INTEGRATOR-ROW` commit at the end of `capy/wave18-lane2` applies rows 1-4 and regenerates the goldens, so `check:orphan-modules` passes on the lane branch. Drop it and apply the rows by hand if you'd rather.

1. `src/core/repair/core.ts` `REPAIR_KINDS`: insert `'rename-identity'` right after `'ghost-pages'`.
2. `src/core/repair/registry.ts`: add `import { renameIdentityRepair } from './rename-identity.ts';` after the ghost-pages import, and this entry right after `'ghost-pages'`:
   ```ts
   'rename-identity': {
     handler: renameIdentityRepair, embeds: 'none', checks: ['rename_identity_downgrades'], explicit_only: true, preview_bound: true,
     summary: 'Carry a page identity across an inexact Git rename that sync split into a delete plus an add because the files did not confirm it '
       + '(#6729: no shared frontmatter id, slug: line or unique title). The preview lists each open pair (72 h window, old page still soft-deleted, '
       + 'new page live) with the facts, links and aliases that stay on the old slug; --apply --expect <hash> moves exactly that set onto the new page '
       + 'with the sync rename carrier (old -> new slug redirect, slug-keyed facts and aliases, page-id-keyed links, timeline and versions) and closes '
       + 'each record. Runs only when named.',
   },
   ```
3. `src/commands/doctor/registry.ts`: `import { renameIdentityDowngradesEntry } from './checks/rename-identity-downgrades.ts';` and add `renameIdentityDowngradesEntry,` right after `ghostPagesEntry,` in the entry list.
4. `src/core/doctor-categories.ts`: after `'ghost_pages',` add
   ```ts
     // #6729: inexact renames whose identity sync did not keep, inside their 72 h window (doctor/checks/rename-identity-downgrades.ts).
     'rename_identity_downgrades',
   ```
5. Regenerate the doctor goldens (`test/fixtures/goldens/doctor/*`) and any registry golden after 1-4.

### BEHAVIOR_CHANGES (`src/core/behavior-change-notice.ts`, since = slot version)

- `{ since: '<slot>', text: 'An inexact Git rename (a move that also changed the file, reported as R<100) now keeps its page identity only when the files confirm it: the same frontmatter \`id\` on both sides that no other file or page carries, or, with no id on either side, a \`slug:\` line or title that no other file in the sync and no other live page shares (#6729). Any other pair is imported as a delete plus an add: the new file starts a fresh page and the old page keeps its facts, links and aliases on its soft-deleted slug. The sync report prints each pair, \`gbrain sync status --json\` lists it under \`identity_downgrades\`, doctor \`rename_identity_downgrades\` names it, the purge leaves the old page for 72 hours, and \`gbrain repair rename-identity --source <id>\` (preview, then \`--apply --expect <hash>\`) carries the identity when the pair really was one page. A new file whose frontmatter \`id\` uniquely matches a file deleted in the same sync range is now its rename, even across two commits.' }`
- `{ since: '<slot>', text: 'A file moved and broken in the same commit (unreadable frontmatter, so Git reports an inexact rename) is no longer held with the old page identity: the old page is soft-deleted and recorded as above, the broken file is held as a new file, and after it is fixed \`gbrain repair rename-identity\` carries the old page onto it (#6729). An exact move (R100) that is held still keeps the old page identity and \`rename_from\`. A managed sync refuses \`page_identity_changed\` (detail \`rename_identity_conflict\`) when a file would take over a page whose frontmatter \`id\` differs from its own.' }`

### CHANGELOG

- Sync no longer moves one page's facts, links and aliases onto a different page when Git guesses an inexact rename between two similar files. Identity follows a shared frontmatter `id`, a unique `slug:` line or a unique title; anything else is a delete plus an add, recorded for 72 hours with `gbrain repair rename-identity` to carry it when the move was real (#6729). Contributed by @javieraldape (PR #6732, rewritten).

### KEY_FILES (`docs/architecture/key-files/files-and-sync-*.md`, `commands-*.md`)

- `src/core/sync-rename-identity.ts`: the one confirmation stage for inexact Git renames (#6729). `confirmRenameIdentities` reads both sides' frontmatter heads through one `git cat-file --batch` stream (`catFileHeads`, 64 KiB per object; the dirty tree reads the working file) and keeps an R<100 pair only on a unique shared `id`, or with no id on either side a unique `slug:` line or title (titles also unique among live pages); conflicting ids veto; an add whose id uniquely matches a delete in the range becomes a rename. `confirmedSyncDelta` wraps `computeSyncDelta`. Classic preflight, managed discovery and the dirty-tree manifest call it before any consumer filter.
- `src/core/sync-identity-downgrades.ts`: durable records of downgraded pairs (`op_checkpoints` op `sync-identity-downgrade`, fingerprint = old page id, 72 h), the purge-hold SQL predicate, the live list (new slug read live), the report lines and the remedy preview argv.
- `src/core/repair/rename-identity.ts`: `gbrain repair rename-identity`, preview-bound, reuses `carryRenameIdentity` from `src/commands/sync/renames.ts`.
- `src/commands/doctor/checks/rename-identity-downgrades.ts`: doctor `rename_identity_downgrades` (warn while a record is open; fix = the read-only remedy preview).

### Tests that changed for the intended behaviour

- `test/sync.test.ts` (3) and `test/sync-git-paths.test.ts` (3 platform cases): `buildSyncManifest` rename entries now carry Git's `similarity`.
- Held-rename hold-lane tests whose fixture was an inexact move onto a broken file now use an exact move (R100) held by a stale `slug:` line; every hold-lane assertion is unchanged: `test/persistence-sync-holds.test.ts` (2), `test/repair-frontmatter.test.ts` (2), `test/hold-action-chain-6712.test.ts` (1), `test/sync-legacy-holds.test.ts` (3), `test/write-attribution-sync.test.ts` (1). The inexact-onto-broken fixture keeps a test per path asserting its new outcome (`#6729: an inexact rename onto a broken file ...` in persistence-sync-holds and sync-legacy-holds).
- `test/large-pages/managed-sync-segmented-rename.test.ts`: the fixture carries a frontmatter `id`, so the edited rename whose title follows the slug is still confirmed.
