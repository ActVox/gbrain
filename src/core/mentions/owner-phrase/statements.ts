/**
 * Owner phrases: ownership statements parsed from a page's cue lines against
 * the current entity names (contract lines 2-5). Pure: the caller supplies
 * the account and person name indexes built from the gazetteer.
 *
 * A sentence is normalized before matching: account names, person names and
 * dates become placeholders (`⟦A0⟧`, `⟦P0⟧`, `⟦D0⟧`) and the rest is lower-cased,
 * so one small grammar of takeover, join, ongoing, end, stint and correction
 * forms covers any account and any person.
 */

import { tokenizeForScan } from '../../by-mention.ts';
import { RELATIVE_DATE_RE, findDates, type FoundDate } from './dates.ts';
import { NAME_STOPWORDS, trimNameRun, type CueLine } from './scan.ts';

export type StatementKind = 'takeover' | 'join' | 'ongoing' | 'end' | 'stint' | 'correction';

export interface Statement {
  kind: StatementKind;
  /** The new, current or ending owner as written (null on a correction that names no right owner). */
  owner: string | null;
  /** The predecessor named by "from A" / "A hands X to B" / "B replaces A". */
  from?: string;
  /** The owner a correction says was wrong. */
  wrong?: string;
  account: string;
  /** Effective day: start for takeover/join, the day an ongoing statement holds, the last day for end. */
  date: string | null;
  /** For stints: the first and last day (either may be null). */
  start?: string | null;
  end?: string | null;
  /** The date was written in the sentence (not the page's own date). */
  stated: boolean;
  /** Recording page and line. */
  page_id: number;
  slug: string;
  /** The recording page's own date. */
  recorded: string | null;
  line: number;
  text: string;
}

export interface NameEntry { slug: string; title: string; tokens: string[]; caseTokens?: string[] }
/** Names keyed by lowercase first token, longest first within a bucket. */
export type NameIndex = Map<string, NameEntry[]>;

export function buildNameIndex(entries: NameEntry[]): NameIndex {
  const index: NameIndex = new Map();
  for (const e of entries) {
    if (!e.tokens.length) continue;
    const bucket = index.get(e.tokens[0]!) ?? [];
    bucket.push(e);
    index.set(e.tokens[0]!, bucket);
  }
  for (const bucket of index.values()) bucket.sort((a, b) => b.tokens.length - a.tokens.length || a.slug.localeCompare(b.slug));
  return index;
}

interface Span { start: number; end: number; kind: 'A' | 'P' | 'D'; value: string }

/** Every non-overlapping name of `index` in `text` (maximal munch), as character spans. */
export function findNames(text: string, index: NameIndex): Array<{ start: number; end: number; entry: NameEntry }> {
  const tokens = tokenizeForScan(text);
  const out: Array<{ start: number; end: number; entry: NameEntry }> = [];
  for (let i = 0; i < tokens.length;) {
    const bucket = index.get(tokens[i]!.text);
    let hit: NameEntry | undefined;
    if (bucket) {
      hit = bucket.find(e => e.tokens.length <= tokens.length - i && e.tokens.every((t, k) => tokens[i + k]!.text === t
        && (!e.caseTokens || text.slice(tokens[i + k]!.offset, tokens[i + k]!.offset + tokens[i + k]!.length).normalize('NFC') === e.caseTokens[k])));
    }
    if (!hit) { i++; continue; }
    const last = tokens[i + hit.tokens.length - 1]!;
    out.push({ start: tokens[i]!.offset, end: last.offset + last.length, entry: hit });
    i += hit.tokens.length;
  }
  return out;
}

export interface ParseContext {
  page: { id: number; slug: string; date: string | null; agent: boolean };
  /** The page's own slug when it is an account page. */
  selfAccount: string | null;
  accounts: NameIndex;
  persons: NameIndex;
  /** Descriptor → account slugs that have it (for "the <d> account"). */
  descriptorAccounts: Map<string, Set<string>>;
}

const RUN_RE = /[A-Z][a-zA-Z]+(?:[-'][A-Z][a-zA-Z]+)?(?: [A-Z][a-zA-Z]+(?:[-'][A-Z][a-zA-Z]+)?){0,2}/g;

function cleanLine(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]{1,3}/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
}

interface Normalized { n: string; accounts: string[]; persons: string[]; dates: FoundDate[]; datePos: number[] }

