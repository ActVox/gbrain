# Wave 18 lane 3 fragments (integrator: apply, then delete this file)

Lane 3 branch: capy/wave18-lane3. Each section names the target file, the place and the exact text. Version strings use `<WAVE>` for the wave's stamped version.

## #6740 mention scan masks HTML comments

### src/core/behavior-change-notice.ts (append to BEHAVIOR_CHANGES)

```ts
  { since: '<WAVE>', text: 'The entity mention scan no longer reads text inside HTML comments, so the `<!--- gbrain:... -->` fence markers stop producing `mentions` links to a page titled like a marker word (#6740). `MENTION_EXTRACTOR_VERSION` is now 6: the next `gbrain extract --stale` (or maintenance cycle) rescans every inline-body page once and removes the stale plain mention rows; `typed_ner` edges are untouched and segmented pages stay deferred as before. Entity cards and `get_backlinks` show a mention coverage notice (state `pending`) until that rescan finishes.' },
```

### CHANGELOG.md (wave entry, Fixed)

- The mention scan ignores text inside HTML comments, so gbrain's own fence markers no longer link every page to a page titled "gbrain" (#6740). One rescan runs on the next extract or maintenance pass and removes the false mention links. "Discussed in" timeline bullets that the bug already wrote are not removed by this release; delete them once by hand (they no longer come back). A preview-first cleanup is deferred to the next wave.

### Deferred list (PR body)

- #6740: cleanup of stale "Discussed in" timeline bullets already written; preview-first repair, next wave.

## #6742 question type in gbrain-base-v2 (pack 1.4.0)

### src/core/behavior-change-notice.ts (append to BEHAVIOR_CHANGES)

```ts
  { since: '<WAVE>', text: 'The bundled `gbrain-base-v2` schema pack (the `init` default, also inherited by `company-brain`) is now version 1.4.0 and declares the `question` page type the pinned-question writer stamps, so a pinned question no longer makes doctor `schema_pack_consistency` warn `page_type_undeclared` (#6742). Existing question pages keep their type; no data changes. The active pack identity reads `gbrain-base-v2@1.4.0+<hash>`.' },
```

### Regenerate (integrator)

- Doctor goldens: the `pack_upgrade_available` message changes from `gbrain-base-v2@1.3.0+a50a67b9` to `gbrain-base-v2@1.4.0+1c5ba903` in test/fixtures/goldens/doctor/{content-pglite-human,content-pglite-json,hot-checks-pglite-json,hot-checks-postgres-json,json-pglite-degraded,json-pglite-fresh,json-postgres-fresh}.json. Regenerate with the goldens script rather than hand-editing.
- Plugin trees / template repo if they embed the pack (none found by grep for `a50a67b9` outside the doctor goldens).

### CHANGELOG.md (wave entry, Fixed)

- Pinning a question no longer makes doctor warn about an undeclared `question` page type on the default schema pack (#6742). `gbrain-base-v2` is now 1.4.0.

## #6720 atom pages inherit the source page's content date

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

## #6731 conversation extractor entity hints

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

## #6764 conversation facts: write-time subject inference and a doctor fix that can act on them

### src/core/behavior-change-notice.ts (append to BEHAVIOR_CHANGES)

```ts
  { since: '<WAVE>', text: '`gbrain extract-conversation-facts` (and the `conversation_facts_backfill` cycle phase) now runs the free write-time subject inference on facts the extractor returns without an entity, so a fact naming exactly one entity page in full is stored on that entity (context note `entity inferred from mention`; off with `facts.entity_inference false`) (#6764). Doctor `unlinked_facts` counts the conversation extractor\'s unlinked rows on their own (origin `conversation`, no longer inside fence-owned) and, because `gbrain facts relink` never examines them, its fix is a bounded, source-qualified re-extraction of the pages with the most (`--slugs`, up to 50, `--force --max-cost-usd 1`, preview `--dry-run`; paid, asks the user first). A `replaces` naming a conversation-derived fact now says to re-extract its page instead of hinting at a fence edit.' },
```

### CHANGELOG.md (wave entry, Fixed)

- Facts extracted from conversations now link to the person or company they name when only one entity page matches, and doctor's `unlinked_facts` gives conversation facts a fix that can act on them (a capped re-extraction of the named pages, previewed first) instead of `gbrain facts relink`, which never touched them (#6764).

### scripts/module-size-limits.tsv

- `src/commands/extract-conversation-facts.ts` is 2079 of its 2087 ceiling after this commit (the inference logic lives in the new `src/core/facts/conversation-subject-infer.ts`). The integrator can lower the ceiling to 2079 when settling the TSV.

### Notes

- New exported symbols (no registry rows needed): `CONVERSATION_FIX_SLUGS` (doctor/checks/unlinked-facts.ts), `inferConversationSubjects` (core/facts/conversation-subject-infer.ts). The `replaces_cross_page_derived` suggestion lives in core/persistence/verb-errors.ts beside the existing `replaces_cross_page` text; no error-registry code was added.

## #6764 (d1b, own commit: drop it if Garry picks d1a) free conversation relink as the doctor's primary fix

### src/core/behavior-change-notice.ts (append to BEHAVIOR_CHANGES)

```ts
  { since: '<WAVE>', text: 'New `gbrain facts relink --conversation` links the conversation extractor\'s facts that were stored without an entity, for free: a fact naming exactly one entity page in full is linked (context note `entity relinked from mention`), one write per page (a receipted coordinator request on a managed brain), no model call (#6764). Doctor `unlinked_facts` now prescribes it first for those rows (consent none, the agent runs it, preview `--dry-run`); a fact it cannot resolve is recorded (`fact_relink_attempts` outcome `conversation_unresolved`), and only then does the doctor offer the paid, capped re-extraction of its page.' },
```

### CHANGELOG.md (wave entry, Fixed; same bullet as the #6764 line above, extended)

- `gbrain facts relink --conversation` links existing conversation facts to the people and companies they name, for free; doctor offers it before any paid re-extraction (#6764).

### Notes

- New maintenance intent kind `managed_maintenance_conversation_relink`, dispatched in `src/core/persistence/prepared-maintenance.ts` (one line, not a listed registry). New canonical-writer census row for `src/core/facts/conversation-relink.ts` in `docs/architecture/canonical-writers.tsv` (ceiling 1, boundary coordinator).
- Module sizes: `src/commands/facts.ts` 201 lines, `src/core/facts/conversation-relink.ts` 187 (new), `src/core/persistence/prepared-maintenance.ts` 590; none is listed in the TSV and all are under the new-file cap. No TSV change.
- Dropping this commit (d1a) restores the commit before it exactly: doctor prescribes the paid re-extraction for every unlinked conversation row. The commit also edits that commit's own tests (seeding a `conversation_unresolved` memo so they still exercise the paid envelope).
