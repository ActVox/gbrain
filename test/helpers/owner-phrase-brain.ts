/**
 * Owner-phrase test corpus (docs/guides/owner-phrases.md): a small general
 * brain of account pages, people, dated team updates and call notes that
 * name accounts only by "<owner>'s <descriptor> account". Shared by the
 * PGLite DB test and the Postgres parity test so both engines run the same
 * rows. Placeholder names only.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { setCliOptions } from '../../src/core/cli-options.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { buildEntityCard } from '../../src/core/verbs/entity-card.ts';
import { privateLinkOriginFilterFragment, privatePagesFilterFragment } from '../../src/core/search/private-visibility.ts';
import type { PageType } from '../../src/core/types.ts';

export const ACME = 'companies/acme-example-freight';
export const NIMBUS = 'companies/nimbus-example-freight';
export const WIDGET = 'companies/widget-example-health';

export async function doc(engine: BrainEngine, slug: string, body: string, opts: { type?: string; date?: string; title?: string; private?: boolean } = {}): Promise<void> {
  const frontmatter: Record<string, unknown> = { ...(opts.date ? { date: opts.date } : {}), ...(opts.private ? { visibility: 'private' } : {}) };
  await importFromContent(engine, slug, serializeMarkdown(frontmatter, body, '', { type: (opts.type ?? 'note') as PageType, title: opts.title ?? slug, tags: [] }),
    { noEmbed: true, forceRechunk: true });
}

export async function seedOwnerPhraseBrain(engine: BrainEngine, opts: { enabled?: boolean } = {}): Promise<void> {
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
  if (opts.enabled !== false) await engine.setConfig('mentions.owner_phrases', 'true');
  await doc(engine, 'people/quill-example', 'Account manager.', { type: 'person', title: 'Quill Example' });
  await doc(engine, 'people/rowan-example', 'Account manager.', { type: 'person', title: 'Rowan Example' });
  await doc(engine, 'people/juniper-example', 'Account manager.', { type: 'person', title: 'Juniper Example' });
  await doc(engine, ACME, 'Segment: logistics', { type: 'company', title: 'Acme Example Freight' });
  await doc(engine, NIMBUS, 'Segment: logistics', { type: 'company', title: 'Nimbus Example Freight' });
  await doc(engine, WIDGET, 'Segment: benefits', { type: 'company', title: 'Widget Example Health' });
  // Advance handoff: Rowan's stint ends April 30, Quill's starts May 1.
  await doc(engine, 'updates/acme-handoff', 'From May 1, Quill Example takes over Acme Example Freight from Rowan Example.', { date: '2025-04-15' });
  await doc(engine, 'notes/rate-review', "Rowan's freight account asked for a rate review.", { date: '2025-04-20' });
  await doc(engine, 'notes/rate-followup', "Rowan's freight account asked again about the rate review.", { date: '2025-05-10' });
  await doc(engine, 'notes/renewal', "Quill's freight account renewed for two years.", { date: '2025-05-12' });
  // A second freight account: Juniper owns it, then hands it to Quill on June 1.
  await doc(engine, 'updates/nimbus-owner', 'Juniper Example owns Nimbus Example Freight.', { date: '2025-01-01' });
  await doc(engine, 'updates/nimbus-handoff', 'Nimbus Example Freight moves from Juniper Example to Quill Example on 2025-06-01.', { date: '2025-05-20' });
  await doc(engine, 'notes/escalation', "Quill's freight account escalated a missed pickup.", { date: '2025-07-01' });
  await doc(engine, 'notes/juniper-call', "Juniper's freight account asked about invoices.", { date: '2025-03-03' });
  // No page date: never linked.
  await doc(engine, 'notes/undated', "Quill's freight account wants a call.");
  // Evidence only on a private page: owner-trusted reads see the link, untrusted reads do not.
  await doc(engine, 'updates/widget-handoff', 'Widget Example Health moves from Rowan Example to Quill Example, effective February 1.', { date: '2025-01-25', private: true });
  await doc(engine, 'notes/benefits-call', "Quill's health account asked about billing.", { date: '2025-03-01' });
  // An agent-written page sets no window.
  await doc(engine, 'notes/agent-guess', 'Juniper Example owns Widget Example Health.', { type: 'agent-note', date: '2025-02-10' });
  await doc(engine, 'notes/juniper-health', "Juniper's health account sent a contract.", { date: '2025-03-05' });
}

export async function sweepOwnerPhrases(engine: BrainEngine) {
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
  const r = await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });
  return r.mentions?.ownerPhrases;
}

/** `doc -> account` for every owner-phrase link; `remote` applies the untrusted visibility predicate. */
export async function ownerPhraseLinks(engine: BrainEngine, remote = false): Promise<string[]> {
  const rows = await engine.executeRaw<{ f: string; t: string }>(
    `SELECT f.slug AS f, t.slug AS t FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_source = 'mentions' AND l.link_kind = 'owner_phrase'
      ${remote ? `AND ${privateLinkOriginFilterFragment('l')} AND ${privatePagesFilterFragment('f')} AND ${privatePagesFilterFragment('t')}` : ''}
      ORDER BY 1, 2`);
  return rows.map(r => `${r.f} -> ${r.t}`);
}

