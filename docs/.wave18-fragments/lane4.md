# Wave 18 lane 4 fragments (integrator: apply, then delete this file)

Branch `capy/wave18-lane4`. Every `since` below is a placeholder: stamp the wave's version at the merge slot.

## BEHAVIOR_CHANGES rows (`src/core/behavior-change-notice.ts`, append at the end of `BEHAVIOR_CHANGES`)

```ts
  // Wave 18 lane 4 (#6725, PR #6745 by @javieraldape). `since` is a placeholder until the merge-slot stamp.
  { since: '0.60.267.0', text: '`volunteer_context` and the retrieval reflex now point at one page per name per source: when a meeting, transcript or note page shares an entity page\'s exact title, the pointer goes to the explicit exact slug, then the linkable entity type, then anything else, as `entity` already chose (#6725). The choice runs after the privacy and activation gate, so a private or withheld entity page falls back to the readable page, and same-title pages in different sources are still both volunteered.' },
  // Wave 18 lane 4 (#6723). `since` is a placeholder until the merge-slot stamp.
  { since: '0.60.267.0', text: '`entity` and `context_pack` now resolve names across every source the caller can read, like `volunteer_context` (#6723): the home source first (the connection\'s source, or its GBRAIN_SOURCE / .gbrain-source binding), then the other readable sources sorted by id. A name only another readable source holds now returns a card instead of `found: false`; a name the home source holds still resolves there. `source_id` pins one source (refusals match `recall`: `scope_denied`, `not_found`, `invalid_params`), `context_pack` takes source-qualified `entity_refs`, and every card, `names` row and suggestion carries `source_id`. A bound connection\'s lookups that its own source misses get a `source_binding_narrowed` notice naming where each name resolved. Sources outside the grant are never read; a remote `__all__` still resolves nothing. Each pack card\'s activation verdict, newer mentions, records and page status now come from its own source.' },
  // Wave 18 lane 4 (#6724). `since` is a placeholder until the merge-slot stamp.
  { since: '0.60.267.0', text: '`context_pack` now returns `entity_facts[]`, the packed entities\' own facts (up to 5 per card, newest first, read in the card\'s own source and visibility), each tagged with its card\'s `source_id` and `slug` and carrying `fact_id`, confidence, `attributed_to`, provenance and trust (#6724). `facts[]` is unchanged hot memory. `text` gains a `## Entity facts` section before hot memory, and a fact in both renders once. Under `budget_tokens` entity facts pack after cards and before hot facts; a remote caller still never sees a private fact.' },
```

## Regeneration steps (integrator-owned generated files)

- `bun run build:llms`: `docs/protocol/MEMORY_VERBS_v1.md` gained the "entity source resolution and `source_id`", "context_pack sources" and "context_pack entity_facts" sections, so `llms-full.txt` is stale (`test/build-llms.test.ts` fails until regenerated).
- `src/core/operation-manifest.generated.ts` was regenerated in-branch (`bun run build:operation-manifest`) for the new `entity` / `context_pack` params; rerun it after the merge.
- Plugin trees / MCP tool goldens: rerun their generators after the merge (new `source_id`, `prefer_source_id` and `entity_refs` params).
- `test/fixtures/goldens/cli/tools-json.json`: `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/cli-goldens.test.ts`. The diff is intentional and only adds the #6723 params (`entity`: `source_id`, `prefer_source_id`; `context_pack`: `source_id`, `entity_refs`, `prefer_source_id`); `--tools-json` is the full surface, so they show there even though the starter MCP list omits them.
- `bun run regen:all --check` on the lane head lists only `llms.txt + llms-full.txt` as stale; the tools-json golden fails in `test/cli-goldens.test.ts` and is not in regen:all.