function normalize(sentence: string, ctx: ParseContext): Normalized {
  const spans: Span[] = [];
  const taken = (s: number, e: number) => spans.some(x => s < x.end && e > x.start);
  for (const m of findNames(sentence, ctx.accounts)) if (!taken(m.start, m.end)) spans.push({ start: m.start, end: m.end, kind: 'A', value: m.entry.slug });
  for (const d of findDates(sentence, ctx.page.date)) if (!taken(d.index, d.end)) spans.push({ start: d.index, end: d.end, kind: 'D', value: JSON.stringify(d) });
  for (const m of findNames(sentence, ctx.persons)) if (!taken(m.start, m.end)) spans.push({ start: m.start, end: m.end, kind: 'P', value: m.entry.title });
  for (const m of sentence.matchAll(RUN_RE)) {
    const raw = m[0];
    const trimmed = trimNameRun(raw);
    if (!trimmed) continue;
    const start = m.index! + raw.indexOf(trimmed);
    const end = start + trimmed.length;
    if (taken(start, end)) continue;
    if (trimmed.split(' ').every(w => NAME_STOPWORDS.has(w.toLowerCase()))) continue;
    spans.push({ start, end, kind: 'P', value: trimmed });
  }
  spans.sort((a, b) => a.start - b.start);
  const accounts: string[] = [];
  const persons: string[] = [];
  const dates: FoundDate[] = [];
  const datePos: number[] = [];
  let n = '';
  let at = 0;
  for (const s of spans) {
    n += sentence.slice(at, s.start).toLowerCase();
    if (s.kind === 'A') { n += `⟦A${accounts.length}⟧`; accounts.push(s.value); }
    else if (s.kind === 'P') { n += `⟦P${persons.length}⟧`; persons.push(s.value); }
    else { datePos.push(n.length); n += `⟦D${dates.length}⟧`; dates.push(JSON.parse(s.value) as FoundDate); }
    at = s.end;
  }
  n += sentence.slice(at).toLowerCase();
  n = n.replace(/\s+/g, ' ').trim();
  // "the <descriptor> account" names an account when exactly one account has that descriptor.
  n = n.replace(/\bthe ([a-z][a-z0-9&-]*(?: [a-z][a-z0-9&-]*)?) (account|relationship|client|customer|book)\b/g, (whole, d: string) => {
    const owners = ctx.descriptorAccounts.get(d);
    if (!owners || owners.size !== 1) return whole;
    accounts.push([...owners][0]!);
    return `⟦A${accounts.length - 1}⟧`;
  });
  if (ctx.selfAccount) {
    n = n.replace(/\b(?:this|our|the) (?:account|relationship|client|customer)\b(?! ⟦)/g, () => {
      accounts.push(ctx.selfAccount!);
      return `⟦A${accounts.length - 1}⟧`;
    });
  }
  // Recompute date placeholder positions after the substitutions.
  datePos.length = 0;
  for (const m of n.matchAll(/⟦D(\d+)⟧/g)) datePos[Number(m[1])] = m.index!;
  return { n, accounts, persons, dates, datePos };
}

const P = (g: string) => `⟦P(?<${g}>\\d+)⟧`;
const D = (g: string) => `⟦D(?<${g}>\\d+)⟧`;
const ACC_CORE = `(?:the |this |our )?⟦A(?<acc>\\d+)⟧(?:'s)?(?: (?:account|relationship|book|client|customer|portfolio))?`;
const ROLE = '(?:account )?(?:owner|lead|manager|executive|ae|csm|rep|representative|point person|point|primary contact|am)';
const FROM = `(?: from ${P('from')})?`;
const ADV = '(?:(?:actually|officially|formally|also|already|effectively) )?';

interface Pattern { kind: StatementKind; re: RegExp; reSelf: RegExp }

function pattern(kind: StatementKind, template: string): Pattern {
  const build = (acc: string) => new RegExp(template.replaceAll('{ACC}', acc).replaceAll('{O} ', `${P('o')} ${ADV}`).replaceAll('{O}', P('o')).replaceAll('{F}', P('from'))
    .replaceAll('{FROM}', FROM).replaceAll('{ROLE}', ROLE).replaceAll('{D1}', D('d1')).replaceAll('{D2}', D('d2')));
  // Sentences are matched with a leading space, so a pattern may open with the account. An account-first
  // pattern never takes the page itself implicitly: its subject must be written.
  const re = build(` ${ACC_CORE}`);
  return { kind, re, reSelf: template.startsWith('{ACC}') ? re : build(`(?: ${ACC_CORE})?`) };
}

