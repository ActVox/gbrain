/**
 * LHF wave 2 item 9: paraphrased attendance questions reach relationship
 * retrieval. Only unambiguous forms are added ("were/was present at",
 * "was/were in the room for", "took part in", "participated in", "sat in on"
 * and the "participants" noun frame); broad verbs ("joined", "was at", "went
 * to") stay out, so employment, education and location wordings keep their
 * relation (or none). "took part in", "participated in" and "participants"
 * also name a funding round's investors, so a seed naming a round, series or
 * financing is not an attendance anchor.
 *
 * DEVELOPMENT phrasings written for this test; the held-out attendance set in
 * gbrain-evals is deliberately not mirrored. PGLite ($0) for the returned
 * evidence.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { parseRelationalQuery, type RelationalKind, type RelationDirection } from '../src/core/search/relational-intent.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildRelationalArm } from '../src/core/search/relational-recall.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

const ATTENDED: { kind: RelationalKind; linkTypes: string[]; direction: RelationDirection } = {
  kind: 'who_rel',
  linkTypes: ['attended'],
  direction: 'in',
};
const INVEST = ['invested_in', 'led_round'];

const FORMS: Array<[string, string]> = [
  ['Which people were present at Board Offsite?', 'Board Offsite'],
  ['who was present at the board offsite', 'board offsite'],
  ['Who was in the room for Board Offsite?', 'Board Offsite'],
  ['who were in the room for the board offsite?', 'board offsite'],
  ['Who took part in Board Offsite?', 'Board Offsite'],
  ['people who took part in the board offsite', 'board offsite'],
  ['who participated in Board Offsite', 'Board Offsite'],
  ['which people participated in the board offsite?', 'board offsite'],
  ['who sat in on Board Offsite?', 'Board Offsite'],
  ['List the participants of Board Offsite.', 'Board Offsite'],
  ['participants in the board offsite', 'board offsite'],
  ['who were the participants at Board Offsite?', 'Board Offsite'],
  ["Board Offsite's participants", 'Board Offsite'],
];

const UNCHANGED_ATTENDANCE: Array<[string, string]> = [
  ['Who attended Board Offsite?', 'Board Offsite'],
  ['attendees of the board offsite', 'board offsite'],
];

/** [query, the relation it must choose (link types), or null for no relational parse]. */
const COMPETING: Array<[string, string[] | null]> = [
  // employment
  ['who joined acme-example', null],
  ['who joined acme-example last year?', null],
  ['who works at acme-example', ['works_at']],
  ['who is part of acme-example?', null],
  ['which people are on the team at acme-example', ['works_at']],
  // investment wordings that share "participated in" / "took part in" / "participants"
  ['who participated in the seed round of acme-example', INVEST],
  ["who took part in acme-example's series a?", null],
  ['who participated in the seed round', null],
  ['participants in the acme-example financing', null],
  // education
  ['who studied at stanford-example', null],
  ['who went to stanford-example?', null],
  ['who graduated from stanford-example', null],
  ['alumni of stanford-example', null],
  // location
  ['who was at the berlin-example office', null],
  ['who lives in berlin-example?', null],
  ['who is based in berlin-example', null],
  ['who is present at the berlin-example office', null],
];

describe('attendance paraphrases: parser', () => {
  for (const [query, seed] of [...FORMS, ...UNCHANGED_ATTENDANCE]) {
    test(query, () => {
      const got = parseRelationalQuery(query);
      expect(got).not.toBeNull();
      expect({ kind: got!.kind, linkTypes: got!.linkTypes, direction: got!.direction }).toEqual(ATTENDED);
      expect(got!.seeds).toEqual([seed]);
    });
  }
});

describe('competing intents never route to attendance', () => {
  for (const [query, linkTypes] of COMPETING) {
    test(query, () => {
      const got = parseRelationalQuery(query);
      expect(got?.linkTypes ?? null).toEqual(linkTypes);
    });
  }
});

describe('returned evidence', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('meetings/board-offsite', { type: 'meeting', title: 'Board Offsite', compiled_truth: 'Quarterly offsite.', timeline: '' });
    await engine.putPage('companies/acme-example', { type: 'company', title: 'acme-example', compiled_truth: 'A robotics company.', timeline: '' });
    await engine.putPage('organizations/stanford-example', { type: 'organization', title: 'stanford-example', compiled_truth: 'A university.', timeline: '' });
    await engine.putPage('places/berlin-example', { type: 'place', title: 'berlin-example', compiled_truth: 'A city office.', timeline: '' });
    for (const person of ['alice-example', 'bob-example', 'carol-example']) {
      await engine.putPage(`people/${person}`, { type: 'person', title: person, compiled_truth: `${person} is a person.`, timeline: '' });
      await installFixtureChunks(engine, `people/${person}`, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `${person} is a person.` }]);
    }
    await engine.addLink('people/alice-example', 'meetings/board-offsite', '', 'attended', 'manual');
    await engine.addLink('people/bob-example', 'meetings/board-offsite', '', 'attended', 'manual');
    await engine.addLink('people/carol-example', 'companies/acme-example', '', 'works_at', 'manual');
    await engine.addLink('people/alice-example', 'companies/acme-example', '', 'attended', 'manual');
    await engine.addLink('people/bob-example', 'organizations/stanford-example', '', 'attended', 'manual');
    await engine.addLink('people/carol-example', 'places/berlin-example', '', 'attended', 'manual');
  }, 60_000);

  afterAll(async () => { await engine.disconnect(); });

  for (const [query] of FORMS) {
    test(`${query} -> the meeting's attendees through attended edges`, async () => {
      const rows = await buildRelationalArm(engine, query);
      expect(rows.map(r => r.slug).sort()).toEqual(['people/alice-example', 'people/bob-example']);
      for (const row of rows) {
        expect(row.relational_via_link_types).toEqual(['attended']);
        expect(row.relational_seed).toBe('meetings/board-offsite');
      }
    });
  }

  // The anchors carry stray attended edges, so a false attendance route would return them.
  for (const [query, linkTypes] of COMPETING.filter(([q]) => /acme-example|stanford-example|berlin-example/.test(q))) {
    test(`${query} -> no attendance evidence`, async () => {
      const rows = await buildRelationalArm(engine, query);
      expect(rows.filter(r => r.relational_via_link_types?.includes('attended'))).toEqual([]);
      if (linkTypes?.includes('works_at')) expect(rows.map(r => [r.slug, r.relational_via_link_types])).toEqual([['people/carol-example', ['works_at']]]);
      if (linkTypes === null) expect(rows).toEqual([]);
    });
  }
});
