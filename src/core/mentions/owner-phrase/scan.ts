/**
 * Owner phrases, the per-page scan. Gazetteer-independent and pure: what a
 * page's own text says, stored per content revision in
 * `owner_phrase_page_state` and parsed against the current gazetteer when
 * windows are built (`statements.ts`), so a new entity page never forces a
 * rescan of every page.
 *
 * A scan keeps four things:
 *   - cue lines: lines that may hold an ownership statement (a cue verb or
 *     role noun, a correction cue, or a table whose header names an owner
 *     column), with their 1-based line number;
 *   - descriptor declarations the page makes about itself ("X is our freight
 *     account", `Segment: freight`), used only if the page is an account;
 *   - owner phrases ("Alice's freight account", "the freight book Alice
 *     runs") with the owner surface, descriptor and line;
 *   - the page's date readings: its own non-fallback date plus any other date
 *     the page cites for itself (contract line 10).
 */

import { findDates, dayOf } from './dates.ts';

/** Bump to rescan every page's owner-phrase state once (scanner behavior change). */
export const OWNER_PHRASE_SCAN_VERSION = 1;

export interface CueLine { line: number; text: string }
export interface PhraseHit { owner: string; descriptor: string; noun: string; line: number; surface: string }
export interface PageScan {
  cues: CueLine[];
  descriptors: string[];
  hits: PhraseHit[];
  /** The page's own date (non-fallback) or null. */
  date: string | null;
  /** Other dates the page cites for itself, each different from `date`. */
  readings: string[];
  /** Statements on this page set no window (agent-written page). */
  agent: boolean;
}

export interface ScanInput {
  slug: string;
  type: string | null;
  title: string | null;
  compiled_truth: string | null;
  timeline: string | null;
  frontmatter: Record<string, unknown> | null;
  effective_date: unknown;
  effective_date_source: string | null;
}

const CUE_RE = /\b(?:owns?|owned|owner|owners|ownership|runs?|ran|running|handles?|handled|handling|manages?|managed|managing|manager|covers?|covered|covering|coverage|leads?|led|leading|takes? over|took over|taking over|taken over|hands?|handed|handing|hand-?off|handover|pass(?:es|ed)?|passing|transfer(?:s|red|ring)?|(?:re)?assign(?:s|ed|ing)?|moves?|moved|moving|transition(?:s|ed|ing)?|inherit(?:s|ed)?|picks? up|picked up|assumes?|assumed|replac(?:es|ed|ing)|roll(?:s|ed|ing)? off|step(?:s|ped|ping)? (?:away|back|down|off)|no longer|last day|joins?|joined|joining|since|until|through|correction|correcting|clarification|actually|rather than|instead of|misspoke|mistake|wrong|incorrect|ae|csm|rep|point person|goes to|went to|book)\b/i;
const OWNER_COLUMN_RE = /\b(?:owner|lead|ae|csm|manager|rep|am)\b/i;
const AGENT_TYPE_RE = /(?:^|[-_\s/])agent(?:$|[-_\s/])/i;

/** Personal and benefit accounts: a sentence about them holds no owner phrase (contract line 8). */
export const PERSONAL_ACCOUNT_RE = /\b(?:benefits?|hsa|fsa|401\(?k\)?|payroll|pension|retirement|savings|checking|bank|banking|login|log-in|password|username|e-?mail account|expense account|personal|reimbursements?|open enrollment|enrollment)\b/i;

const NAME = String.raw`[A-Z][a-zA-Z]+(?:[-'][A-Z][a-zA-Z]+)?`;
const NAME_RUN = String.raw`${NAME}(?: ${NAME}){0,2}`;
const DESC = String.raw`[A-Za-z][A-Za-z0-9&-]*(?: [A-Za-z][A-Za-z0-9&-]*)?`;
const NOUN = '(?:book of business|account|book|client|customer|relationship|portfolio)';
const POSSESSIVE_RE = new RegExp(String.raw`(?<![\w'’])(${NAME_RUN})['’]s (${DESC}) (${NOUN})(?![\w-])`, 'g');
const RUNS_RE = new RegExp(String.raw`\b[Tt]he (${DESC}) (account|book|client|customer|relationship) (?:that |which )?(${NAME_RUN}) (?:runs|handles|owns|manages|covers|leads|looks after|is running|is handling|is managing|is covering|is leading|has been running|runs point on)\b`, 'g');