const PATTERNS: Pattern[] = [
  pattern('stint', `{O} (?:ran|owned|managed|handled|covered|led|was on|had|ran point on|worked)(?: on)?{ACC},? (?:from|between) {D1} ?(?:to|until|through|thru|and|-|–|—) ?{D2}`),
  pattern('stint', `{O} (?:ran|owned|managed|handled|covered|led|was on|had|worked)(?: on)?{ACC},? (?:until|through|thru|till) {D2}`),
  pattern('join', `{O} (?:has |have |had )?(?:owned|run|handled|managed|covered|led|been on|been running|been the {ROLE} (?:for|on|of))(?: the)?{ACC} since {D1}`),
  pattern('takeover', `{O} (?:will |is going to |is set to |is slated to |is about to |is scheduled to )?(?:officially )?(?:take|takes|took|taking|is taking|has taken|have taken|will be taking) over(?: as (?:the )?(?:new )?{ROLE}(?: (?:of|for|on))?| ownership of| responsibility for| coverage of)?{ACC}{FROM}`),
  pattern('takeover', `{O} (?:will |is going to )?(?:inherits?|inherited|picks? up|picked up|is picking up|assumes?|assumed|is assuming)(?: ownership of| responsibility for| coverage of)?{ACC}{FROM}`),
  pattern('takeover', `{ACC} (?:is |was |has been |will be |gets |got |is being |are )?(?:officially )?(?:re)?(?:assigned|handed off|handed over|handed|passed|passes|transferred|transfers|moved|moving|moves|transitioned|transitioning|transitions|goes|went|going|switches|switched|shifts|shifted)(?: over| across)?(?: from ${P('from')})? to {O}`),
  pattern('takeover', `{F} (?:will |is going to )?(?:hands|hand|handed|is handing|has handed|passes|pass|passed|is passing|transfers|transfer|transferred|is transferring|is transitioning|transitions|transitioned)(?: off| over)?{ACC}(?: off| over)? to {O}`),
  pattern('takeover', `(?:moving|handing|passing|transferring|reassigning|assigning|transitioning|giving)(?: off| over)?{ACC}(?: over)?(?: from ${P('from')})? to {O}`),
  pattern('takeover', `{O} (?:replaces|replaced|is replacing|will replace) {F}(?: as (?:the )?{ROLE})? (?:on|for)${' '}${ACC_CORE}`),
  pattern('takeover', `{O} (?:is now|now is|becomes|became|will become|has become|is becoming|will be|is taking over as) (?:the )?(?:new )?{ROLE} (?:for|on|of|over)${' '}${ACC_CORE}`),
  pattern('takeover', `{ACC} (?:is now|now is|becomes|became|will become|will now be) ${P('o')}'s(?: account)?`),
  pattern('takeover', `{ACC} (?:is now|will now be|will be) (?:owned|run|handled|managed|covered|led) by {O}`),
  pattern('takeover', `{O} now (?:owns|runs|handles|manages|covers|leads){ACC}`),
  pattern('takeover', `{O} (?:will|is going to|is set to) (?:now )?(?:own|run|handle|cover|lead|manage)(?: the)?{ACC}`),
  pattern('join', `{O} (?:started|starts|is starting|will start|began|begins|will begin)(?: on| with| covering| working on)?(?: the)?{ACC}`),
  pattern('join', `{O} (?:joins|joined|is joining|will join)(?: the)?{ACC}`),
  pattern('join', `{O} (?:co-owns|will co-own|is co-owning|also covers|will also cover|is also covering)(?: the)?{ACC}`),
  pattern('end', `{O} (?:rolls|roll|rolled|is rolling|will roll|rolling) off{ACC}`),
  pattern('end', `{O} (?:steps|step|stepped|is stepping|will step) (?:away|back|down|off)(?: from)?{ACC}`),
  pattern('end', `{O} (?:is|was|will be|are) no longer (?:on|covering|handling|running|managing|leading|responsible for|working on|owning|the {ROLE} (?:for|on|of))(?: the)?{ACC}`),
  pattern('end', `{O}(?:'s)? last day (?:on|with|for|covering|running|handling){ACC} (?:is|was|will be) {D2}`),
  pattern('end', `{O} (?:leaves|left|is leaving|will leave){ACC}`),
  pattern('end', `{O} (?:hands|handed|is handing|will hand|has handed) off{ACC}(?! (?:off |over )?to )`),
  pattern('ongoing', `{O} (?:owns|runs|handles|manages|covers|leads|is running|is handling|is managing|is covering|is leading|is on|still owns|still runs|still handles|still covers|has run|has owned|has handled|has covered|has led|has managed|has had|has)(?: the)?{ACC}`),
  pattern('ongoing', `{O} is (?:the |our )?{ROLE} (?:for|on|of|over)${' '}${ACC_CORE}`),
  pattern('ongoing', `{ACC} is (?:owned|run|handled|managed|covered|led|looked after) by {O}`),
  pattern('ongoing', `{ACC} is ${P('o')}'s(?: account)?`),
  pattern('ongoing', `{ACC} (?:account )?(?:owner|lead|manager|ae|csm|rep) is {O}`),
];

