# Fix wave notes: search lane (#5889, title FTS, #5890)

## #5889: an exact-title page no longer drops out of title search

Every title that holds the query term once gets the same `ts_rank_cd`, and ties
broke by page id. The exact-lookup tier only sees the title arm's top
`max(2 × limit, 50)` rows, so an identity page titled exactly "Acme" lost to
dozens of older "Acme weekly sync N" pages, for local and remote callers on both
engines. Both orderings of the title arm now sort an exact-title key first:
`lower(btrim(title, ' "''' || chr(160))) = normalizeAlias(query)`. The key is a
cheap approximation (no internal whitespace collapse); the tier's JS
`normalizeAlias` recheck stays authoritative, so a mismatch can only miss.

The title arm now lives once for both engines: `src/core/engine-sql/titles.ts`
runs it, and the statement builds in `src/core/search/title-statement.ts`
(`scripts/engine-sql-baseline.tsv`: `migrated titles`).

## Remote title search is index-backed (no migration)

Diagnosis credited to PR #5853 by morven-ai. No code from that PR was ported;
its title GIN migration and embedded-hash statistics half are not taken.

Remote (safe-chunks) callers used to match `to_tsvector(lang, title)` per row,
which no index serves: a scan of every page in scope. They now match
`pages.search_vector @@ q_a`, where `q_a` is the websearch query with every
lexeme labeled `:A` (weight A of `search_vector` is the title alone, pinned by
a test), ranked on `ts_filter(search_vector, '{a}')`. Negated and phrase terms
are evaluated on title lexemes only, so timeline text can never change which
titles a remote caller sees. Pages with a NULL `search_vector` are absent from
the remote arm (the BEFORE INSERT/UPDATE trigger keeps it non-NULL;
`gbrain reindex-search-vector` repairs it).

Remote title matching follows the language `search_vector` was built with;
after an FTS language change run `gbrain reindex-search-vector`.

Why not a title GIN index migration: its language would be frozen at upgrade
time with no rebuild path, it adds a third GIN index on `pages` (write
amplification beside `idx_pages_search` and `idx_pages_trgm`), and PGLite would
need its own expression index. The weight-labeled query reuses
`idx_pages_search` on both engines.

### Benchmark gate (E13)

Postgres 16 (pgvector/pgvector:pg16), real gbrain schema, 40,001 sealed pages
(src-a 30,001, src-b 10,000), `VACUUM ANALYZE`d, remote options
`{requireSafeChunks, excludePrivate, sourceId: 'src-a', limit: 50}`, end-to-end
`engine.searchTitles` median of 9 interleaved runs, base = `capy/fix-wave-7`
3ac9e5e0. No `enable_seqscan` forcing. Same slugs in the same order in every
case.

Server defaults (JIT on):

| case | query | before ms | after ms |
|---|---|---|---|
| rare (1 match) | `zorblax` | 490.9 | 33.6 |
| 2,000 matches | `globex` | 545.1 | 453.3 |
| 10,000 matches | `sync` | 572.9 | 468.8 |
| OR fallback (strict 0) | `zorblax weekly sync` | 1142.6 | 498.0 |
| 10,000 matches, no sourceId | `sync` | 634.2 | 527.5 |

JIT off (diagnostic):

| case | query | before ms | after ms |
|---|---|---|---|
| rare (1 match) | `zorblax` | 121.3 | 4.4 |
| 2,000 matches | `globex` | 128.5 | 19.0 |
| 10,000 matches | `sync` | 169.4 | 40.1 |
| OR fallback (strict 0) | `zorblax weekly sync` | 330.2 | 72.5 |
| 10,000 matches, no sourceId | `sync` | 251.3 | 73.7 |

The new predicate is no slower for any term, so it ships. With JIT on, about
500 ms of the remaining common-term time is JIT compilation (EXPLAIN ANALYZE for
`globex`: 17 ms execution, 504 ms JIT): the visibility subplans inflate the cost
estimate past `jit_above_cost`. Turning JIT off for the title arm is a separate,
unmeasured-in-production change and is not part of this wave.

## Cache key

`KNOBS_HASH_VERSION` 29 → 30 (one bump for this wave): the title arm order and
the remote predicate change rows for identical knobs.

## #5890: internal callers keep the full ranked set

With `search.adaptive_return` on, think's evidence gather was cut to 2 (entity)
or 6 (other) pages before synthesis. Gather already opted out of autocut; it
now also opts out of adaptive return, through one shared
`INTERNAL_BREADTH_SEARCH_OPTS` (`src/core/search/internal-breadth.ts`) that
brainstorm's close-set, grade-takes evidence, whoknows and enrich also pass.
`eval-contradictions/runner.ts` (wave 7's area) still inherits both trims.
