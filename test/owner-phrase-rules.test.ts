/**
 * Owner phrases, the pure rules (docs/guides/owner-phrases.md, contract lines
 * 1-10): page scan, statement grammar, window assembly and phrase resolution.
 * One test row per contract line, on a general (non-contract) corpus of
 * team updates, tickets, chat and notes.
 *
 * Protects: handoffs ending the predecessor the day before, inclusive bounds,
 * advance announcements, overlapping and open-ended stints, unknown starts,
 * corrections voiding a stint, temporal filtering before ambiguity, refusal
 * of two accounts sharing a descriptor, a phrase with no owner, non-owner and
 * personal possessives, fallback page dates, belated notes whose readings
 * disagree, agent-written pages and page-less accounts. Regression: a parser
 * that links a phrase outside its owner's window, or that links when two
 * accounts match.
 */
import { describe, expect, test } from 'bun:test';
import { tokenizeTitle } from '../src/core/by-mention.ts';
import { findDates } from '../src/core/mentions/owner-phrase/dates.ts';
import { scanPage, type ScanInput } from '../src/core/mentions/owner-phrase/scan.ts';
import { buildNameIndex, parseStatements, type Statement } from '../src/core/mentions/owner-phrase/statements.ts';
import { accountDescriptors, buildWindows, descriptorMatches, ownerMatches, resolvePhrase, type OwnerWindow } from '../src/core/mentions/owner-phrase/windows.ts';

const ACCOUNTS = ['Acme Example Freight', 'Widget Example Health', 'Orbit Example Labs', 'Nimbus Example Freight'];
const slugOf = (t: string) => `companies/${t.toLowerCase().replace(/ /g, '-')}`;
const accounts = buildNameIndex(ACCOUNTS.map(t => ({ slug: slugOf(t), title: t, tokens: tokenizeTitle(t) })));
const persons = buildNameIndex([{ slug: 'people/rowan-example', title: 'Rowan Example', tokens: tokenizeTitle('Rowan Example') }]);
const descriptorSets = new Map(ACCOUNTS.map(t => [slugOf(t), accountDescriptors([t], [])]));
const descriptorAccounts = new Map<string, Set<string>>();
for (const [slug, set] of descriptorSets) for (const d of set) descriptorAccounts.set(d, new Set([...(descriptorAccounts.get(d) ?? []), slug]));
const descriptorsOf = (g: string) => descriptorSets.get(g) ?? accountDescriptors([g.replace(/^pseudo:/, '')], []);

let nextId = 1;
function page(slug: string, body: string, opts: Partial<ScanInput> & { date?: string | null } = {}) {
  const input: ScanInput = { slug, type: opts.type ?? 'note', title: opts.title ?? slug, compiled_truth: body, timeline: '', frontmatter: opts.frontmatter ?? {},
    effective_date: opts.date === undefined ? '2025-03-10' : opts.date, effective_date_source: opts.date === null ? 'fallback' : 'date' };
  return { slug, id: nextId++, scan: scanPage(input) };
}
function statementsOf(p: ReturnType<typeof page>, selfAccount: string | null = null): Statement[] {
  return parseStatements(p.scan.cues, { page: { id: p.id, slug: p.slug, date: p.scan.date, agent: p.scan.agent }, selfAccount, accounts, persons, descriptorAccounts });
}
const brief = (s: Statement[]) => s.map(x => [x.kind, x.owner, x.from ?? null, x.account, x.date]);
const windowsOf = (...pages: Array<ReturnType<typeof page> | [ReturnType<typeof page>, string]>) =>
  buildWindows(pages.flatMap(p => Array.isArray(p) ? statementsOf(p[0], p[1]) : statementsOf(p)), s => s);
const span = (w: OwnerWindow[]) => w.map(x => `${x.group.split('/')[1]} ${x.owner} ${x.from ?? '?'}..${x.to ?? 'open'}${x.startKnown ? '' : ' (start unknown)'}`).sort();
const resolve = (w: OwnerWindow[], owner: string, descriptor: string, date: string | null, readings: string[] = []) =>
  resolvePhrase({ owner, descriptor }, date, readings, w, descriptorsOf);