/** Capitalized words that open sentences or labels and never name a person. */
export const NAME_STOPWORDS: ReadonlySet<string> = new Set(`a an the this that these those it its we our us i you your he she they their his her him them
  hi hello hey thanks thank dear please note notes update updates correction clarification fyi re fwd subject from to cc bcc date sent
  starting effective as on in at by for with after before since until through beginning also and but so then now today tomorrow yesterday
  next last per owner owners account accounts lead team status summary recap action item items agenda attendees meeting call ticket project
  handoff handover transition background context decision decisions belated actually going heads quick just reminder welcome congrats
  mr ms mrs dr csm ae am vp ceo cto cfo coo sales ops support customer success q1 q2 q3 q4 effective monday tuesday wednesday thursday
  friday saturday sunday january february march april may june july august september october november december jan feb mar apr jun jul aug
  sep sept oct nov dec yes no ok okay good great sure all any each every some none who what when where why how if while because
  following followup follow welcome hope best regards cheers new old previous current former incoming outgoing primary`.split(/\s+/).filter(Boolean));

/** Leading and trailing stop words of a capitalized run removed; empty when nothing is left. */
export function trimNameRun(run: string): string {
  const words = run.split(' ');
  while (words.length && NAME_STOPWORDS.has(words[0]!.toLowerCase())) words.shift();
  while (words.length && NAME_STOPWORDS.has(words[words.length - 1]!.toLowerCase())) words.pop();
  return words.join(' ');
}

function isAgentAuthored(type: string | null, fm: Record<string, unknown>): boolean {
  if (type && AGENT_TYPE_RE.test(type)) return true;
  for (const key of ['author_kind', 'written_by', 'author_type']) {
    const v = fm[key];
    if (typeof v === 'string' && v.trim().toLowerCase() === 'agent') return true;
  }
  return false;
}

const DESCRIPTOR_LABEL_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:segment|industry|vertical|sector|category|line of business|business line|descriptor)(?:\*\*)?\s*:\s*(?:\*\*)?([^|;,.()]+)/i;
const DESCRIPTOR_DECL_RES = [
  /\b(?:is|as) (?:our|the|a|an) ((?:[a-z][a-z0-9&-]*)(?: [a-z][a-z0-9&-]*)?) (?:account|client|customer)\b/gi,
  /\bknown (?:internally )?as the ((?:[a-z][a-z0-9&-]*)(?: [a-z][a-z0-9&-]*)?) (?:account|client|customer|book)\b/gi,
  /\b(?:we|everyone|people|the team) calls? (?:it|them|this) the ((?:[a-z][a-z0-9&-]*)(?: [a-z][a-z0-9&-]*)?) (?:account|client|customer|book)\b/gi,
];
const DESCRIPTOR_FILLER = new Set(['main', 'primary', 'key', 'big', 'biggest', 'largest', 'top', 'new', 'old', 'first', 'only', 'best', 'oldest',
  'newest', 'own', 'other', 'strategic', 'favorite', 'favourite', 'current', 'former', 'next', 'last', 'same', 'whole', 'entire']);

function cleanDescriptor(raw: string): string | null {
  const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  while (words.length && DESCRIPTOR_FILLER.has(words[0]!)) words.shift();
  if (!words.length || words.length > 2) return null;
  return words.join(' ');
}

function frontmatterDescriptors(fm: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['segment', 'industry', 'vertical', 'sector', 'category', 'descriptor', 'line_of_business']) {
    const v = fm[key];
    for (const item of Array.isArray(v) ? v : [v]) {
      if (typeof item !== 'string') continue;
      const d = cleanDescriptor(item.split(/[,;/]/)[0] ?? '');
      if (d) out.push(d);
    }
  }
  return out;
}

const OWNER_FRONTMATTER_KEYS = ['owner', 'account_owner', 'account_lead', 'account_manager', 'csm', 'ae'];

