/**
 * Owner phrases, the stored pass on PGLite (docs/guides/owner-phrases.md):
 * migration, windows, linking inside and outside windows, ambiguity refusal,
 * visibility, corrections, deletion, enable/disable, concurrency, the policy
 * fingerprint and final-score invariance across every link-counting ranking
 * consumer.
 *
 * Protects: owner-phrase links stored as `link_source='mentions'`,
 * `link_kind='owner_phrase'` only while `mentions.owner_phrases` is on; a
 * window change alone relinking unedited documents; private-only evidence
 * never reaching untrusted reads (links and `known_as`); plain mention links,
 * policy fingerprints and final ranking scores unchanged by the key.
 * Regression: an owner phrase linked outside its window or to one of two
 * matching accounts, or an owner-phrase link that moves a search score.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { policyFingerprint } from '../src/core/mentions/pass.ts';
import { linkableTypesFor, loadSourcePack, readMentionPolicy } from '../src/core/mentions/policy.ts';
import { buildGazetteer } from '../src/core/by-mention.ts';
import { runOwnerPhrasePass } from '../src/core/mentions/owner-phrase/pass.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { entityAnchoredPages } from '../src/core/search/entity-anchor.ts';
import { applyGeneratedDemotion } from '../src/core/search/provenance-demotion.ts';
import type { SearchResult } from '../src/core/types.ts';
import { ACME, NIMBUS, WIDGET, doc, knownAsContinuation, ownerPhraseLinks, ownerPhraseSnapshot, seedOwnerPhraseBrain, sweepOwnerPhrases, windowRows } from './helpers/owner-phrase-brain.ts';

let engine: PGLiteEngine;
let snap: Awaited<ReturnType<typeof ownerPhraseSnapshot>>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedOwnerPhraseBrain(engine);
  snap = await ownerPhraseSnapshot(engine);
}, 180_000);
afterAll(async () => { await engine.disconnect(); });

const plainLinks = async () => (await engine.executeRaw<{ f: string; t: string; k: string | null }>(
  `SELECT f.slug AS f, t.slug AS t, l.link_kind AS k FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
    WHERE l.link_kind IS DISTINCT FROM 'owner_phrase' ORDER BY 1, 2, 3`)).map(r => `${r.f} -> ${r.t} ${r.k ?? ''}`);
const idOf = async (slug: string) => Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]))[0]!.id);

describe('migration', () => {
  test('the link_kind CHECK accepts owner_phrase and still refuses unknown kinds', async () => {
    const [a, b] = [await idOf('notes/undated'), await idOf(ACME)];
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source, link_kind) VALUES ($1, $2, 'probe', 'mentions', 'owner_phrase')`, [a, b]);
    await engine.executeRaw(`DELETE FROM links WHERE link_type = 'probe'`);
    await expect(engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source, link_kind) VALUES ($1, $2, 'probe', 'mentions', 'bogus')`, [a, b])).rejects.toThrow();
    const tables = (await engine.executeRaw<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_name LIKE 'owner_phrase_%' ORDER BY 1`)).map(r => r.t);
    expect(tables).toEqual(['owner_phrase_page_state', 'owner_phrase_status', 'owner_phrase_windows']);
  });
});

describe('windows and links', () => {
  test('windows: an advance handoff, an ongoing owner with an unknown start, private evidence marked', () => {
    expect(snap.windows).toEqual([
      `${ACME} Quill Example 2025-05-01..open`, `${ACME} Rowan Example ?..2025-04-30`,
      `${NIMBUS} Juniper Example ?..2025-05-31`, `${NIMBUS} Quill Example 2025-06-01..open`,
      `${WIDGET} Quill Example 2025-02-01..open (private)`, `${WIDGET} Rowan Example ?..2025-01-31 (private)`,
    ]);
  });

  test('a phrase links inside its owner window only; two matching accounts, no page date, an agent-only window and no owner never link', () => {
    expect(snap.trusted).toEqual([`notes/benefits-call -> ${WIDGET}`, `notes/juniper-call -> ${NIMBUS}`, `notes/rate-review -> ${ACME}`, `notes/renewal -> ${ACME}`]);
    for (const absent of ['notes/rate-followup', 'notes/escalation', 'notes/undated', 'notes/juniper-health']) expect(snap.trusted.join('\n')).not.toContain(absent);
  });

  test('the firing counter reports links, documents, unresolved and ambiguous phrases, and the status row matches', () => {
    expect(snap.counters).toEqual({ state: 'complete', links: 4, documents: 4, unresolved: 3, ambiguous: 1, windows: 6 });
    expect(snap.status).toEqual({ state: 'complete', windows: 6, links: 4, documents: 4, unresolved: 3, ambiguous: 1 });
  });

  test('visibility: a link whose only evidence is private, and its known_as window, are hidden from untrusted reads', () => {
    expect(snap.remote).toEqual(snap.trusted.filter(l => !l.startsWith('notes/benefits-call')));
    expect(snap.knownAsTrusted).toEqual(['Quill Example 2025-02-01..open', 'Rowan Example ?..2025-01-31']);
    expect(snap.knownAsRemote).toEqual([]);
  });

  test('owner-phrase links reach the card through referenced_by, and owner phrases never become aliases', async () => {
    const card = (await buildEntityCard(engine, 'default', 'Acme Example Freight', { remote: true, includeReferences: true })).card!;
    expect(card.referenced_by!.flatMap(g => g.rows.map(r => r.slug)).sort()).toEqual(['notes/rate-review', 'notes/renewal', 'updates/acme-handoff']);
    expect(card.known_as!.rows.map(r => r.owner)).toEqual(['Quill Example', 'Rowan Example']);
    expect(card.aka ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/freight account/i)]));
    const aliases = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_aliases WHERE alias_norm LIKE '%account%'`);
    expect(Number(aliases[0]!.n)).toBe(0);
  });

  test('a rerun with nothing changed writes nothing', async () => {
    const r = await sweepOwnerPhrases(engine);
    expect(r).toMatchObject({ state: 'complete', created: 0, removed: 0, links: 4 });
  });
});

describe('policy fingerprint', () => {
  test('the key off leaves every existing fingerprint unchanged; on changes it', async () => {
    const policy = await readMentionPolicy(engine);
    const types = ['company', 'person'];
    const legacy = createHash('sha256').update(JSON.stringify({
      types, crossSource: false, ignore: [...policy.ignore].map(n => n.toLowerCase()).sort(),
      aliasDeny: [...policy.aliasDeny].map(n => n.toLowerCase()).sort(), multiword: policy.multiwordAliases, siblings: policy.siblingMerge,
    })).digest('hex').slice(0, 16);
    expect(policyFingerprint(types, false, policy)).toBe(legacy);
    expect(policyFingerprint(types, false, policy, false)).toBe(legacy);
    expect(policyFingerprint(types, false, policy, true)).not.toBe(legacy);
  });
});

describe('final-score invariance', () => {
  async function readers() {
    const slugs = ['notes/rate-review', 'notes/renewal', 'notes/benefits-call', 'notes/juniper-call', 'notes/generated-summary', ACME, NIMBUS, WIDGET];
    const ids = await Promise.all(slugs.map(idOf));
    const bySlug = <V>(m: Map<number, V>) => Object.fromEntries(slugs.map((s, i) => [s, m.get(ids[i]!)]).filter(([, v]) => v !== undefined));
    const refs = ['notes/rate-review', ACME, NIMBUS, WIDGET].map(slug => ({ slug, source_id: 'default' }));
    const pool = (): SearchResult[] => [ids[4]!, ids[5]!].map((page_id, i) => ({ page_id, slug: i ? ACME : 'notes/generated-summary', score: 1 - i * 0.1 }) as unknown as SearchResult);
    const demoted = pool();
    await applyGeneratedDemotion(engine, demoted, 'Acme Example Freight renewal', { sourceId: 'default' });
    return {
      backlinks: bySlug(await engine.getBacklinkCounts(ids)),
      adjacency: bySlug(await engine.getAdjacencyBoosts(ids)),
      salience: [...(await engine.getSalienceScores(refs)).entries()].sort(),
      chain: (await engine.relationalChainHop([ids[5]!], { linkTypes: ['mentions'], toward: 'subject', subjectTypes: [], objectTypes: [], degreeLinkTypes: ['mentions'], neighborCap: 10 })).length,
      anchored: (await entityAnchoredPages(engine, 'default', ACME)).pages.map(p => p.slug).sort(),
      demotion: demoted.map(r => `${r.slug}:${r.score}`),
      plain: await plainLinks(),
    };
  }

  test('every link-counting consumer gives the same result with the key on and off, including threshold crossings', async () => {
    await doc(engine, 'notes/generated-summary', "Quill's freight account renewed; summary of the week.", { date: '2025-05-13' });
    await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"dream_generated": true}'::jsonb WHERE slug = 'notes/generated-summary'`);
    await sweepOwnerPhrases(engine);
    expect(await ownerPhraseLinks(engine)).toContain(`notes/generated-summary -> ${ACME}`);
    const on = await readers();
    // Threshold crossings a counted owner-phrase link would cause: a first backlink, a first adjacency hit, an anchored page, a demotion.
    expect(on.backlinks[ACME] ?? 0).toBe(0);
    expect(on.adjacency).toEqual({});
    expect(on.anchored).not.toContain('notes/rate-review');
    expect(on.demotion).toEqual(['notes/generated-summary:1', `${ACME}:0.9`]);

    await engine.setConfig('mentions.owner_phrases', 'false');
    const off = await sweepOwnerPhrases(engine);
    expect(off).toMatchObject({ state: 'off', removed: 5 });
    expect(await ownerPhraseLinks(engine)).toEqual([]);
    expect(await readers()).toEqual(on);
  });

  test('disable cleared windows, scans and status; re-enable restores the same links', async () => {
    expect(await windowRows(engine)).toEqual([]);
    const left = await engine.executeRaw<{ n: number }>('SELECT (SELECT count(*) FROM owner_phrase_page_state) + (SELECT count(*) FROM owner_phrase_status) AS n');
    expect(Number(left[0]!.n)).toBe(0);
    await engine.setConfig('mentions.owner_phrases', 'true');
    await sweepOwnerPhrases(engine);
    expect(await ownerPhraseLinks(engine)).toEqual([...snap.trusted, `notes/generated-summary -> ${ACME}`].sort());
  });
});

describe('known_as continuation', () => {
  test('rows < total carries a get_backlinks group:"known_as" next that continues the card in order to the end; private windows stay hidden from untrusted reads', async () => {
    const r = await knownAsContinuation(engine);
    const owners = ['Quill Example', 'Maple Example', 'Linden Example', 'Kauri Example', 'Ivy Example', 'Hazel Example', 'Ginkgo Example', 'Fir Example',
      'Dogwood Example', 'Elm Example', 'Cedar Example', 'Birch Example', 'Alder Example'];
    // 12 table stints, Quill's private takeover and Maple's private predecessor window ending the day before it.
    expect(r.trusted).toMatchObject({ total: 14, shown: 10, next: { tool: 'get_backlinks', group: 'known_as', requires_surface: null }, allTotal: 14, truncated: false });
    expect(r.trusted.all.slice(0, 3)).toEqual(['Quill Example', 'Maple Example', 'Maple Example']);
    expect(r.trusted.followed).toEqual(r.trusted.all);
    expect(r.trusted.pages).toEqual([1, 1, 1, 1]);
    expect(r.remote).toMatchObject({ total: 12, shown: 10, allTotal: 12 });
    expect(r.remote.followed).toEqual(r.remote.all);
    expect(r.remote.all).not.toContain('Quill Example');
    expect(new Set(r.trusted.all)).toEqual(new Set(owners));
    expect(r.verbs).toBe('starter');
    expect([r.badCursor, r.withType]).toEqual([true, true]);
  });
});

describe('invalidation', () => {
  test('a correction ends the wrong stint and relinks documents that were not edited; the generation advances', async () => {
    const before = Number((await engine.executeRaw<{ g: string }>('SELECT generation::text AS g FROM owner_phrase_status'))[0]!.g);
    await doc(engine, 'updates/acme-correction', 'Correction: Acme Example Freight went to Juniper Example, not Quill.', { date: '2025-04-17' });
    await sweepOwnerPhrases(engine);
    const links = await ownerPhraseLinks(engine);
    expect(links).not.toContain(`notes/renewal -> ${ACME}`);
    expect(links).toContain(`notes/rate-review -> ${ACME}`);
    expect(await windowRows(engine)).toContain(`${ACME} Juniper Example 2025-05-01..open`);
    expect(Number((await engine.executeRaw<{ g: string }>('SELECT generation::text AS g FROM owner_phrase_status'))[0]!.g)).toBe(before + 1);
  });

  test('deleting the only statement removes the windows and links it supported', async () => {
    await engine.softDeletePage('updates/acme-correction');
    await engine.softDeletePage('updates/acme-handoff');
    await sweepOwnerPhrases(engine);
    const links = await ownerPhraseLinks(engine);
    expect(links.filter(l => l.endsWith(ACME))).toEqual([]);
    expect((await windowRows(engine)).filter(w => w.startsWith(ACME))).toEqual([]);
  });

  test('two concurrent passes publish one consistent link set; a pass out of time stays pending and writes nothing', async () => {
    const policy = await readMentionPolicy(engine);
    const sequential = await ownerPhraseLinks(engine);
    await doc(engine, 'notes/new-call', "Juniper's freight account called about a claim.", { date: '2025-04-02' });
    const pack = await loadSourcePack(engine, 'default', { strict: true });
    const opts = { sourceId: 'default', gazetteer: await buildGazetteer(engine, { policy, strict: true }), types: linkableTypesFor(pack, policy), pack, policy, enabled: true };
    expect(await runOwnerPhrasePass(engine, { ...opts, deadline: Date.now() - 1 })).toMatchObject({ state: 'pending', created: 0, removed: 0 });
    expect(await ownerPhraseLinks(engine)).toEqual(sequential);
    const [a, b] = await Promise.all([runOwnerPhrasePass(engine, { ...opts, deadline: Infinity }), runOwnerPhrasePass(engine, { ...opts, deadline: Infinity })]);
    expect([a.state, b.state]).toEqual(['complete', 'complete']);
    expect(a.created + b.created).toBe(1);
    expect(await ownerPhraseLinks(engine)).toEqual([...sequential, `notes/new-call -> ${NIMBUS}`].sort());
  });
});