describe('line 1-3: scan, statements and dates are separate inputs', () => {
  test('a page scan keeps cue lines, owner phrases and its own date; a fallback date is no date', () => {
    const p = page('notes/n1', "Quill Example takes over Acme Example Freight from Rowan Example on April 1.\nQuill's freight account wants a rate review.");
    expect(p.scan.date).toBe('2025-03-10');
    expect(p.scan.cues.map(c => c.line)).toEqual([1]);
    expect(p.scan.hits).toEqual([{ owner: 'Quill', descriptor: 'freight', noun: 'account', line: 2, surface: "Quill's freight account" }]);
    expect(page('notes/n2', 'x', { date: null }).scan.date).toBeNull();
  });

  test('owner phrase forms: possessive, book, full name, "the X account Y runs"; plural and personal accounts are not phrases', () => {
    const hits = page('notes/n3', [
      "Ask about Quill Example's freight account.", "Rowan's health book is quiet.", 'The labs account Quill handles renewed.',
      "Quill's freight accounts are busy.", "Rowan's health account at the benefits portal needs a login.",
    ].join('\n')).scan.hits.map(h => `${h.owner}/${h.descriptor}/${h.noun}`);
    expect(hits).toEqual(['Quill Example/freight/account', 'Rowan/health/book', 'Quill/labs/account']);
  });

  test('dates: ISO, written, month-only and year-less dates take the nearest year', () => {
    expect(findDates('on 2025-04-01, April 2, 2025, 3 May 2025, and March 2025', null).map(d => [d.iso, d.last]))
      .toEqual([['2025-04-01', '2025-04-01'], ['2025-04-02', '2025-04-02'], ['2025-05-03', '2025-05-03'], ['2025-03-01', '2025-03-31']]);
    expect(findDates('starting January 5', '2024-12-20')[0]!.iso).toBe('2025-01-05');
  });
});

describe('line 2: the statement grammar', () => {
  test('takeover forms name the new owner, the predecessor and the date', () => {
    const p = page('updates/u1', [
      'Starting April 1, Quill Example takes over Acme Example Freight from Rowan Example.',
      'Widget Example Health moves from Rowan Example to Quill Example, effective March 1.',
      'Rowan Example hands Orbit Example Labs to Quill Example on 2025-05-01.',
    ].join('\n'));
    expect(brief(statementsOf(p))).toEqual([
      ['takeover', 'Quill Example', 'Rowan Example', slugOf('Acme Example Freight'), '2025-04-01'],
      ['takeover', 'Quill Example', 'Rowan Example', slugOf('Widget Example Health'), '2025-03-01'],
      ['takeover', 'Quill Example', 'Rowan Example', slugOf('Orbit Example Labs'), '2025-05-01'],
    ]);
  });

  test('ongoing, join, end and stint forms; a start cue dates the start', () => {
    const p = page('updates/u2', [
      'Quill Example owns Acme Example Freight.',
      'Rowan Example owns the Widget Example Health relationship as of February 1.',
      'Quill Example started on Orbit Example Labs on June 15.',
      'Rowan Example rolls off Orbit Example Labs on 2025-06-30.',
      'Rowan Example ran Nimbus Example Freight from 2024-01-01 to 2024-12-31.',
    ].join('\n'));
    expect(brief(statementsOf(p))).toEqual([
      ['ongoing', 'Quill Example', null, slugOf('Acme Example Freight'), '2025-03-10'],
      ['join', 'Rowan Example', null, slugOf('Widget Example Health'), '2025-02-01'],
      ['join', 'Quill Example', null, slugOf('Orbit Example Labs'), '2025-06-15'],
      ['end', 'Rowan Example', null, slugOf('Orbit Example Labs'), '2025-06-30'],
      ['stint', 'Rowan Example', null, slugOf('Nimbus Example Freight'), '2024-01-01'],
    ]);
  });

  test('negated, hypothetical, questioned and relative-dated sentences set nothing', () => {
    const p = page('notes/n4', [
      'Quill Example did not take over Acme Example Freight.',
      'Quill Example might take over Acme Example Freight.',
      'Will Quill Example take over Acme Example Freight?',
      'Next week Quill Example takes over Acme Example Freight.',
    ].join('\n'));
    const s = statementsOf(p);
    expect(s.filter(x => x.date)).toEqual([]);
  });

  test('labels and tables: an account page label, an owner table and a handoff table', () => {
    const acct = page(slugOf('Acme Example Freight'), 'Account owner: Quill Example (since 2025-01-15)\nSegment: logistics', { type: 'company' });
    expect(brief(statementsOf(acct, slugOf('Acme Example Freight')))).toEqual([['takeover', 'Quill Example', null, slugOf('Acme Example Freight'), '2025-01-15']]);
    expect(acct.scan.descriptors).toEqual(['logistics']);
    const table = page('meetings/m1', [
      '| Account | Owner | Start | End |', '|---|---|---|---|', '| Orbit Example Labs | Rowan Example | 2024-02-01 | 2024-09-30 |', '',
      '| Account | Outgoing | Incoming | Effective |', '|---|---|---|---|', '| Widget Example Health | Rowan Example | Quill Example | 2025-04-01 |',
    ].join('\n'));
    expect(brief(statementsOf(table))).toEqual([
      ['stint', 'Rowan Example', null, slugOf('Orbit Example Labs'), '2024-02-01'],
      ['takeover', 'Quill Example', 'Rowan Example', slugOf('Widget Example Health'), '2025-04-01'],
    ]);
  });

  test('a chat speaker speaks for the first person; a ticket owner label on a non-account page is not an account owner', () => {
    const chat = page('chat/c1', "[09:14] Quill Example: I'm picking up Acme Example Freight starting today", { type: 'chat' });
    expect(brief(statementsOf(chat))).toEqual([['takeover', 'Quill Example', null, slugOf('Acme Example Freight'), '2025-03-10']]);
    expect(statementsOf(page('tickets/t1', 'Owner: Rowan Example\nCustomer: Acme Example Freight', { type: 'ticket' }))).toEqual([]);
  });

  test('line 4: an agent-written page sets no window; its owner phrases still scan', () => {
    const p = page('notes/agent-1', "Quill Example owns Orbit Example Labs. Quill's labs account is fine.", { type: 'agent-note' });
    expect(p.scan.agent).toBe(true);
    expect(statementsOf(p)).toEqual([]);
    expect(p.scan.hits.length).toBe(1);
  });
});

