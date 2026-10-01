# facts-relink-5836 (#5836): unlinked facts

Contributor notes for the fix-wave collector (GBRA-37). No version bump on this branch.

## CHANGELOG paragraph

**Facts saved without an entity now get one, and the backlog can be repaired (#5836).**
Facts that no entity owned were invisible to entity recall, never reached the
entity page's `## Facts` fence, and the System One conflict sweep skipped them
as `no_entity` (one production brain had 23% of facts unlinked and 101 of its
last 103 new facts). `remember` and page imports now look for the subject in
the fact text without a model call and link only when exactly one existing
entity is named and no other name competes; the response says what happened
(`entity_inferred`, or `warnings: ["NO_ENTITY"]` with a hint). The new
`gbrain facts relink` repairs old facts: free tiers first, then the fact
extraction model under a `--max-usd` cap (default $1.00), moving each fact by
id onto its entity page's fence through the write coordinator, retiring exact
duplicates, never superseding anything, and queuing linked facts for the
conflict sweep. `gbrain doctor` reports `unlinked_facts`, and `gbrain decide
status` shows the share of conflict skips caused by missing entities.

## Upgrade note

- Migration v187 adds `fact_relink_attempts` and the `idx_facts_unlinked_active`
  index. It is separate from the optional backlog repair.
- New facts may now be filed onto entity pages automatically. Turn it off with
  `gbrain config set facts.entity_inference off`; that does not undo earlier links.
- Repair the backlog on the brain host: `gbrain facts relink --dry-run`, then
  `gbrain facts relink`. Guide: `docs/guides/facts-relink.md`.

## Design notes for reviewers

- Relink publishes through a coordinator mutation (`relink_facts`) on managed
  and unmanaged brains alike, the same coordinator remember uses. That replaced
  the planned unmanaged journal and extract_facts recovery hook: the
  coordinator's journal already makes the request replay or refuse as a unit.
- Alternatives considered and not taken: retrieval-first recall over
  unattributed facts (already partly served by fact-text filtering),
  entity-free conflict candidates (TODOS), LLM entity resolution at write time
  (remember stays zero-LLM).
