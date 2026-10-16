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