describe('lines 5-6: window assembly', () => {
  test('a handoff ends the predecessor the day before; an advance announcement works; bounds are inclusive', () => {
    const w = windowsOf(page('mail/a', 'From May 1, Quill Example takes over Acme Example Freight from Rowan Example.', { date: '2025-04-15' }));
    expect(span(w)).toEqual(['acme-example-freight quill example 2025-05-01..open', 'acme-example-freight rowan example ?..2025-04-30 (start unknown)']);
    expect(resolve(w, 'Rowan', 'freight', '2025-04-30')).toMatchObject({ linked: true });
    expect(resolve(w, 'Rowan', 'freight', '2025-05-01')).toMatchObject({ linked: false, reason: 'outside_window' });
    expect(resolve(w, 'Quill', 'freight', '2025-05-01')).toMatchObject({ linked: true });
    expect(resolve(w, 'Quill', 'freight', '2025-04-30')).toMatchObject({ linked: false, reason: 'outside_window' });
  });

  test('a join overlaps; an explicit end closes on its own day; an open stint runs on', () => {
    const w = windowsOf(
      [page(slugOf('Orbit Example Labs'), 'Account manager: Rowan Example, 2024-06-01 to 2025-06-30.', { type: 'company' }), slugOf('Orbit Example Labs')],
      page('notes/b', 'Quill Example started on Orbit Example Labs on June 15.', { date: '2025-07-08' }));
    expect(span(w)).toEqual(['orbit-example-labs quill example 2025-06-15..open', 'orbit-example-labs rowan example 2024-06-01..2025-06-30']);
  });

  test('an ongoing statement with no start opens after the latest earlier stint; a contradicting one is ignored', () => {
    const w = windowsOf(
      page('notes/c1', 'Rowan Example ran Acme Example Freight from 2024-01-01 to 2024-06-30.', { date: '2024-07-01' }),
      page('notes/c2', 'Quill Example owns Acme Example Freight.', { date: '2024-09-01' }),
      page('notes/c3', 'Rowan Example handles Acme Example Freight.', { date: '2024-10-01' }));
    expect(span(w)).toEqual(['acme-example-freight quill example 2024-07-01..open (start unknown)', 'acme-example-freight rowan example 2024-01-01..2024-06-30']);
  });

  test('line 5: a correction voids the wrong stint and starts the right owner on its date; mentions between both dates do not link to the wrong owner', () => {
    const w = windowsOf(
      page('mail/h', 'Widget Example Health moves from Rowan Example to Quill Example, effective March 1.', { date: '2025-03-03' }),
      page('mail/c', 'Correction: Widget Example Health went to Orbit Person, not Quill. Thanks.', { date: '2025-03-07' }));
    expect(span(w)).toEqual(['widget-example-health orbit person 2025-03-01..open', 'widget-example-health rowan example ?..2025-02-28 (start unknown)']);
    expect(resolve(w, 'Quill', 'health', '2025-03-05')).toMatchObject({ linked: false, reason: 'no_owner' });
    expect(resolve(w, 'Orbit', 'health', '2025-03-05')).toMatchObject({ linked: true });
  });

  test('identity groups merge stints named on sibling pages', () => {
    const groups = new Map([[slugOf('Acme Example Freight'), 'g'], [slugOf('Nimbus Example Freight'), 'g']]);
    const w = buildWindows([
      ...statementsOf(page('a', 'Quill Example takes over Acme Example Freight on 2025-01-01.')),
      ...statementsOf(page('b', 'Quill Example rolls off Nimbus Example Freight on 2025-02-01.')),
    ], s => groups.get(s) ?? s);
    expect(w.map(x => [x.group, x.from, x.to, x.accounts])).toEqual([['g', '2025-01-01', '2025-02-01', [slugOf('Acme Example Freight'), slugOf('Nimbus Example Freight')]]]);
  });
});

