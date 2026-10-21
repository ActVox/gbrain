# Generations

GBRA-161. A derived producer (atom extraction today; synthesis, fences and projections in later releases) replaces the
set of items one input owns through one primitive, `publishGeneration` (`src/core/generations/publish.ts`). The
generation ledger records which items each generation owns, so a bad result can be held before it lands and a landed
one can be undone.

## The ledger

Migration v265 (a placeholder number, restamped when the change merges) adds three tables. Nothing existing changes.

- `derived_generations`: one row per generation of a key (source, kind, owner key). At most one is `live` and at most
  one is `held`; earlier live rows become `superseded` and keep their items. A row records the input pin and size it
  was derived from, the item-set hash, the operation id an identical replay matches, and for a held row the reason, the
  attempts and the proposal it would publish (at most 4 MiB, else no releasable copy).
- `derived_generation_items`: each item a generation published, kept, adopted, revived or retired, with its identity
  hash (a digest of what the page says, leaving out completion, extraction and retirement stamps) and, for an item it
  overwrote or retired, a bounded preimage (at most the inline page size; none for a segmented page).
- `derived_generation_valve`: retirements counted per run window, for the retirement valve.

## Publishing

Under the item page locks (slug order) and then the key's advisory lock, `publishGeneration`:

1. replays an identical operation as `unchanged`;
2. refuses a producer that planned against another live generation or whose input moved (`generation_fenced`);
3. plans the result (`plan.ts`, pure): an item is the key's when the live generation recorded it, or when it carries
   the key's origin metadata and either the result reproduces it or a retained page version the producer wrote shows it
   unedited (legacy adoption). Any other row naming the key is protected: never retired, listed in the outcome;
4. holds the result instead of publishing it, in this order: `segmented_unsupported` (it would rewrite or retire a
   segmented page), `no_proof` (an empty result without an empty-source proof, `proofs.ts`), `oversize` (more puts
   or retirements than `generations.max_items`), `shrunk` (a model-produced result keeping fewer than
   `generations.shrink_floor` of the owned items, scaled by how much the input shrank), `valve` (the run window would
   retire more than `generations.valve.max_per_run`, or more than 25 and over `generations.valve.max_ratio` of the
   kind's owned items). A held result writes nothing and retires nothing; the previous generation stays live;
5. otherwise, in one attributed transaction: writes the new and changed items, marks them complete (an atom's
   `source_hash`), rechecks each is live at the identity just written (`generation_live_conflict` otherwise), versions,
   soft-deletes and stamps what the new generation no longer has (`retired_by` the adapter's stamp, held from the
   purge for `generations.restore_days`), supersedes the previous row and activates the new one.

A partial result (an input cut at its cap, #6503) publishes additively: it writes its items, carries the rest of the
live generation forward, retires nothing and completes nothing.

Adapters (`contract.ts`) own one kind each: `adapters/atoms.ts` (unmanaged atoms, one key per origin page or
transcript) in this release. Managed brains keep the coordinator path until PR 1b.

## Repair

`gbrain repair generations --kind <kind>` is explicit-only and preview-bound (docs/guides/repair.md#generations):
`--mode restore` (the default) republishes the item set the selected live generation replaced, `--mode release-held`
publishes a held result once. Doctor reports `generation_retirements` (ok, with the restorable count) and
`generation_held` (warn).

## Purge

A page purge nulls the purged item's preimages and every held proposal naming it; a fact purge nulls every preimage and
proposal carrying the claim (`ledger-scrub.ts`). Restore then refuses that item (`no_preimage`).

## Census

`scripts/check-derived-census.ts` counts the code that soft-deletes pages per file against
`docs/architecture/derived-census.tsv`. A new site needs a reviewed row; ceilings only shrink. Rows classed
`pending:inventory` are the derived writers later GBRA-161 PRs move onto the primitive.

## Settings

| Key | Default | Range |
| --- | --- | --- |
| `generations.restore_days` | 30 | 3 to 365 |
| `generations.shrink_floor` | 0.5 | 0.05 to 1 |
| `generations.max_items` | 64 | 8 to 1024 |
| `generations.valve.max_per_run` | 500 | 1 to 100000 |
| `generations.valve.max_ratio` | 0.5 | 0.01 to 1 |

`gbrain config set` refuses a value out of range; a stored value out of range reads as the default.
