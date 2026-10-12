/**
 * Calendar dates written in sentences, for owner-phrase windows. Dates are
 * ISO day strings (`YYYY-MM-DD`), so they compare as strings. Pure.
 */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORD = '(?:st|nd|rd|th)?';

export interface FoundDate {
  iso: string;
  /** Last day of the month for a month-only date ("March 2025"); equal to `iso` otherwise. */
  last: string;
  index: number;
  end: number;
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

function valid(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

function lastOfMonth(y: number, m: number): string {
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The year that puts month/day nearest `ref` (a day string), else null without a reference. */
function nearestYear(m: number, d: number, ref: string | null): number | null {
  if (!ref) return null;
  const refYear = Number(ref.slice(0, 4));
  let best: { y: number; gap: number } | null = null;
  for (const y of [refYear - 1, refYear, refYear + 1]) {
    const iso = valid(y, m, d);
    if (!iso) continue;
    const gap = Math.abs(Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${ref}T00:00:00Z`));
    if (!best || gap < best.gap) best = { y, gap };
  }
  return best?.y ?? null;
}

const DATE_RE = new RegExp([
  String.raw`\b(\d{4})-(\d{2})-(\d{2})\b`,
  String.raw`\b(\d{1,2})/(\d{1,2})/(\d{4})\b`,
  String.raw`\b(${MONTH})\.? (\d{1,2})${ORD}(?:,? (\d{4}))?\b`,
  String.raw`\b(\d{1,2})${ORD} (?:of )?(${MONTH})\.?(?:,? (\d{4}))?\b`,
  String.raw`\b(${MONTH})\.?,? (\d{4})\b`,
].join('|'), 'gi');

/** Every written calendar date in `text`, in order. `ref` (a day string) supplies a missing year. */
export function findDates(text: string, ref: string | null): FoundDate[] {
  const out: FoundDate[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    let iso: string | null = null;
    let last: string | null = null;
    if (m[1]) iso = valid(Number(m[1]), Number(m[2]), Number(m[3]));
    else if (m[4]) iso = valid(Number(m[6]), Number(m[4]), Number(m[5]));
    else if (m[7]) {
      const mo = MONTHS[m[7].toLowerCase().replace(/\.$/, '')]!;
      const day = Number(m[8]);
      const y = m[9] ? Number(m[9]) : nearestYear(mo, day, ref);
      iso = y == null ? null : valid(y, mo, day);
    } else if (m[10]) {
      const mo = MONTHS[m[11]!.toLowerCase()]!;
      const day = Number(m[10]);
      const y = m[12] ? Number(m[12]) : nearestYear(mo, day, ref);
      iso = y == null ? null : valid(y, mo, day);
    } else if (m[13]) {
      const mo = MONTHS[m[13].toLowerCase()]!;
      const y = Number(m[14]);
      iso = valid(y, mo, 1);
      last = iso ? lastOfMonth(y, mo) : null;
    }
    if (!iso) continue;
    out.push({ iso, last: last ?? iso, index: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** Relative time expressions that make a sentence's own date unknowable without a written date. */
export const RELATIVE_DATE_RE = /\b(?:tomorrow|yesterday|soon|shortly|next (?:week|month|quarter|year|monday|tuesday|wednesday|thursday|friday)|last (?:week|month|quarter)|this coming \w+|(?:later|earlier) this (?:week|month|quarter|year)|in (?:a|one|two|three|four|a few|\d+) (?:days?|weeks?|months?)|end of (?:the )?(?:week|month|quarter|year)|eo[mqy])\b/i;

/** A page date string (`YYYY-MM-DD`) from a stored timestamp, or null. */
export function dayOf(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const s = String(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1]!;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