describe('lines 7-10: resolution', () => {
  test('descriptors are name words without suffixes plus declared ones', () => {
    expect([...accountDescriptors(['CRM record: Acme Example Freight Inc'], ['logistics'])].sort()).toEqual(['acme', 'example', 'freight', 'logistics']);
  });

  test('a descriptor run of up to three words matches when it is one descriptor or every word is a descriptor word; labels count after a sentence boundary', () => {
    const set = new Set(['freight', 'north america', 'emea']);
    expect(descriptorMatches(set, 'freight')).toBe(true);
    expect(descriptorMatches(set, 'emea freight')).toBe(true);
    expect(descriptorMatches(set, 'north america freight')).toBe(true);
    expect(descriptorMatches(set, 'new freight')).toBe(false);
    expect(descriptorMatches(set, 'america')).toBe(false);
    const acct = page(slugOf('Orbit Example Labs'), 'Account: Orbit Example Labs. Industry: robotics. Region: EMEA.', { type: 'company' });
    expect(acct.scan.descriptors).toEqual(['emea', 'robotics']);
    expect(page('notes/n5', "Quill Example's North America robotics account renewed.").scan.hits.map(h => h.descriptor)).toEqual(['north america robotics']);
  });

  test('owner matching: one word matches a first name, two words the full name', () => {
    expect(ownerMatches('Quill', { owner: 'quill example' })).toBe(true);
    expect(ownerMatches('Quill Example', { owner: 'quill example' })).toBe(true);
    expect(ownerMatches('Quill Other', { owner: 'quill example' })).toBe(false);
  });

  test('temporal candidates first, then ambiguity: two freight accounts are ambiguous only once one owner holds both', () => {
    const w = windowsOf(
      page('a', 'Quill Example takes over Acme Example Freight on 2025-01-01.'),
      page('b', 'Rowan Example owns Nimbus Example Freight.', { date: '2025-01-01' }),
      page('c', 'Nimbus Example Freight moves from Rowan Example to Quill Example on 2025-06-01.'));
    expect(resolve(w, 'Quill', 'freight', '2025-03-01')).toMatchObject({ linked: true, group: slugOf('Acme Example Freight') });
    expect(resolve(w, 'Quill', 'freight', '2025-07-01')).toMatchObject({ linked: false, reason: 'ambiguous' });
    expect(resolve(w, 'Quill', 'acme', '2025-07-01')).toMatchObject({ linked: true, group: slugOf('Acme Example Freight') });
  });

  test('a phrase with no owner, a non-owner possessive and no page date never link', () => {
    const w = windowsOf(page('a', 'Quill Example takes over Acme Example Freight on 2025-01-01.'));
    expect(resolve(w, 'Juniper', 'freight', '2025-03-01')).toMatchObject({ linked: false, reason: 'no_owner' });
    expect(resolve(w, 'Quill', 'robotics', '2025-03-01')).toMatchObject({ linked: false, reason: 'no_owner' });
    expect(resolve(w, 'Quill', 'freight', null)).toMatchObject({ linked: false, reason: 'no_page_date' });
  });

  test('line 10: a belated note links only when both readings agree', () => {
    const w = windowsOf(page('a', 'Starting 2025-05-01, Quill Example takes over Acme Example Freight from Rowan Example.'));
    const note = page('notes/belated', "Belated note on the April 20 call: Rowan's freight account asked for a refund.", { date: '2025-05-10' });
    expect(note.scan.readings).toEqual(['2025-04-20']);
    expect(resolve(w, 'Rowan', 'freight', note.scan.date, note.scan.readings)).toMatchObject({ linked: false, reason: 'outside_window' });
    expect(resolve(w, 'Quill', 'freight', note.scan.date, note.scan.readings)).toMatchObject({ linked: false, reason: 'readings_disagree' });
    expect(resolve(w, 'Quill', 'freight', '2025-05-10', ['2025-05-03'])).toMatchObject({ linked: true });
  });

  test('a page-less account still competes for its owner\'s phrases and is never a link target', () => {
    const w = windowsOf(
      page('a', 'Quill Example owns Acme Example Freight.', { date: '2025-01-01' }),
      page('b', 'As of July 1, Quill Example will own Harbor Placeholder Freight in addition to her current book.', { date: '2025-06-20' }));
    expect(w.map(x => x.group).sort()).toEqual([slugOf('Acme Example Freight'), 'pseudo:harbor placeholder freight']);
    expect(resolve(w, 'Quill', 'freight', '2025-03-01')).toMatchObject({ linked: true, group: slugOf('Acme Example Freight') });
    expect(resolve(w, 'Quill', 'freight', '2025-08-01')).toMatchObject({ linked: false, reason: 'ambiguous' });
  });
});
