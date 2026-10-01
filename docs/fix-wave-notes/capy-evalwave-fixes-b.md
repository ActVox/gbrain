# Eval-category wave, fix lane B (`capy/evalwave-fixes-b`)

Notes for folding into the fix wave 5 CHANGELOG (v0.60.28.0). No version bump
on this branch. Source reports: gbrain-evals `capy/wave-n9`
(`docs/benchmarks/2026-10-01-n9-multi-hop.md`, `2026-10-01-wave-bugs.md`) and
`capy/wave-n12-n13` (N12-7).

## What changed

- **N9-2, schema-pack frontmatter relations stored backwards.**
  `extractFrontmatterLinks` built every pack `frontmatter_links` mapping as
  outgoing. A pack mapping now takes its direction from the verb's
  `FRONTMATTER_LINK_MAP` counterpart for the same page type, so under
  `gbrain-base` (including brains with no `schema_pack`) company `investors`,
  `key_people` and `partner`, deal `investors` and `lead`, and meeting
  `attendees` are stored subject -> page (`people/bob-example ->
  companies/gamma-example`, `invested_in`). Verbs with no counterpart, such as
  company-brain's `owned_by`, stay outgoing. "Who invested in X?" now reaches
  frontmatter-derived investors.
- **N9-3 and N12-7, meeting attendance under shipped packs.** The page-type
  bound `attended` rule in `gbrain-base` and `company-brain` was returned before
  the canonical-attendance branch, so body attendance was stored meeting ->
  person and every person linked anywhere on a meeting page was typed attended
  (24 of 24 notes-only mentions in N12). That rule mirrors the in-code meeting
  prior, so meeting links now follow canonical, evidence-gated attendance
  (explicit attendee list only, person -> meeting) on the database, put_page,
  sweep and filesystem paths. A pack whose `attended` rule carries a phrase
  `regex` still decides attendance itself (`ownsAttendanceInference`), and
  historical attendance repair reports only those packs as
  `pack_semantics_preserved`; shipped base and company-brain meetings are now
  repairable to person -> meeting.
- **N9-4, "Who attended <meeting>?" never resolved its seed.** The relational
  arm's seed resolver only returns entity pages. For an incoming `attended`
  relation it now falls back to a live `meeting` or `event` page whose title is
  exactly the seed phrase (case-insensitive, unique in the source). Other
  relations never seed from titles. `resolveEntitySlugWithSource` itself is
  unchanged, so the gbrain-evals repro's direct resolver line still prints
  `fallback_slugify` while the arm fires.
- **N12-7 default-pack decision: tier 7 stays `gbrain-base`.** A brain with no
  `schema_pack` predates `gbrain init` writing one and carries the legacy
  24-type taxonomy; switching the fallback to `gbrain-base-v2` would change
  type inference, alias closure and enrichment without v2's reviewed
  `migration_from` retype step. The attendance and direction differences
  between the two packs are fixed in the extractor instead, so both store the
  same edges. Documented in `docs/architecture/schema-packs.md`.

## Re-deriving existing brains

A documented repair, not a migration. `LINK_EXTRACTOR_VERSION_TS` moves to
`2026-10-01T00:00:00Z`, so every page stamped before it is stale and the next
`gbrain extract --stale` (and the cycle's stale drain) re-derives its markdown
links: reversed body attendance and notes-only "attended" edges are replaced.
Frontmatter edges re-derive only with frontmatter included, so run once per
source:

```bash
gbrain extract links --source db --include-frontmatter --source-id <id>
```

Each page's own derived links (markdown, wikilink and frontmatter producers)
are replaced in one transaction per page; manual links and links other pages
created are untouched. The gated `--repair-attendance` preview/apply path also
now covers shipped-pack meetings. A schema migration was not used because the
repair needs the extractor (attendance evidence, the active pack, endpoint
types), a full-brain re-extraction inside `apply-migrations` would be slow on
large brains, and migrations are version-numbered while this lane carries no
version. Stamps written by pre-fix code after the new watermark read as fresh
(the accepted watermark limitation); the explicit command covers them.

Tested on PGLite and Postgres in `test/pack-relation-direction-engine.test.ts`
(pre-fix rows rewritten by `extract links --source db --include-frontmatter`,
and by `extract --stale` for pages stamped between the old and new watermark).

## Tests

- New: `test/pack-relation-direction.test.ts` (pure extraction across no pack,
  gbrain-base, company-brain, gbrain-base-v2) and
  `test/pack-relation-direction-engine.test.ts` (both engines: db extraction,
  put_page N12-7 shape, relational arm N9-4, title-seed scoping, both
  re-derivation paths). All failed before the fix.
- Updated to the new contract (each previously pinned pack-owned outgoing
  attendance under gbrain-base or company-brain): `attendance-retrieval`
  (per-source pack selection now discriminates with a phrase-owned fixture
  pack), `attendance-repair`, `link-inference-constraints`, `extract-db`,
  `extract-timeline-attendance`, `derived-link-reconciliation`,
  `links-attendance-blocked`, `extract-endpoint-revision`.
- Module-size ratchet raised: `src/commands/extract.ts` +2,
  `src/core/link-extraction.ts` +10.

## Eval before/after (copied overlays, fix-wave-5 head `31021a06` vs this branch)

See the lane report for the numbers; summary filled in below.
