# Owner phrases: "alice-example's freight account"

Company text often names an account by who owns it: "Alice's freight account",
"the health book Charlie handles". Which account that means depends on the date,
because accounts change hands. With owner phrases on, the mention index works
out each owner's validity window from ownership and handoff statements in page
text. It then links a document that uses an owner phrase to the account its
owner held on the document's date.

**Say to your agent:** *"Turn on owner-phrase linking so notes that say 'Alice's freight account' link to the right account."*
**Say to your agent:** *"Who owned the acme-example account in March, and which phrases point at it?"*

```bash
gbrain config set mentions.owner_phrases true   # off by default
gbrain extract --stale --catch-up                 # builds windows and links
gbrain entity "Acme Example Freight"              # the card lists known_as rows
```

`mentions.owner_phrases` takes effect when the mention pass runs: when a brain
or benchmark slot is built, or on the next `gbrain extract --stale`. A read-time
config change does nothing until the pass runs. When the key is on, it is part
of the mention policy fingerprint stored on each source's `mention_index_status`
row (and in slot receipts that copy it). When the key is off, the fingerprint
is the same as on a brain that never had the key. Turning it off removes every
owner-phrase link, window and page state on the next pass.

## What gets linked

A link is stored as an ordinary mention: `link_source='mentions'`,
`link_kind='owner_phrase'`, `link_type='mentions'`, with the phrase as written
in `context`. Ranking readers ignore mention links, so owner-phrase links never
change search scores. Graph traversal, `get_backlinks` and the entity card's
`referenced_by` see them the same way they see plain mentions. A page pair that
another link already connects gets no owner-phrase link. A plain mention found
later replaces the owner-phrase row.

## Resolution contract (v1, deterministic, no model calls)

The rules below are general to any brain. Each line is covered by a test row in
`test/owner-phrase-*.test.ts`.

1. **Inputs are kept apart.** Ownership statements come from one place, account
   descriptors from another and the document's date from a third. A statement
   never supplies a descriptor, and a phrase never creates a window.
2. **Ownership statements.** Sentences on any page type (not only entity pages)
   in the title, compiled truth or timeline. They have one of these forms:
   - takeover: "B takes over / inherits / picks up / assumes X", "X moves / is
     handed / is reassigned (from A) to B", "A hands X (off) to B", "B replaces A
     on X", "B is now / becomes the owner (lead, AE, CSM) for X";
   - join: "B joins X", "B has owned X since <date>". A join adds an owner
     without ending anyone else's stint;
   - ongoing: "B owns / runs / handles / covers / leads X", "B is the owner of
     X", "X is owned by B", "X is B's account", and on an account page the label
     lines `Owner:`, `Account owner:`, `Account lead:` and the same frontmatter
     keys;
   - end: "A rolls off / steps away from / leaves / is no longer on X", "A's
     last day on X is <date>";
   - stint: "A ran X from <date> to <date>", "A ran X until <date>";
   - tables whose header names an account column and an owner column, with
     optional start and end columns.

   X is an account: a linkable entity page that is not a person, named by its
   title or alias, by "the <descriptor> account" when exactly one account has
   that descriptor, or implicitly as the page itself on an account page.
   Negated sentences, questions and hypothetical sentences ("might", "if",
   "considering", "proposed") are not statements.
3. **Statement dates.** A date written in the sentence wins. Cue-led dates
   ("starting", "effective", "as of", "from", "on") come first, then the first
   date after the verb, then the last date before it. A day-month date without
   a year takes the year that puts it nearest the page date. With no date in
   the sentence, the statement takes the page's own date. Only a non-fallback
   page date counts (`effective_date_source` other than `fallback`). A relative
   date with no written date ("next week", "soon") makes the statement
   undated. An undated statement sets no window.
4. **Agent-written pages are not evidence.** Statements on a page whose type
   has the word `agent`, or whose frontmatter `author_kind`/`written_by` is
   `agent`, set no window. Owner phrases on those pages still resolve.
5. **Corrections void a stint.** A sentence with a correction cue
   ("correction", "was wrong", "actually", "not B", "rather than B", "instead
   of B") that names a wrong owner voids that owner's takeover, join or ongoing
   statements for the account, as recorded up to the correction. If it names the
   right owner, that owner takes over on the voided statement's date (or on
   the date the correction states). The previous owner's end is kept. A
   correction that names no account uses the page's only account.
6. **Window assembly.** Per identity group (an account page and its identity
   siblings, `mentions/siblings.ts`), statements are applied in date order.
   A takeover starts the new owner on day D and ends every other open stint
   (only the named predecessor's for "from A") on D−1. A predecessor named
   by "from A" who had no stint gets one ending on D−1, with an unknown
   start. An end statement ends the stint on its date. Bounds are inclusive
   calendar days. An open end runs until a later statement closes it. An
   ongoing statement on day D with no covering stint opens one with an
   unknown start. The window then begins the day after the latest earlier stint
   on the account ends, or has no lower bound. An ongoing statement that
   contradicts another owner's covering stint is ignored.
7. **Descriptors.** An account's descriptors are the words of its title and
   aliases (without corporate suffixes such as Inc, LLC, Co or Group), plus
   declared descriptors on the account page: "X is our <d> account", "known
   internally as the <d> account", and the `segment`, `industry`, `vertical`,
   `sector`, `category` and `descriptor` labels or frontmatter keys.
8. **Owner phrases.** "<Name>'s <d> account" (also book, client, customer,
   relationship, portfolio, book of business) and "the <d> account (that) <Name>
   runs / handles / owns / manages / covers / leads". The descriptor must be
   the whole run between the possessive and the noun. A plural noun, a name
   that is itself an account or company, and a sentence about personal or
   benefit accounts (benefits, HSA, FSA, 401k, payroll, bank, login, password)
   are not owner phrases. A one-word name matches an owner by first name, a
   longer name by the full name.
9. **Temporal candidates first, then ambiguity.** For the document's date, the
   candidates are windows whose owner matches, whose account has the
   descriptor and that cover the date. One identity group links. Two or more
   groups are ambiguous and refused. None is unresolved.
10. **Document dates and belated notes.** A document links only with a
    non-fallback page date. When the document also cites another date for
    itself, both readings must resolve to the same account or nothing links.
    The cited dates are a differing frontmatter `event_date` or `date`, a
    leading slug date, a `Date:`/`Sent:`/`Recorded:` label, or "notes from /
    recap of / written on <date>".
11. **Windows are stored apart.** Windows live in `owner_phrase_windows`, never
    in `page_aliases`, the `aka` list or search alias fan-out. Each row keeps
    its evidence (page, line, statement kind, date). Per-page scan results live
    in `owner_phrase_page_state`.
12. **Visibility.** A link whose window evidence includes a private page stores
    that page as `origin_page_id`. Remote and world-scope readers apply the
    link-origin privacy check and do not see the link. Trusted local reads do.
    `known_as` rows on the card follow the same rule.
13. **Invalidation.** A page is rescanned when its content revision or the
    owner-phrase version changes. Windows are rebuilt from every page's stored
    statements on each pass, and links are diffed against them. So a window
    change alone relinks exactly the documents it affects, and a deleted or
    edited evidence page withdraws its windows.

Every pass reports `links`, `documents`, `unresolved`, `ambiguous` and
`windows` under `mentions.owner_phrases` in `gbrain extract --stale --json`.
