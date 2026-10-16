# Wave 18 lane 3 fragments (integrator: apply, then delete this file)

Lane 3 branch: capy/wave18-lane3. Each section names the target file, the place and the exact text. Version strings use `<WAVE>` for the wave's stamped version.

## [S2] #6740 mention scan masks HTML comments

### src/core/behavior-change-notice.ts (append to BEHAVIOR_CHANGES)

```ts
  { since: '<WAVE>', text: 'The entity mention scan no longer reads text inside HTML comments, so the `<!--- gbrain:... -->` fence markers stop producing `mentions` links to a page titled like a marker word (#6740). `MENTION_EXTRACTOR_VERSION` is now 6: the next `gbrain extract --stale` (or maintenance cycle) rescans every inline-body page once and removes the stale plain mention rows; `typed_ner` edges are untouched and segmented pages stay deferred as before. Entity cards and `get_backlinks` show a mention coverage notice (state `pending`) until that rescan finishes.' },
```

### CHANGELOG.md (wave entry, Fixed)

- The mention scan ignores text inside HTML comments, so gbrain's own fence markers no longer link every page to a page titled "gbrain" (#6740). One rescan runs on the next extract or maintenance pass and removes the false mention links. "Discussed in" timeline bullets that the bug already wrote are not removed by this release; delete them once by hand (they no longer come back). A preview-first cleanup is deferred to the next wave.

### Deferred list (PR body)

- #6740: cleanup of stale "Discussed in" timeline bullets already written; preview-first repair, next wave.

## [S2] #6742 question type in gbrain-base-v2 (pack 1.4.0)

### src/core/behavior-change-notice.ts (append to BEHAVIOR_CHANGES)

```ts
  { since: '<WAVE>', text: 'The bundled `gbrain-base-v2` schema pack (the `init` default, also inherited by `company-brain`) is now version 1.4.0 and declares the `question` page type the pinned-question writer stamps, so a pinned question no longer makes doctor `schema_pack_consistency` warn `page_type_undeclared` (#6742). Existing question pages keep their type; no data changes. The active pack identity reads `gbrain-base-v2@1.4.0+<hash>`.' },
```

### Regenerate (integrator)