export async function windowRows(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ g: string; o: string; f: string | null; t: string | null; p: number | null }>(
    `SELECT group_key AS g, owner_name AS o, valid_from::text AS f, valid_to::text AS t, private_page_id AS p FROM owner_phrase_windows ORDER BY 1, 2, 3`);
  return rows.map(r => `${r.g} ${r.o} ${r.f ?? '?'}..${r.t ?? 'open'}${r.p == null ? '' : ' (private)'}`);
}

export async function ownerPhraseSnapshot(engine: BrainEngine) {
  const counters = await sweepOwnerPhrases(engine);
  const card = async (remote: boolean) => (await buildEntityCard(engine, 'default', 'Widget Example Health', { remote, includeReferences: true })).card?.known_as;
  const [status] = await engine.executeRaw<Record<string, unknown>>(
    'SELECT state, windows, links, documents, unresolved, ambiguous FROM owner_phrase_status WHERE source_id = $1', ['default']);
  return {
    counters: counters && { state: counters.state, links: counters.links, documents: counters.documents, unresolved: counters.unresolved, ambiguous: counters.ambiguous, windows: counters.windows },
    status: status && Object.fromEntries(Object.entries(status).map(([k, v]) => [k, typeof v === 'string' ? v : Number(v)])),
    trusted: await ownerPhraseLinks(engine),
    remote: await ownerPhraseLinks(engine, true),
    windows: await windowRows(engine),
    knownAsTrusted: (await card(false))?.rows.map(r => `${r.owner} ${r.from ?? '?'}..${r.to ?? 'open'}`),
    knownAsRemote: (await card(true))?.rows.map(r => `${r.owner} ${r.from ?? '?'}..${r.to ?? 'open'}`) ?? [],
  };
}

/**
 * Twelve dated stints on one account (more than the card's 10 `known_as` rows),
 * then the card and its `known_as.next` continuation followed to the end
 * through `get_backlinks`. Returns owners in served order per reader.
 */
export async function knownAsContinuation(engine: BrainEngine) {
  const { dispatchToolCall } = await import('../../src/mcp/dispatch.ts');
  const names = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Ginkgo', 'Hazel', 'Ivy', 'Kauri', 'Linden', 'Maple'];
  await doc(engine, 'companies/orbit-example-labs', 'Segment: research', { type: 'company', title: 'Orbit Example Labs' });
  await doc(engine, 'meetings/orbit-history', ['| Account | Owner | Start | End |', '|---|---|---|---|',
    ...names.map((n, i) => `| Orbit Example Labs | ${n} Example | ${2010 + i}-01-01 | ${2010 + i}-12-31 |`)].join('\n'), { date: '2024-01-05' });
  await doc(engine, 'notes/orbit-private', 'Orbit Example Labs moves from Maple Example to Quill Example, effective 2023-02-01.', { date: '2023-01-20', private: true });
  await sweepOwnerPhrases(engine);
  const config = { engine: 'pglite' };
  const local = { remote: false, sourceId: 'default', config };
  const remote = { remote: true, transport: 'stdio', sourceId: 'default', takesHoldersAllowList: ['world'], config };
  const call = async (op: string, args: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const r = await dispatchToolCall(engine, op, args, ctx as never);
    return r.isError ? { error: r.content[0]!.text } : JSON.parse(r.content[0]!.text);
  };
  const follow = async (ctx: Record<string, unknown>) => {
    const card = (await call('entity', { name: 'Orbit Example Labs' }, ctx)).card.known_as;
    const owners: string[] = card.rows.map((r: { owner: string }) => r.owner);
    const pages: number[] = [];
    let next = card.next?.arguments ? { ...card.next.arguments, limit: 1 } : null;
    while (next) {
      const page = await call('get_backlinks', next, ctx);
      pages.push(page.rows.length);
      owners.push(...page.rows.map((r: { owner: string }) => r.owner));
      next = page.cursor ? { ...next, cursor: page.cursor } : null;
    }
    const all = await call('get_backlinks', { slug: 'companies/orbit-example-labs', group: 'known_as', limit: 500 }, ctx);
    return { total: card.total, shown: card.rows.length, next: card.next ? { tool: card.next.tool, group: card.next.arguments.group, requires_surface: card.next.requires_surface ?? null } : null,
      followed: owners, pages, all: all.rows.map((r: { owner: string }) => r.owner), allTotal: all.total, truncated: all.truncated };
  };
  const verbs = (await call('entity', { name: 'Orbit Example Labs' }, { ...remote, surfaceCeiling: 'verbs' })).card.known_as.next?.requires_surface ?? null;
  const badCursor = await call('get_backlinks', { slug: 'companies/orbit-example-labs', group: 'known_as', cursor: 'nope' }, local);
  const withType = await call('get_backlinks', { slug: 'companies/orbit-example-labs', group: 'known_as', type: 'note' }, local);
  return { trusted: await follow(local), remote: await follow(remote), verbs, badCursor: 'error' in badCursor, withType: 'error' in withType };
}