const LABEL_RE = new RegExp(`^(?:(?:the )?⟦A(?<acc>\\d+)⟧ )?(?<prev>previous |former |prior |past )?(?:account |primary |current )?(?:owner|lead|manager|ae|csm|rep|am|account owner|account lead|account manager)s?(?: \\(.*?\\))? ?[:=–-] ?${P('o')}`);
const HANDOFF_LABEL_RE = new RegExp(`\\b(?:outgoing|previous|old|former)(?: owner)?:? ${P('from')},? (?:and |→ |-> )?(?:incoming|new)(?: owner)?:? ${P('o')}`);
const NEGATION_RE = /\b(?:not|never)\b|n't\b/;
const HYPOTHETICAL_RE = /\b(?:might|may|could|would|should|if|whether|considering|consider|proposal|proposed|propose|proposing|maybe|perhaps|tentatively|possibly|potentially|thinking about|plan to|planning to|plans to|hope to|hoping to|want to|wants to|suggest|suggested|suggesting|recommend|recommended|option)\b/;
const CORRECTION_RE = /\b(?:correction|correcting|to correct|clarification|to clarify|misspoke|was wrong|were wrong|was incorrect|is incorrect|was a mistake|in error|by mistake|mistakenly|erroneously|actually|retract(?:ing|ed)?|disregard)\b|(?:^|,|—|–|\(| -| and) ?not (?:to )?⟦P|rather than ⟦P|instead of ⟦P/;
const WRONG_RES = [/(?:\bnot|rather than|instead of) (?:to )?⟦P(\d+)⟧/g, /⟦P(\d+)⟧ (?:did not|didn't|does not|doesn't|never|will not|won't|is not|isn't|was not|wasn't)\b/g];
const CUE_LED_RE = /(?:starting|effective|as of|beginning|begins|starts|from|on|effective on|effective as of)(?: on)? $/;

function splitSentences(line: string): string[] {
  return line.split(/(?<=[.!?])\s+(?=[A-Z"'(\[⟦]|$)/).map(s => s.trim()).filter(Boolean);
}

const START_CUE_RE = /(?:since|starting|beginning|effective|effective as of|as of|from)(?: on)? $/;

function chooseDate(norm: Normalized, matchStart: number): { date: FoundDate; start: boolean } | null {
  const all = norm.dates.map((d, i) => ({ d, i, pos: norm.datePos[i] ?? -1 })).filter(x => x.pos >= 0);
  if (!all.length) return null;
  const before = (x: { pos: number }) => norm.n.slice(Math.max(0, x.pos - 24), x.pos);
  const cue = all.filter(x => CUE_LED_RE.test(before(x)));
  const pick = (xs: typeof all) => xs.find(x => x.pos >= matchStart) ?? xs[xs.length - 1];
  const chosen = (cue.length ? pick(cue) : all.find(x => x.pos >= matchStart) ?? all[all.length - 1])!;
  return { date: chosen.d, start: START_CUE_RE.test(before(chosen)) };
}

function tableRows(lines: CueLine[]): Array<{ line: number; cells: Record<string, string>; pairs: string[] }> {
  const out: Array<{ line: number; cells: Record<string, string>; pairs: string[] }> = [];
  let header: string[] | null = null;
  let prev = -2;
  for (const l of lines) {
    if (!l.text.trimStart().startsWith('|')) { header = null; continue; }
    const cells = l.text.trim().replace(/^\||\|$/g, '').split('|').map(c => cleanLine(c).trim());
    if (l.line !== prev + 1) header = null;
    prev = l.line;
    if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    if (!header) { header = cells.map(c => c.toLowerCase()); continue; }
    const record: Record<string, string> = {};
    header.forEach((h, i) => { record[h] = cells[i] ?? ''; });
    out.push({ line: l.line, cells: record, pairs: header.length === 2 ? [`${cells[0] ?? ''}: ${cells[1] ?? ''}`] : [] });
  }
  return out;
}

function col(cells: Record<string, string>, re: RegExp): string | undefined {
  const key = Object.keys(cells).find(k => re.test(k));
  return key === undefined ? undefined : cells[key];
}

/** Every ownership statement on one page (agent-written pages return none). */
export function parseStatements(cues: CueLine[], ctx: ParseContext): Statement[] {
  if (ctx.page.agent) return [];
  const out: Statement[] = [];
  const base = { page_id: ctx.page.id, slug: ctx.page.slug, recorded: ctx.page.date };
  const sentences: Array<{ line: number; text: string; label: boolean }> = [];
  for (const row of tableRows(cues)) {
    if (row.pairs.length) { for (const p of row.pairs) sentences.push({ line: row.line, text: p, label: true }); continue; }
    const account = col(row.cells, /^(?:account|client|customer|company|account name|name)$/);
    const owner = col(row.cells, /\b(?:owner|lead|ae|csm|manager|rep|am)\b/);
    const incoming = col(row.cells, /^(?:incoming|incoming owner|new owner)$/);
    if (!owner && incoming) {
      const outgoing = col(row.cells, /^(?:outgoing|outgoing owner|previous owner|old owner)$/);
      const when = col(row.cells, /^(?:effective|effective date|date|as of|start|start date)$/);
      const acctSlug = account ? findNames(account, ctx.accounts)[0]?.entry.slug : ctx.selfAccount;
      const person = (cell: string | undefined) => (cell && !/^\(.*\)$/.test(cell)
        ? findNames(cell, ctx.persons)[0]?.entry.title ?? cell.match(RUN_RE)?.map(trimNameRun).find(Boolean) : undefined);
      const to = person(incoming);
      const date = when ? findDates(when, ctx.page.date)[0]?.iso ?? null : null;
      if (!acctSlug || !to) continue;
      const from = person(outgoing);
      out.push({ ...base, kind: 'takeover', owner: to, ...(from ? { from } : {}), account: acctSlug, date: date ?? ctx.page.date, stated: !!date,
        line: row.line, text: Object.values(row.cells).join(' | ') });
      continue;
    }
    if (!owner) continue;
    const startCell = col(row.cells, /^(?:start|start date|from|since|began|effective|effective date|owner since)$/);
    const endCell = col(row.cells, /^(?:end|end date|until|to|through|ended)$/);
    const acctSlug = account ? findNames(account, ctx.accounts)[0]?.entry.slug : ctx.selfAccount;
    const person = findNames(owner, ctx.persons)[0]?.entry.title ?? owner.match(RUN_RE)?.map(trimNameRun).find(Boolean);
    if (!acctSlug || !person) continue;
    const start = startCell ? findDates(startCell, ctx.page.date)[0]?.iso ?? null : null;
    const endDate = endCell ? findDates(endCell, ctx.page.date)[0] : undefined;
    const end = endDate ? endDate.last : null;
    const text = Object.values(row.cells).join(' | ');
    if (start && end) out.push({ ...base, kind: 'stint', owner: person, account: acctSlug, date: start, start, end, stated: true, line: row.line, text });
    else if (start) out.push({ ...base, kind: 'takeover', owner: person, account: acctSlug, date: start, stated: true, line: row.line, text });
    else if (end) out.push({ ...base, kind: 'stint', owner: person, account: acctSlug, date: end, start: null, end, stated: true, line: row.line, text });
    else if (ctx.page.date) out.push({ ...base, kind: 'ongoing', owner: person, account: acctSlug, date: ctx.page.date, stated: false, line: row.line, text });
  }
  const pageAccounts = new Set<string>();
  for (const l of cues) {
    if (l.text.trimStart().startsWith('|')) continue;
    for (const s of splitSentences(speakerFirstPerson(cleanLine(l.text)))) sentences.push({ line: l.line, text: s, label: false });
    for (const m of findNames(l.text, ctx.accounts)) pageAccounts.add(m.entry.slug);
  }
  const context = ctx.selfAccount ?? (pageAccounts.size === 1 ? [...pageAccounts][0]! : null);
  for (const s of sentences) {
    const lineAccounts = [...new Set(findNames(cues.find(c => c.line === s.line)?.text ?? '', ctx.accounts).map(m => m.entry.slug))];
    out.push(...parseSentence(s.text, s.line, ctx, lineAccounts.length === 1 ? lineAccounts[0]! : context));
  }
  return out;
}

const SPEAKER_RE = /^\s*(?:\[[^\]]*\]\s*)?([A-Z][a-zA-Z]+(?:[-'][A-Z][a-zA-Z]+)?(?: [A-Z][a-zA-Z]+(?:[-'][A-Z][a-zA-Z]+)?){0,2}):\s+(.*)$/;

/** A chat line "[time] Name: I'm taking X" speaks for Name: its first-person subject becomes the speaker. */
function speakerFirstPerson(line: string): string {
  const m = SPEAKER_RE.exec(line);
  if (!m) return line;
  const speaker = trimNameRun(m[1]!);
  if (!speaker || speaker !== m[1]) return line;
  const text = m[2]!;
  if (!/(?:^|[.!?,;]\s+)I(?:'m|'ll|'ve| am| will| have| was|\b)/.test(text)) return line;
  return text
    .replace(/(^|[.!?,;]\s+)I'm\b/g, `$1${speaker} is`).replace(/(^|[.!?,;]\s+)I am\b/g, `$1${speaker} is`)
    .replace(/(^|[.!?,;]\s+)I'll\b/g, `$1${speaker} will`).replace(/(^|[.!?,;]\s+)I've\b/g, `$1${speaker} has`)
    .replace(/(^|[.!?,;]\s+)I\b/g, `$1${speaker}`);
}

function parseSentence(sentence: string, line: number, ctx: ParseContext, context: string | null): Statement[] {
  if (sentence.endsWith('?')) return [];
  const norm = normalize(sentence, ctx);
  const { n } = norm;
  if (!n.includes('⟦P')) return [];
  if (!NEGATION_RE.test(n) && !HYPOTHETICAL_RE.test(n)) {
    const handoff = HANDOFF_LABEL_RE.exec(n);
    const account = /⟦A(\d+)⟧/.exec(n)?.[1];
    const target = account !== undefined ? norm.accounts[Number(account)]! : context;
    if (handoff?.groups && target) {
      const chosen = chooseDate(norm, handoff.index);
      return [{ page_id: ctx.page.id, slug: ctx.page.slug, recorded: ctx.page.date, line, text: sentence, kind: 'takeover',
        owner: norm.persons[Number(handoff.groups.o)]!, from: norm.persons[Number(handoff.groups.from)]!, account: target,
        date: chosen ? chosen.date.iso : RELATIVE_DATE_RE.test(sentence) ? null : ctx.page.date, stated: !!chosen }];
    }
  }
  const real = matchSentence(norm, sentence, line, ctx, context);
  if (real.length || norm.persons.length < 2) return real;
  // An account with no page still holds its owner's phrases: a multi-word name in the account position becomes a
  // page-less account (`pseudo:<name>`) that only competes in ambiguity (contract line 9) and never receives a link.
  const pseudo: Statement[] = [];
  norm.persons.forEach((name, k) => {
    if (!name.includes(' ') || k > 3) return;
    const variant: Normalized = { ...norm, accounts: [...norm.accounts, `pseudo:${name.toLowerCase()}`],
      n: norm.n.replaceAll(`⟦P${k}⟧`, `⟦A${norm.accounts.length}⟧`) };
    for (const s of matchSentence(variant, sentence, line, { ...ctx, selfAccount: null }, null)) if (s.owner !== name && s.kind !== 'correction') pseudo.push(s);
  });
  return pseudo;
}

function matchSentence(norm: Normalized, sentence: string, line: number, ctx: ParseContext, context: string | null): Statement[] {
  const { n } = norm;
  const base = { page_id: ctx.page.id, slug: ctx.page.slug, recorded: ctx.page.date, line, text: sentence };
  const accountOf = (g: string | undefined) => (g === undefined ? ctx.selfAccount : norm.accounts[Number(g)] ?? null);
  const undated = RELATIVE_DATE_RE.test(sentence);
  const dated = (found: { date: FoundDate } | null): { date: string | null; stated: boolean } =>
    found ? { date: found.date.iso, stated: true } : { date: undated ? null : ctx.page.date, stated: false };

  const wrong = new Set<number>();
  if (CORRECTION_RE.test(n)) for (const re of WRONG_RES) for (const m of n.matchAll(re)) wrong.add(Number(m[1]));
  if (wrong.size) {
    const right = norm.persons.findIndex((_, i) => !wrong.has(i));
    const acc = /⟦A(\d+)⟧/.exec(n)?.[1];
    const account = acc !== undefined ? norm.accounts[Number(acc)]! : context;
    if (!account) return [{ ...base, kind: 'correction', owner: right >= 0 ? norm.persons[right]! : null, wrong: norm.persons[[...wrong][0]!]!, account: '', ...dated(chooseDate(norm, 0)) }];
    return [...wrong].map(w => ({ ...base, kind: 'correction' as const, owner: right >= 0 ? norm.persons[right]! : null, wrong: norm.persons[w]!, account,
      ...dated(chooseDate(norm, 0)) }));
  }
  if (NEGATION_RE.test(n) || HYPOTHETICAL_RE.test(n)) return [];

  const label = LABEL_RE.exec(n);
  if (label?.groups) {
    const account = accountOf(label.groups.acc);
    if (!account) return [];
    const owner = norm.persons[Number(label.groups.o)]!;
    const rest = n.slice(label.index + label[0].length);
    const restDates = [...rest.matchAll(/⟦D(\d+)⟧/g)].map(m => norm.dates[Number(m[1])]!);
    const sinceCue = /\b(?:since|from|starting|as of|effective)\b/.test(rest);
    const untilCue = /\b(?:until|through|thru|till|to)\b/.test(rest);
    if (restDates.length >= 2) return [{ ...base, kind: 'stint', owner, account, date: restDates[0]!.iso, start: restDates[0]!.iso, end: restDates[1]!.last, stated: true }];
    if (restDates.length === 1 && (untilCue || label.groups.prev)) return [{ ...base, kind: 'stint', owner, account, date: restDates[0]!.last, start: null, end: restDates[0]!.last, stated: true }];
    if (label.groups.prev) return [];
    if (restDates.length === 1 && sinceCue) return [{ ...base, kind: 'takeover', owner, account, date: restDates[0]!.iso, stated: true }];
    return [{ ...base, kind: 'ongoing', owner, account, ...dated(null) }];
  }

  const out: Statement[] = [];
  const used: Array<[number, number]> = [];
  for (const p of PATTERNS) {
    const re = ctx.selfAccount ? p.reSelf : p.re;
    for (const m of ` ${n}`.matchAll(new RegExp(re.source, 'g'))) {
      const s = Math.max(0, m.index! - 1);
      const e = s + m[0].length;
      if (used.some(([a, b]) => s < b && e > a)) continue;
      const g = m.groups ?? {};
      const account = accountOf(g.acc);
      if (!account || g.o === undefined) continue;
      used.push([s, e]);
      const owner = norm.persons[Number(g.o)]!;
      const from = g.from !== undefined ? norm.persons[Number(g.from)] : undefined;
      const d1 = g.d1 !== undefined ? norm.dates[Number(g.d1)]! : null;
      const d2 = g.d2 !== undefined ? norm.dates[Number(g.d2)]! : null;
      if (p.kind === 'stint') {
        out.push({ ...base, kind: 'stint', owner, account, date: d1?.iso ?? d2!.last, start: d1?.iso ?? null, end: d2!.last, stated: true });
        continue;
      }
      if (p.kind === 'join' && d1) { out.push({ ...base, kind: 'join', owner, account, date: d1.iso, stated: true }); continue; }
      if (p.kind === 'end' && d2) { out.push({ ...base, kind: 'end', owner, account, date: d2.last, stated: true }); continue; }
      const chosen = chooseDate(norm, s);
      const when = dated(chosen);
      // An ongoing statement with a start cue ("as of", "since", "effective") dates the start of the stint.
      const kind = p.kind === 'ongoing' && chosen?.start ? 'join' : p.kind;
      out.push({ ...base, kind, owner, ...(from && from !== owner ? { from } : {}), account, ...when });
    }
  }
  return out;
}
