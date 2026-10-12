/**
 * Owner phrases: validity windows from ownership statements, and the
 * resolution of an owner phrase against them (contract lines 5, 6, 8-10).
 * Pure and deterministic.
 */

import { addDays } from './dates.ts';
import type { Statement } from './statements.ts';
import type { PhraseHit } from './scan.ts';

export interface Evidence { page_id: number; slug: string; line: number; kind: Statement['kind'] | 'implied'; date: string | null }

export interface OwnerWindow {
  group: string;
  /** Account pages the evidence names (members of `group`). */
  accounts: string[];
  /** Normalized owner key (lower-case full name when known). */
  owner: string;
  ownerName: string;
  /** Inclusive first day; null = no lower bound. */
  from: string | null;
  /** Inclusive last day; null = open-ended. */
  to: string | null;
  startKnown: boolean;
  evidence: Evidence[];
}

interface Stint {
  owner: string;
  ownerName: string;
  start: string | null;
  startKnown: boolean;
  bound: string | null;
  end: string | null;
  implicitEnd: boolean;
  accounts: Set<string>;
  evidence: Evidence[];
}

/** Owner surfaces → canonical keys: a one-word surface maps to the one full name it starts, when exactly one does. */
export function ownerKeys(surfaces: Iterable<string>): Map<string, { key: string; name: string }> {
  const all = [...new Set(surfaces)];
  const full = all.filter(s => s.includes(' '));
  const out = new Map<string, { key: string; name: string }>();
  for (const s of all) {
    if (!s.includes(' ')) {
      const firsts = [...new Set(full.filter(f => f.split(' ')[0]!.toLowerCase() === s.toLowerCase()).map(f => f.toLowerCase()))];
      if (firsts.length === 1) { out.set(s, { key: firsts[0]!, name: full.find(f => f.toLowerCase() === firsts[0])! }); continue; }
    }
    out.set(s, { key: s.toLowerCase(), name: s });
  }
  return out;
}

const KIND_ORDER: Record<string, number> = { stint: 0, correction: 0, ongoing: 1, join: 2, takeover: 3, end: 4 };

function evidenceOf(s: Statement, kind?: Evidence['kind']): Evidence {
  return { page_id: s.page_id, slug: s.slug, line: s.line, kind: kind ?? s.kind, date: s.date };
}

/** Corrections void the wrong owner's takeover/join/ongoing statements recorded up to the correction (contract line 5). */
export function applyCorrections(statements: Statement[], groupOf: (slug: string) => string): Statement[] {
  const corrections = statements.filter(s => s.kind === 'correction' && s.account);
  const voided = new Set<Statement>();
  const added: Statement[] = [];
  const keys = ownerKeys(statements.flatMap(s => [s.owner, s.from, s.wrong].filter((x): x is string => !!x)));
  const key = (name: string | null | undefined) => (name ? keys.get(name)?.key ?? name.toLowerCase() : null);
  for (const c of corrections) {
    const group = groupOf(c.account);
    const hits = statements.filter(s => s !== c && !voided.has(s) && (s.kind === 'takeover' || s.kind === 'join' || s.kind === 'ongoing')
      && groupOf(s.account) === group && key(s.owner) === key(c.wrong)
      && (s.recorded == null || c.recorded == null || s.recorded <= c.recorded));
    for (const h of hits) voided.add(h);
    if (!c.owner) continue;
    const anchor = c.stated ? c.date : hits.map(h => h.date).filter((d): d is string => !!d).sort()[0] ?? c.date;
    if (!anchor) continue;
    const from = hits.find(h => h.from)?.from;
    added.push({ ...c, kind: hits.some(h => h.kind !== 'ongoing') ? 'takeover' : 'ongoing', owner: c.owner, date: anchor, ...(from ? { from } : {}), wrong: undefined });
  }
  return [...statements.filter(s => s.kind !== 'correction' && !voided.has(s)), ...added];
}

