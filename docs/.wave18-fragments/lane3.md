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
