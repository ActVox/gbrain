# ActVox fork modules

Reference entries for source files that exist only in the ActVox fork. They live
here, not in the upstream-owned `docs/architecture/key-files/*` subsystem docs, so
upstream integrations never conflict with them and upstream's size caps are not
consumed by fork text. Every file is also listed in `scripts/actvox/patch-inventory.tsv`.

## Search

- `src/core/search/operational-memory.ts` — ActVox canonical operational-page selection and ranking. Reuses structural exact lookup admission for source grants, private-page and shape exclusions. The three hybrid return paths apply it before final token budgeting. Regression coverage: `test/operational-memory-policy.test.ts` and `test/operational-memory-scope.test.ts`.