/** Windows for every identity group from valid (dated) statements. */
export function buildWindows(statements: Statement[], groupOf: (slug: string) => string): OwnerWindow[] {
  const applied = applyCorrections(statements, groupOf).filter(s => s.date && s.owner && s.account);
  const keys = ownerKeys(applied.flatMap(s => [s.owner, s.from].filter((x): x is string => !!x)));
  const byGroup = new Map<string, Statement[]>();
  for (const s of applied) {
    const g = groupOf(s.account);
    const list = byGroup.get(g) ?? [];
    list.push(s);
    byGroup.set(g, list);
  }
  const out: OwnerWindow[] = [];
  for (const [group, list] of [...byGroup].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.date!.localeCompare(b.date!) || KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]!
      || (a.recorded ?? '').localeCompare(b.recorded ?? '') || a.page_id - b.page_id || a.line - b.line);
    const stints: Stint[] = [];
    const id = (name: string) => keys.get(name) ?? { key: name.toLowerCase(), name };
    const latestEndBefore = (day: string): string | null => {
      const ends = stints.map(s => s.end).filter((e): e is string => !!e && e < day).sort();
      return ends.length ? addDays(ends[ends.length - 1]!, 1) : null;
    };
    const covering = (owner: string | null, day: string) => stints.filter(s => (owner == null || s.owner === owner)
      && (s.start ?? s.bound ?? '0000-00-00') <= day && (s.end == null || day <= s.end));
    const newStint = (name: string, start: string | null, end: string | null, s: Statement, day: string): Stint => {
      const o = id(name);
      const stint: Stint = { owner: o.key, ownerName: o.name, start, startKnown: start != null, bound: start == null ? latestEndBefore(day) : null,
        end, implicitEnd: false, accounts: new Set([s.account]), evidence: [] };
      stints.push(stint);
      return stint;
    };
    const cite = (stint: Stint, s: Statement, kind?: Evidence['kind']) => {
      stint.accounts.add(s.account);
      if (!stint.evidence.some(e => e.page_id === s.page_id && e.line === s.line)) stint.evidence.push(evidenceOf(s, kind));
    };
    for (const s of list) {
      const day = s.date!;
      const o = id(s.owner!);
      if (s.kind === 'stint') {
        const start = s.start ?? null;
        const end = s.end ?? null;
        const overlap = stints.find(x => x.owner === o.key && (x.end == null || start == null || start <= x.end)
          && ((x.start ?? x.bound ?? '0000-00-00') <= (end ?? '9999-12-31')));
        if (overlap) {
          if (start && (overlap.start == null || start < overlap.start)) { overlap.start = start; overlap.startKnown = true; }
          if (end && (overlap.end == null || overlap.implicitEnd || end > overlap.end)) { overlap.end = end; overlap.implicitEnd = false; }
          cite(overlap, s);
        } else cite(newStint(s.owner!, start, end, s, end ?? day), s);
        continue;
      }
      if (s.kind === 'end') {
        const mine = stints.filter(x => x.owner === o.key && (x.start ?? x.bound ?? '0000-00-00') <= day).pop();
        if (mine && (mine.end == null || mine.implicitEnd)) { mine.end = day; mine.implicitEnd = false; cite(mine, s); }
        else if (mine && mine.end != null && mine.end >= day) cite(mine, s);
        else if (!mine) cite(newStint(s.owner!, null, day, s, day), s);
        continue;
      }
      if (s.kind === 'ongoing') {
        const mine = covering(o.key, day)[0];
        if (mine) { cite(mine, s); continue; }
        if (covering(null, day).length) continue;
        cite(newStint(s.owner!, null, null, s, day), s);
        continue;
      }
      if (s.kind === 'takeover') {
        const prevDay = addDays(day, -1);
        const fromKey = s.from ? id(s.from).key : null;
        for (const x of stints) {
          if (x.owner === o.key || x.end != null) continue;
          if (fromKey && x.owner !== fromKey) continue;
          if ((x.start ?? x.bound ?? '0000-00-00') > prevDay) continue;
          x.end = prevDay;
          x.implicitEnd = true;
          cite(x, s, 'implied');
        }
        if (fromKey && !covering(fromKey, prevDay).length) {
          const pred = newStint(s.from!, null, prevDay, s, prevDay);
          pred.implicitEnd = true;
          cite(pred, s, 'implied');
        }
      }
      const mine = covering(o.key, day)[0];
      if (mine) cite(mine, s);
      else cite(newStint(s.owner!, day, null, s, day), s);
    }
    for (const x of stints) {
      out.push({ group, accounts: [...x.accounts].sort(), owner: x.owner, ownerName: x.ownerName, from: x.start ?? x.bound,
        to: x.end, startKnown: x.startKnown, evidence: x.evidence });
    }
  }
  return out;
}