const READING_LABEL_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:date|sent|recorded|written|meeting date|call date|date of (?:call|meeting|visit))(?:\*\*)?\s*:/i;
const READING_PHRASE_RE = /\b(?:notes?|recap|summary|minutes|write-?up|debrief)(?: from| of| for| on)(?: the| our| my| this)?(?: \w+)?(?: call| meeting| sync| visit| review| session)?(?: on| from| of)? *$|\b(?:written|recorded|logged|filed)(?: up)?(?: on| late on)? *$/i;
const EVENT_REF_BEFORE_RE = /\b(?:the|our|that) *$/i;
const READING_TAIL_RE = /^(?:'s)? ?(?:call|meeting|sync|visit|review|session|check-in|discussion)\b/i;

/** Other dates the page cites for itself (contract line 10), each different from `date`. */
function citedReadings(slug: string, fm: Record<string, unknown>, lines: string[], date: string | null): string[] {
  const out = new Set<string>();
  for (const key of ['event_date', 'date']) {
    const d = dayOf(fm[key]);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) out.add(d);
  }
  const base = slug.split('/').pop() ?? '';
  const slugDate = /^(\d{4}-\d{2}-\d{2})/.exec(base)?.[1];
  if (slugDate) out.add(slugDate);
  for (const raw of lines) {
    const label = READING_LABEL_RE.exec(raw);
    if (label) {
      const d = findDates(raw.slice(label[0].length), date)[0];
      if (d) out.add(d.iso);
      continue;
    }
    const belated = /\bbelated\b/i.test(raw);
    for (const d of findDates(raw, date)) {
      if (d.last !== d.iso) continue;
      const before = raw.slice(Math.max(0, d.index - 60), d.index);
      const eventRef = EVENT_REF_BEFORE_RE.test(before) && READING_TAIL_RE.test(raw.slice(d.end).trimStart());
      if (belated || eventRef || READING_PHRASE_RE.test(before)) out.add(d.iso);
    }
  }
  if (date) out.delete(date);
  return [...out].sort();
}

function phraseHits(lines: string[]): PhraseHit[] {
  const out: PhraseHit[] = [];
  lines.forEach((raw, i) => {
    if (!raw.includes("'") && !raw.includes('’') && !/\b[Tt]he\b/.test(raw)) return;
    for (const sentence of raw.split(/(?<=[.!?])\s+/)) {
      if (PERSONAL_ACCOUNT_RE.test(sentence)) continue;
      for (const m of sentence.matchAll(POSSESSIVE_RE)) {
        const owner = trimNameRun(m[1]!);
        if (!owner) continue;
        out.push({ owner, descriptor: m[2]!.toLowerCase(), noun: m[3]!.toLowerCase(), line: i + 1, surface: m[0] });
      }
      for (const m of sentence.matchAll(RUNS_RE)) {
        const owner = trimNameRun(m[3]!);
        if (!owner) continue;
        out.push({ owner, descriptor: m[1]!.toLowerCase(), noun: m[2]!.toLowerCase(), line: i + 1, surface: m[0] });
      }
    }
  });
  return out;
}

function cueLines(lines: string[]): CueLine[] {
  const out: CueLine[] = [];
  let tableKeep = false;
  lines.forEach((raw, i) => {
    const isTable = raw.trimStart().startsWith('|');
    if (isTable) {
      if (!tableKeep && !/^\s*\|[\s:|-]+\|?\s*$/.test(raw)) tableKeep = OWNER_COLUMN_RE.test(raw) || CUE_RE.test(raw);
      if (tableKeep) out.push({ line: i + 1, text: raw });
      return;
    }
    tableKeep = false;
    if (CUE_RE.test(raw)) out.push({ line: i + 1, text: raw });
  });
  return out;
}

/** Scan one page. Lines are numbered within `compiled_truth`, then `timeline` continues the count; the title is line 0. */
export function scanPage(page: ScanInput): PageScan {
  const fm = page.frontmatter ?? {};
  const body = `${page.compiled_truth ?? ''}${page.timeline ? `\n${page.timeline}` : ''}`;
  const lines = body.split('\n');
  const date = page.effective_date_source && page.effective_date_source !== 'fallback' ? dayOf(page.effective_date) : null;
  const cues = cueLines(lines);
  for (const key of OWNER_FRONTMATTER_KEYS) {
    const v = fm[key];
    for (const item of Array.isArray(v) ? v : [v]) if (typeof item === 'string' && item.trim()) cues.push({ line: 0, text: `Owner: ${item.trim()}` });
  }
  const descriptors = new Set(frontmatterDescriptors(fm));
  for (const raw of lines) {
    const label = DESCRIPTOR_LABEL_RE.exec(raw);
    if (label) { const d = cleanDescriptor(label[1]!); if (d) descriptors.add(d); }
    for (const re of DESCRIPTOR_DECL_RES) for (const m of raw.matchAll(re)) { const d = cleanDescriptor(m[1]!); if (d) descriptors.add(d); }
  }
  const titleHits = page.title ? phraseHits([page.title]).map(h => ({ ...h, line: 0 })) : [];
  return {
    cues,
    descriptors: [...descriptors].sort(),
    hits: [...titleHits, ...phraseHits(lines)],
    date,
    readings: date ? citedReadings(page.slug, fm, lines, date) : [],
    agent: isAgentAuthored(page.type, fm),
  };
}
