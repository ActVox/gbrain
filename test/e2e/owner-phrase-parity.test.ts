/**
 * Owner phrases: PGLite and Postgres parity (docs/guides/owner-phrases.md).
 *
 * Protects: the v240 migration (link_kind CHECK accepting 'owner_phrase',
 * the windowed tables) and the owner-phrase pass producing the same windows,
 * links, counters, visibility and `known_as` rows on both engines, plus a
 * correction, a deletion, disable, and two passes racing over a real
 * connection pool on Postgres (the advisory lock serializes publication).
 * Regression: an engine-specific SQL difference in the jsonb batch writes,
 * the date casts or the visibility predicate.
 *
 * Gated by DATABASE_URL (skips without it); the PGLite half always runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { buildGazetteer } from '../../src/core/by-mention.ts';
import { linkableTypesFor, loadSourcePack, readMentionPolicy } from '../../src/core/mentions/policy.ts';
import { runOwnerPhrasePass } from '../../src/core/mentions/owner-phrase/pass.ts';
import { ACME, NIMBUS, doc, ownerPhraseLinks, ownerPhraseSnapshot, seedOwnerPhraseBrain, sweepOwnerPhrases, windowRows } from '../helpers/owner-phrase-brain.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const SKIP_PG = !hasDatabase();
const describeBoth = SKIP_PG ? describe.skip : describe;

async function lifecycle(engine: BrainEngine) {
  const policy = await readMentionPolicy(engine);
  const pack = await loadSourcePack(engine, 'default', { strict: true });
  const opts = { sourceId: 'default', gazetteer: await buildGazetteer(engine, { policy, strict: true }), types: linkableTypesFor(pack, policy), pack, policy, enabled: true, deadline: Infinity };
  await doc(engine, 'updates/acme-correction', 'Correction: Acme Example Freight went to Juniper Example, not Quill.', { date: '2025-04-17' });
  await sweepOwnerPhrases(engine);
  const corrected = { links: await ownerPhraseLinks(engine), windows: await windowRows(engine) };
  await doc(engine, 'notes/new-call', "Juniper's freight account called about a claim.", { date: '2025-04-02' });
  const raced = await Promise.all([runOwnerPhrasePass(engine, opts), runOwnerPhrasePass(engine, opts)]);
  const afterRace = await ownerPhraseLinks(engine);
  await engine.softDeletePage('updates/acme-correction');
  await engine.softDeletePage('updates/acme-handoff');
  await sweepOwnerPhrases(engine);
  const deleted = await ownerPhraseLinks(engine);
  await engine.setConfig('mentions.owner_phrases', 'false');
  const disabled = await sweepOwnerPhrases(engine);
  return { corrected, raced: raced.map(r => [r.state, r.created]).sort(), afterRace, deleted, disabled: { state: disabled?.state, links: await ownerPhraseLinks(engine), windows: await windowRows(engine) } };
}

async function checkConstraint(engine: BrainEngine) {
  const [[a], [b]] = await Promise.all(['notes/undated', ACME].map(s => engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [s])));
  const insert = (kind: string) => engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source, link_kind) VALUES ($1, $2, 'probe', 'mentions', $3)`, [a!.id, b!.id, kind]);
  await insert('owner_phrase');
  await engine.executeRaw(`DELETE FROM links WHERE link_type = 'probe'`);
  return insert('bogus').then(() => 'accepted', () => 'refused');
}

let pglite: PGLiteEngine;
let pgliteSnap: Awaited<ReturnType<typeof ownerPhraseSnapshot>>;
let pgliteLife: Awaited<ReturnType<typeof lifecycle>>;
beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  await seedOwnerPhraseBrain(pglite);
  pgliteSnap = await ownerPhraseSnapshot(pglite);
  pgliteLife = await lifecycle(pglite);
}, 180_000);
afterAll(async () => { await pglite.disconnect(); });

describe('owner phrases (PGLite half)', () => {
  test('links, correction, race, deletion and disable produce the expected rows', () => {
    expect(pgliteSnap.trusted).toHaveLength(4);
    expect(pgliteLife.corrected.links).not.toContain(`notes/renewal -> ${ACME}`);
    expect(pgliteLife.raced).toEqual([['complete', 0], ['complete', 1]]);
    expect(pgliteLife.afterRace).toContain(`notes/new-call -> ${NIMBUS}`);
    expect(pgliteLife.deleted.filter(l => l.endsWith(ACME))).toEqual([]);
    expect(pgliteLife.disabled).toEqual({ state: 'off', links: [], windows: [] });
  });
});

describeBoth('owner phrases (Postgres parity)', () => {
  let pg: BrainEngine;
  beforeAll(async () => { pg = await setupDB(); }, 180_000);
  afterAll(async () => { await teardownDB(); });

  test('the CHECK accepts owner_phrase and refuses unknown kinds', async () => {
    await seedOwnerPhraseBrain(pg);
    expect(await checkConstraint(pg)).toBe('refused');
  });

  test('windows, links, counters, visibility and known_as match PGLite', async () => {
    expect(await ownerPhraseSnapshot(pg)).toEqual(pgliteSnap);
  });

  test('correction, a pooled race, deletion and disable match PGLite', async () => {
    expect(await lifecycle(pg)).toEqual(pgliteLife);
  });
});