export type Resolution =
  | { linked: true; group: string; accounts: string[]; windows: OwnerWindow[] }
  | { linked: false; reason: 'no_page_date' | 'no_owner' | 'outside_window' | 'ambiguous' | 'readings_disagree' };

/** Whether a phrase's owner surface names a window's owner (one word: first name; longer: the full name). */
export function ownerMatches(surface: string, window: Pick<OwnerWindow, 'owner'>): boolean {
  const s = surface.toLowerCase().split(/\s+/);
  const w = window.owner.split(/\s+/);
  if (s.length === 1 || w.length === 1) return s[0] === w[0];
  return s.join(' ') === w.join(' ');
}

/** A descriptor run matches an account when the whole run is one of its descriptors, or every word of the run is a word of its descriptors ("EMEA software" with region EMEA and industry software). */
export function descriptorMatches(descriptors: ReadonlySet<string>, run: string): boolean {
  if (descriptors.has(run)) return true;
  const words = run.split(' ');
  if (words.length < 2) return false;
  const known = new Set([...descriptors].flatMap(d => d.split(' ')));
  return words.every(w => known.has(w));
}

/** Resolve one owner phrase on a document dated `date` (plus its other readings) against the windows (contract lines 9-10). */
export function resolvePhrase(hit: Pick<PhraseHit, 'owner' | 'descriptor'>, date: string | null, readings: string[],
  windows: OwnerWindow[], descriptorsOf: (group: string) => ReadonlySet<string>): Resolution {
  if (!date) return { linked: false, reason: 'no_page_date' };
  const owned = windows.filter(w => ownerMatches(hit.owner, w) && descriptorMatches(descriptorsOf(w.group), hit.descriptor));
  if (!owned.length) return { linked: false, reason: 'no_owner' };
  let chosen: string | null = null;
  let chosenWindows: OwnerWindow[] = [];
  for (const day of [date, ...readings]) {
    const live = owned.filter(w => (w.from == null || w.from <= day) && (w.to == null || day <= w.to));
    const groups = [...new Set(live.map(w => w.group))];
    if (!groups.length) return { linked: false, reason: day === date ? 'outside_window' : 'readings_disagree' };
    if (groups.length > 1) return { linked: false, reason: 'ambiguous' };
    if (chosen && chosen !== groups[0]) return { linked: false, reason: 'readings_disagree' };
    if (!chosen) { chosen = groups[0]!; chosenWindows = live; }
  }
  return { linked: true, group: chosen!, accounts: [...new Set(chosenWindows.flatMap(w => w.accounts))].sort(), windows: chosenWindows };
}

const NAME_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'group', 'holdings', 'plc', 'gmbh', 'sa', 'ag', 'lp', 'llp',
  'the', 'and', 'of', 'account', 'accounts', 'client', 'customer']);

/** An account's descriptors: words of its names without corporate suffixes, plus declared descriptors (contract line 7). */
export function accountDescriptors(names: string[], declared: string[]): Set<string> {
  const out = new Set<string>(declared.map(d => d.toLowerCase()));
  for (const name of names) {
    const subject = name.includes(': ') ? name.slice(name.lastIndexOf(': ') + 2) : name;
    for (const w of subject.toLowerCase().split(/[^\p{L}\p{N}&-]+/u)) if (w.length >= 2 && !NAME_SUFFIXES.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}