- Doctor goldens: the `pack_upgrade_available` message changes from `gbrain-base-v2@1.3.0+a50a67b9` to `gbrain-base-v2@1.4.0+1c5ba903` in test/fixtures/goldens/doctor/{content-pglite-human,content-pglite-json,hot-checks-pglite-json,hot-checks-postgres-json,json-pglite-degraded,json-pglite-fresh,json-postgres-fresh}.json. Regenerate with the goldens script rather than hand-editing.
- Verified locally on the lane head (9d22a479b): test/doctor-content-golden.test.ts, test/doctor-hot-checks-golden.test.ts and test/doctor-json-golden.test.ts fail (3 tests) and pass on master cadaf5cd7. Bisected: at d2bae380a (#6740 alone) the content golden matches; from 9cc84754c (#6742) on it drifts. The whole drift is (a) #6742: the pack identity `gbrain-base-v2@1.4.0+1c5ba903`, "pack gbrain-base-v2 declares 21" (was 20), and the journal byte counters (`used`, `per_day_7d`, `max_day_7d`, `reclaimable_bytes`) that grow with the bigger pack; (b) #6764: `unlinked_facts` details gain `conversation: null`, `window.conversation: 0` and `new_7d.conversation_unresolved: 0`. Regenerate after the merge with `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test <file>` for each of those three files (plus the Postgres captures in the E2E tier), review the fixture diff against this list and name it in the PR body.
- Plugin trees / template repo if they embed the pack (none found by grep for `a50a67b9` outside the doctor goldens).

### CHANGELOG.md (wave entry, Fixed)

- Pinning a question no longer makes doctor warn about an undeclared `question` page type on the default schema pack (#6742). `gbrain-base-v2` is now 1.4.0.

## [S2] #6720 atom pages inherit the source page's content date

### src/core/behavior-change-notice.ts (append to BEHAVIOR_CHANGES)

```ts
  { since: '<WAVE>', text: 'A page-derived atom now carries its source page\'s content date as frontmatter `date` (the source\'s stored `effective_date`, else the same precedence import uses), so its `effective_date` is the date of the conversation or note it came from instead of the extraction run (#6720); `extracted_at` stays the processing stamp and transcript-derived atoms are unchanged. Atoms extracted before this release keep their run dates until re-extracted (`gbrain dream --phase extract_atoms` with `--force` re-pays the model); a preview-first backfill repair is planned.' },
```

### CHANGELOG.md (wave entry, Fixed; credit)

- Atoms extracted from a page are dated by that page's content date, not by when extraction ran, so date filters and recency ranking over atoms work (#6720). Existing atoms are not backfilled in this release. Contributed by @javieraldape (idea from #6737).

### PR body

- `Supersedes #6737` (reimplemented: helper peeled into `src/core/cycle/atom-source-date.ts` instead of a module-size ratchet raise; single source-page fetch before inference kept).
- Deferred: #6720 backfill of existing atom dates, a preview-first repair, next wave.

### scripts/module-size-limits.tsv

- No row change: `src/core/cycle/extract-atoms.ts` is 1653 of its 1654 ceiling after this commit.

## [S2] #6731 conversation extractor entity hints

### src/core/behavior-change-notice.ts (append to BEHAVIOR_CHANGES)

```ts
  { since: '<WAVE>', text: '`gbrain extract-conversation-facts` (and the `conversation_facts_backfill` cycle phase) now tells the extractor which entities the conversation page itself links (its frontmatter attendees and the entity pages its body links, same source, up to 40 slugs), so facts about those people and companies are stored on their pages instead of a guess from a first name (#6731). A private entity is hinted only when the run writes private facts. The `extract_facts` operation\'s prompt and 5-hint cap are unchanged.' },
```

### CHANGELOG.md (wave entry, Fixed; credit)

- Conversation fact extraction passes the page's own linked entities to the extractor as hints, so more meeting facts link to the right person or company page (#6731). Contributed by @troyhoffman-oss (design from #6736; reimplemented with slug-only hints, a visibility filter and the op prompt left unchanged).

### PR body

- `Supersedes #6736`.

### scripts/module-size-limits.tsv

- `src/commands/extract-conversation-facts.ts` shrinks from 2087 to 2078 in this commit (the two extractor call sites share one input object). Lower its ceiling when the integrator settles the TSV after the later lane 3 commits (the #6764 commit adds a few lines back; see that section).

## [S2] #6764 conversation facts: write-time subject inference and a doctor fix that can act on them

### src/core/behavior-change-notice.ts (append to BEHAVIOR_CHANGES)

```ts
  { since: '<WAVE>', text: '`gbrain extract-conversation-facts` (and the `conversation_facts_backfill` cycle phase) now runs the free write-time subject inference on facts the extractor returns without an entity, so a fact naming exactly one entity page in full is stored on that entity (context note `entity inferred from mention`; off with `facts.entity_inference false`) (#6764). Doctor `unlinked_facts` counts the conversation extractor\'s unlinked rows on their own (origin `conversation`, no longer inside fence-owned) and, because `gbrain facts relink` never examines them, its fix is a bounded, source-qualified re-extraction of the pages with the most (`--slugs`, up to 50, `--force --max-cost-usd <N>` with the approved amount as the input `N`, preview `--dry-run`; paid, asks the user first). A `replaces` naming a conversation-derived fact now says to re-extract its page instead of hinting at a fence edit.' },
```

### CHANGELOG.md (wave entry, Fixed)

- Facts extracted from conversations now link to the person or company they name when only one entity page matches, and doctor's `unlinked_facts` gives conversation facts a fix that can act on them (a re-extraction of the named pages capped at the amount the user approves, previewed first) instead of `gbrain facts relink`, which never touched them (#6764).

### scripts/module-size-limits.tsv

- `src/commands/extract-conversation-facts.ts` is 2079 of its 2087 ceiling after this commit (the inference logic lives in the new `src/core/facts/conversation-subject-infer.ts`). The integrator can lower the ceiling to 2079 when settling the TSV.

### Notes

- New exported symbols (no registry rows needed): `CONVERSATION_FIX_SLUGS` (doctor/checks/unlinked-facts.ts), `inferConversationSubjects` (core/facts/conversation-subject-infer.ts). The `replaces_cross_page_derived` suggestion lives in core/persistence/verb-errors.ts beside the existing `replaces_cross_page` text; no error-registry code was added.

## [S2] #6764 free conversation relink as the doctor's primary fix (decision d1b)

### src/core/behavior-change-notice.ts (append to BEHAVIOR_CHANGES)

```ts
  { since: '<WAVE>', text: 'New `gbrain facts relink --conversation` links the conversation extractor\'s facts that were stored without an entity, for free: a fact naming exactly one entity page in full is linked (context note `entity relinked from mention`), one write per page (a receipted coordinator request on a managed brain), no model call (#6764). Doctor `unlinked_facts` now prescribes it first for those rows (consent none, the agent runs it, preview `--dry-run`); a fact it cannot resolve is recorded (`fact_relink_attempts` outcome `conversation_unresolved`), and only then does the doctor offer the paid, capped re-extraction of its page.' },
```

### CHANGELOG.md (wave entry, Fixed; same bullet as the #6764 line above, extended)

- `gbrain facts relink --conversation` links existing conversation facts to the people and companies they name, for free; doctor offers it before any paid re-extraction (#6764).

### Notes

- New maintenance intent kind `managed_maintenance_conversation_relink`, dispatched in `src/core/persistence/prepared-maintenance.ts` (one line, not a listed registry). New canonical-writer census row for `src/core/facts/conversation-relink.ts` in `docs/architecture/canonical-writers.tsv` (ceiling 1, boundary coordinator).
- Module sizes: `src/commands/facts.ts` 201 lines, `src/core/facts/conversation-relink.ts` 187 (new), `src/core/persistence/prepared-maintenance.ts` 590; none is listed in the TSV and all are under the new-file cap. No TSV change.

## [S2] Gate follow-ups (all items)

- `src/core/cli-flag-registry.generated.ts`: regenerated with `bun run build:flag-registry` in the separate final commit "INTEGRATOR-ROW: regenerate cli-flag-registry for lane 3" (tests docs-cli-commands, remediation-command-resolution, cli-flag-validation and conversation-facts-type-allowlist-drift need it). Additive only: facts +`--conversation --force --slugs --source-id`, doctor +`--conversation --entity --retry-model`, lint +`--max-cost-usd --slugs`, maintain and sync +`--conversation`. Drop it and rerun the generator after the lanes merge.
- New exemption in `scripts/check-core-guard-coverage.mjs` (conversation-relink.ts: database-only fact rows, page text unchanged) and a write-attribution row in `docs/architecture/system-of-record.md`.
- gstack pregate `literals` reports ~643 test locations "still carrying" MENTION_EXTRACTOR_VERSION 5. Every hit except test/mentions-pass.test.ts (fixed to use the symbol) is an unrelated literal 5 (array indexes, model names, counts); no test pins the mention version as a number. The `lanes` check flags this fragment file, which the integrator deletes.


## [S2] #6764 follow-up (v3 review r2-d1)

- The free path is `gbrain facts relink --conversation` (a flag on the existing verb). It stays a receipted, database-only linkage of the derived row: `entity_slug` plus the `entity relinked from mention` note on the row itself, one maintenance transaction per page (a `managed_maintenance_conversation_relink` request on a managed brain). Conversation ownership, fact id, provenance and trust are kept and no Markdown is edited, so the doctor envelope asks no consent (`[]`, actor agent; `host_admin` on the remote path). Conversation pages have no `## Facts` fence (canonical projection and the extract_facts reconcile skip extractor rows, #1928), so `FACTS_FENCE_COLUMNS` having no entity column does not matter here.
- `extract-conversation-facts --force` keeps the link: `clearConversationFacts` expires relinked rows instead of deleting them and the replacement row of the same claim inherits the entity (new module `src/core/facts/conversation-relink-carry.ts`). Tested unmanaged and managed with write-time inference off, plus the extract_facts reconcile.
- Every derived row the free pass examines is memoized in `fact_relink_attempts` (`linked` or `conversation_unresolved`), so doctor sequences free relink while untried rows exist, then the paid fallback scoped to the memoized pages (at most 50) with `--max-cost-usd <N>` and `inputs: [{ name: 'N' }]`.
- 25% rule: memoized `conversation_unresolved` rows are excluded from the new-fact share like `no_subject` (`details.new_7d.conversation_unresolved`).
- `RELINK_REASONS.fence_owned` text names `gbrain facts relink --conversation` (the guide table in docs/guides/facts-relink.md matches).

### src/core/behavior-change-notice.ts (replace the #6764 rows' paid-fallback wording)

- In both #6764 rows, the paid fallback is "capped at the amount the user approves (`--max-cost-usd <N>`)", not "`--max-cost-usd 1`", and the second row should add: "A re-extraction of the page keeps a relinked fact's entity on the claim's new row. Rows the free pass could not resolve no longer count toward doctor's 25% new-fact warning."

## [S2] #6764 follow-up (final v3 Eng review)

- Paid-fix envelope fixture: test/conversation-reextract-envelope-6764.test.ts runs the free pass, takes doctor's paid fix, runs its preview_argv through the CLI (output names the target page, no model call, facts unchanged), then the real argv with N=1 against a zero-price stubbed provider (pricing.overrides 0/0), and asserts unlinked_facts clears.
- `extract-conversation-facts --dry-run --slugs ...` now prints `Targets: <slugs>` (one line; src/commands/extract-conversation-facts.ts is 2080 of its 2087 ceiling, no TSV change).
- test/trust-write-gate-drift.test.ts gains an EXEMPT row for src/core/facts/conversation-relink.ts (it writes entity_slug and a context note on existing rows, never claim text). The RELINK_REASONS.fence_owned text avoids a hand-built gbrain command (check:agent-contract).
- The free relink is the trusted-local intent `managed_maintenance_conversation_relink` (database-only, no files, no model) on a managed brain; an unmanaged brain has no maintenance coordinator, so it uses the same writeDerivedFacts maintenance transaction as the extractor itself.
- All Lane 3 rows in this file are S2.

