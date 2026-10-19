/**
 * #5616 edit_page: ordered exact-string replacements applied server-side to
 * the caller's authorized view of a page (the `content` get_page returns to
 * that caller with include_content:true), mapped back onto the canonical body
 * without moving or exposing protected takes/facts fences.
 *
 * The canonical serialization is split into editable text and protected
 * segments. A protected segment renders as itself for trusted local callers;
 * for remote callers a takes fence renders as nothing and a facts fence as
 * its world-visible rows, exactly as get_page sanitizes them. An edit must
 * match exactly once inside editable text; a match that touches or crosses a
 * protected segment is refused, so canonical bytes outside the edited spans
 * are preserved byte for byte.
 */
import type { Page } from '../types.ts';
import { OperationError } from '../ops/contract.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { sanitizeText } from '../batch-rows.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { insertNoNewlineMarkers, splitLines, unifiedDiff } from '../skillpack/diff-text.ts';
import { redactRetrievalOutput } from '../search/output-redaction.ts';
import { scanCanonicalFences, targetFenceRefusal } from '../fence-repair/refusal.ts';
import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { ManifestRow } from '../page-body/types.ts';
import type { StoredRegion } from '../page-body/segmenter.ts';
import type { BodyReplacement, SplicePage } from '../page-body/splice.ts';
import { spliceWork } from '../page-body/splice.ts';
import { withoutBody } from '../page-body/page-shape.ts';
import { STAGE_BATCH_BYTES } from '../page-body/limits.ts';
import { TIMELINE_SEPARATOR } from '../page-window/document.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import type { WriteRequest } from './model.ts';
import type { PreparedMutation } from './coordinator.ts';

export const EDIT_PAGE_MAX_EDITS = 50;
export const EDIT_PAGE_DIFF_MAX_BYTES = 8 * 1024;
/**
 * Most LCS table cells (old lines + 1) x (new lines + 1) an edit_page diff
 * fills, about 32 MB of numbers. Past it only the changed region is diffed.
 */
export const EDIT_PAGE_DIFF_CELL_BUDGET = 4_000_000;
const EDIT_PAGE_DIFF_CONTEXT = 3;
export const EDIT_PAGE_DOCS = 'docs/protocol/MEMORY_VERBS_v1.md#partial-page-edits-edit_page';

export interface PageEdit { old_text: string; new_text: string; }
/** A stored-body byte range (truth bytes then timeline bytes, as get_page window reads return it in `edit_target`) that every match must lie in. */
export interface EditWithin { byte_start: number; byte_end: number; }
interface Segment { canonical: string; view: string; editable: boolean; }

const MARKERS = [FACTS_FENCE_BEGIN, FACTS_FENCE_END, TAKES_FENCE_BEGIN, TAKES_FENCE_END];
const MARKER_PATTERN = new RegExp(MARKERS.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
const REMOTE_VIEW = { includeWithdrawn: true, keepMaterializedMarkers: true } as const;

function editError(code: string, message: string, suggestion: string, detail?: string): OperationError {
  const error = new OperationError(code, message, suggestion, EDIT_PAGE_DOCS);
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** Validates the wire shape: 1-50 `{ old_text, new_text }` objects, `old_text` non-empty. */
export function parsePageEdits(value: unknown): PageEdit[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > EDIT_PAGE_MAX_EDITS) {
    throw editError('edit_invalid', `edits must be an array of 1 to ${EDIT_PAGE_MAX_EDITS} replacements.`,
      'Pass edits: [{ "old_text": "…", "new_text": "…" }] in the order to apply them.');
  }
  return value.map((edit, index) => {
    const record = edit as Record<string, unknown> | null;
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(k => k !== 'old_text' && k !== 'new_text')
      || typeof record.old_text !== 'string' || typeof record.new_text !== 'string') {
      throw editError('edit_invalid', `Edit ${index} must be an object with string old_text and new_text.`,
        'Each edit is exactly { "old_text": "…", "new_text": "…" }.', `edit_index=${index}`);
    }
    if (record.old_text.length === 0) {
      throw editError('edit_invalid', `Edit ${index} has an empty old_text.`,
        'Quote enough existing text to match exactly once; use put_page to write a new page.', `edit_index=${index}`);
    }
    if (MARKERS.some(marker => (record.new_text as string).includes(marker))) {
      throw editError('edit_protected_span', `Edit ${index} would write a protected fence marker.`,
        'Use the takes_* operations or remember/forget for takes and facts.', `edit_index=${index}`);
    }
    return { old_text: record.old_text, new_text: record.new_text };
  });
}

/** Validates `within`: integer stored-body offsets with byte_start < byte_end. */
export function parseEditWithin(value: unknown): EditWithin | undefined {
  if (value === undefined || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(record).some(k => k !== 'byte_start' && k !== 'byte_end')
    || !Number.isSafeInteger(record.byte_start) || !Number.isSafeInteger(record.byte_end)
    || (record.byte_start as number) < 0 || (record.byte_end as number) <= (record.byte_start as number)) {
    throw editError('edit_invalid', 'within must be { byte_start, byte_end } with 0 <= byte_start < byte_end.',
      "Pass edit_target's byte_start and byte_end from a get_page window read unchanged, or omit within.");
  }
  return { byte_start: record.byte_start as number, byte_end: record.byte_end as number };
}

function bodySegments(body: string, remote: boolean): Segment[] {
  if (remote && sanitizeText(body) !== body) {
    throw editError('edit_invalid', 'This page contains bytes the remote view cannot reproduce.',
      'Edit it from the brain host with put_page or the local CLI.');
  }
  const segments: Segment[] = [];
  let cursor = 0;
  let open: { start: number; end: string } | undefined;
  for (const token of body.matchAll(MARKER_PATTERN)) {
    const marker = token[0];
    if (!open) {
      if (marker !== FACTS_FENCE_BEGIN && marker !== TAKES_FENCE_BEGIN) continue;
      if (token.index > cursor) segments.push(text(body.slice(cursor, token.index)));
      open = { start: token.index, end: marker === FACTS_FENCE_BEGIN ? FACTS_FENCE_END : TAKES_FENCE_END };
      continue;
    }
    if (marker !== open.end) throw unrepairedFence();
    cursor = token.index + marker.length;
    const fence = body.slice(open.start, cursor);
    segments.push({ canonical: fence, view: remote ? sanitizeRemoteBody(fence, REMOTE_VIEW) : fence, editable: false });
    open = undefined;
  }
  if (open) throw unrepairedFence();
  if (cursor < body.length) segments.push(text(body.slice(cursor)));
  return segments;
}

function text(value: string): Segment { return { canonical: value, view: value, editable: true }; }
function unrepairedFence(): OperationError {
  return editError('edit_invalid', 'A takes or facts fence on this page is malformed.',
    'Read the page, then fix the fence (or write the whole page with put_page, which normalizes what it can) before editing it.');
}

/**
 * Mirrors serializeMarkdown's layout so the view is byte-equal to get_page's
 * `content`; adjacent editable pieces coalesce so a match may span the
 * frontmatter, body and timeline sentinel like any ordinary text.
 */
function pageSegments(page: Page, tags: string[], remote: boolean): Segment[] {
  const head = serializePageToMarkdown({ ...page, compiled_truth: '', timeline: '' }, tags).slice(0, -1);
  const timeline = bodySegments(page.timeline ?? '', remote);
  const sentinel = '\n\n<!-- timeline -->\n\n';
  // A remote view whose whole timeline is protected has no sentinel either.
  const sentinelSegment = timeline.some(segment => segment.view.length > 0) ? text(sentinel) : { canonical: sentinel, view: '', editable: false };
  const pieces = [text(head), ...bodySegments(page.compiled_truth ?? '', remote),
    ...(page.timeline ? [sentinelSegment, ...timeline] : []), text('\n')];
  return pieces.reduce<Segment[]>((out, piece) => {
    const last = out[out.length - 1];
    if (last?.editable && piece.editable) out[out.length - 1] = text(last.canonical + piece.canonical);
    else out.push(piece);
    return out;
  }, []);
}

const join = (segments: Segment[], key: 'canonical' | 'view') => segments.map(segment => segment[key]).join('');

/** The text a caller matches against: get_page `content` for that caller. */
export function editableView(page: Page, tags: string[], remote: boolean): string {
  return join(pageSegments(page, tags, remote), 'view');
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/**
 * Applies the edits in order, each to the text produced by the previous one,
 * all or nothing. Returns the canonical content to publish and the caller's
 * view before and after (the only text a diff or receipt may show).
 */
export function applyPageEdits(page: Page, tags: string[], remote: boolean, edits: PageEdit[], within?: EditWithin): { content: string; before: string; after: string } {
  // #6188 (D19): edit_page never rewrites a fence; a stored fence that does not compile refuses typed, location only.
  const [defect] = scanCanonicalFences(page).defects;
  if (defect) throw targetFenceRefusal(defect, page.slug, page.source_id);
  let segments = pageSegments(page, tags, remote);
  const before = join(segments, 'view');
  // `within` is in stored-body bytes of the page as read: canonical positions map back through the edits applied so far.
  const head = serializePageToMarkdown({ ...page, compiled_truth: '', timeline: '' }, tags).slice(0, -1).length;
  const truth = page.compiled_truth ?? '', timeline = page.timeline ?? '';
  const timelineAt = head + truth.length + '\n\n<!-- timeline -->\n\n'.length;
  const applied: Array<{ start: number; oldLen: number; newLen: number }> = [];
  const original = (pos: number, side: 'start' | 'end') => {
    for (let k = applied.length - 1; k >= 0; k--) {
      const a = applied[k]!;
      if (pos <= a.start) continue;
      pos = pos >= a.start + a.newLen ? pos - (a.newLen - a.oldLen) : side === 'start' ? a.start : a.start + a.oldLen;
    }
    return pos;
  };
  const storedByte = (pos: number) => pos >= head && pos <= head + truth.length ? Buffer.byteLength(truth.slice(0, pos - head), 'utf8')
    : page.timeline && pos >= timelineAt && pos <= timelineAt + timeline.length ? Buffer.byteLength(truth, 'utf8') + Buffer.byteLength(timeline.slice(0, pos - timelineAt), 'utf8') : -1;
  const inRange = (start: number, end: number) => {
    if (!within) return true;
    const s = storedByte(original(start, 'start')), e = storedByte(original(end, 'end'));
    return s >= 0 && e >= 0 && s >= within.byte_start && e <= within.byte_end;
  };
  edits.forEach((edit, index) => {
    const view = join(segments, 'view');
    const ranges: Array<{ start: number; end: number; index: number; canonical: number }> = [];
    let offset = 0, canonicalOffset = 0;
    segments.forEach((segment, i) => {
      ranges.push({ start: offset, end: offset + segment.view.length, index: i, canonical: canonicalOffset });
      offset += segment.view.length; canonicalOffset += segment.canonical.length;
    });
    const inside = (at: number) => ranges.find(r => segments[r.index].editable && at >= r.start && at + edit.old_text.length <= r.end);
    const canonicalAt = (at: number) => { const r = inside(at)!; return r.canonical + at - r.start; };
    const all = occurrences(view, edit.old_text).filter(at => !within || (inside(at) ? inRange(canonicalAt(at), canonicalAt(at) + edit.old_text.length) : true));
    const allowed = all.filter(at => inside(at));
    if (allowed.length === 0 && all.length > 0) {
      throw editError('edit_protected_span', `Edit ${index}'s old_text touches a protected takes or facts section.`,
        'Use the takes_* operations or remember/forget for takes and facts, and quote only ordinary page text.', `edit_index=${index}`);
    }
    if (allowed.length === 0) {
      throw editError('edit_no_match', `Edit ${index}'s old_text was not found in the page.`,
        'Read get_page with include_content:true and copy old_text exactly, including whitespace; earlier edits in the same call have already been applied to the text it matches.',
        `edit_index=${index} match_count=0`);
    }
    if (allowed.length > 1) {
      throw editError('edit_ambiguous_match', `Edit ${index}'s old_text matches ${allowed.length} places.`,
        'Include surrounding text in old_text so it matches exactly once.', `edit_index=${index} match_count=${allowed.length}`);
    }
    const at = allowed[0];
    const range = inside(at)!;
    const segment = segments[range.index];
    const local = at - range.start;
    const replaced = segment.canonical.slice(0, local) + edit.new_text + segment.canonical.slice(local + edit.old_text.length);
    applied.push({ start: range.canonical + local, oldLen: edit.old_text.length, newLen: edit.new_text.length });
    segments = segments.map((s, i) => i === range.index ? text(replaced) : s);
  });
  return { content: join(segments, 'canonical'), before, after: join(segments, 'view') };
}

const encodedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text));

/**
 * unifiedDiff when its LCS table fits `cellBudget`. Otherwise the common
 * leading lines and (when both sides agree on the trailing newline) common
 * trailing lines are trimmed down to the diff context, the remaining window
 * is diffed, and its hunk headers are shifted back to page line numbers. A
 * window still over budget becomes one coarse hunk (context, every old line
 * removed, every new line added) with `coarse: true`. Every result applies
 * cleanly to `before` and yields the lines of `after`, and its no-newline
 * markers sit only at end-of-file (unifiedDiff can place them mid-file; a
 * change of the final newline alone is no line change to either). Before
 * this bound a one-line edit on a 50k-line page filled a 2.5-billion-cell
 * table.
 *
 * @internal exported for the differential test.
 */
export function boundedUnifiedDiff(
  before: string,
  after: string,
  oldPath: string,
  newPath: string,
  cellBudget = EDIT_PAGE_DIFF_CELL_BUDGET,
): { diff: string; coarse: boolean } {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.lines.length;
  const m = b.lines.length;
  const opts = { oldPath, newPath, context: EDIT_PAGE_DIFF_CONTEXT };
  if ((n + 1) * (m + 1) <= cellBudget) return { diff: unifiedDiff(before, after, opts), coarse: false };

  let prefix = 0;
  while (prefix < n && prefix < m && a.lines[prefix] === b.lines[prefix]) prefix++;
  if (prefix === n && prefix === m) return { diff: '', coarse: false };
  let suffix = 0;
  if (a.trailingNewline === b.trailingNewline) {
    while (suffix < n - prefix && suffix < m - prefix && a.lines[n - 1 - suffix] === b.lines[m - 1 - suffix]) suffix++;
  }
  const from = Math.max(0, prefix - EDIT_PAGE_DIFF_CONTEXT);
  const tail = Math.max(0, suffix - EDIT_PAGE_DIFF_CONTEXT);
  const aWindow = a.lines.slice(from, n - tail);
  const bWindow = b.lines.slice(from, m - tail);
  const header = [`--- ${oldPath}`, `+++ ${newPath}`];

  if ((aWindow.length + 1) * (bWindow.length + 1) > cellBudget) {
    const lead = prefix - from;
    const trail = suffix - tail;
    const out = [...header, `@@ -${from + 1},${aWindow.length} +${from + 1},${bWindow.length} @@`];
    for (const line of aWindow.slice(0, lead)) out.push(' ' + line);
    for (const line of aWindow.slice(lead, aWindow.length - trail)) out.push('-' + line);
    for (const line of bWindow.slice(lead, bWindow.length - trail)) out.push('+' + line);
    for (const line of aWindow.slice(aWindow.length - trail)) out.push(' ' + line);
    insertNoNewlineMarkers(out, tail > 0 || a.trailingNewline, tail > 0 || b.trailingNewline);
    return { diff: out.join('\n') + '\n', coarse: true };
  }

  // The window is diffed as if both sides ended in a newline; the markers
  // go in afterwards, only on a side whose last hunk reaches end-of-file.
  const windowText = (lines: string[]) => (lines.length === 0 ? '' : lines.join('\n') + '\n');
  const out = [...header];
  let aEnd = 0;
  let bEnd = 0;
  for (const line of unifiedDiff(windowText(aWindow), windowText(bWindow), opts).split('\n').slice(2, -1)) {
    const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
    if (!hunk) {
      out.push(line);
      continue;
    }
    const [aStart, aCount, bStart, bCount] = hunk.slice(1).map(Number) as [number, number, number, number];
    aEnd = aStart + from + aCount - 1;
    bEnd = bStart + from + bCount - 1;
    out.push(`@@ -${aStart + from},${aCount} +${bStart + from},${bCount} @@`);
  }
  insertNoNewlineMarkers(out, aEnd < n || a.trailingNewline, bEnd < m || b.trailingNewline);
  return { diff: out.join('\n') + '\n', coarse: false };
}

/**
 * The caller-view unified diff, secret-redacted like retrieval output (it is
 * retained in the receipt), cut on a line boundary so its JSON encoding fits
 * 8 KB: the receipt reserves exactly that much (EDIT_PAGE_RECEIPT_RESERVE).
 * `diff_coarse` marks a changed region too large to line-diff
 * (boundedUnifiedDiff).
 */
export function editDiff(slug: string, before: string, after: string, lineOffset = 0): { diff: string; diff_truncated?: true; diff_coarse?: true } {
  const bounded = boundedUnifiedDiff(before, after, `a/${slug}.md`, `b/${slug}.md`);
  const { coarse } = bounded;
  const diff = lineOffset === 0 ? bounded.diff : bounded.diff.replace(/^@@ -(\d+)((?:,\d+)?) \+(\d+)((?:,\d+)?) @@/gm,
    (_, a: string, b: string, c: string, d: string) => `@@ -${Number(a) + lineOffset}${b} +${Number(c) + lineOffset}${d} @@`);
  const [{ diff: full }] = redactRetrievalOutput([{ diff }], {}).results;
  const marked = coarse ? { diff_coarse: true as const } : {};
  if (encodedBytes(full) <= EDIT_PAGE_DIFF_MAX_BYTES) return { diff: full, ...marked };
  const lines = full.split('\n');
  let kept = '';
  for (const line of lines) {
    if (encodedBytes(`${kept}${line}\n`) > EDIT_PAGE_DIFF_MAX_BYTES) break;
    kept += `${line}\n`;
  }
  return { diff: kept, diff_truncated: true, ...marked };
}

/** Extra terminal-receipt bytes an edit_page admission reserves for its diff. */
export const EDIT_PAGE_RECEIPT_RESERVE = EDIT_PAGE_DIFF_MAX_BYTES + 512;

/** Submission preflight and publication share one check of the stated revision. */
export function assertEditRevision(current: string | null, expected: unknown): void {
  if (current !== null && expected === current) return;
  throw editError('revision_conflict', current === null ? 'The page does not exist.' : 'The page changed since expected_revision was read.',
    'Read get_page with include_content:true again, rebuild the edits against that content, and resend with its revision.',
    current === null ? undefined : `current_revision=${current}`);
}


/** Stored region kinds an edit never matches into: fence bodies and markers (a PEM block is ordinary text to edit_page). */
const PROTECTED_KINDS = new Set(['facts', 'takes', 'tail', 'marker']);
/** Virtual bytes a segmented scan searches per window before it carries |old_text| - 1 bytes on. */
const SCAN_WINDOW_BYTES = 1024 * 1024;
/** Context a segmented edit's receipt diff shows around its touched range, each side, before line rounding. */
const DIFF_CONTEXT_BYTES = 2048;
/** A touched range longer than this is diffed at its first replacement only (diff_truncated). */
const DIFF_SCOPE_MAX_BYTES = 256 * 1024;

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** A run of the edited body: original stored bytes [origStart, origEnd), or a replacement's bytes standing for that span. */
interface Piece { origStart: number; origEnd: number; bytes: Uint8Array; replaced: boolean }

/** Live rows' texts, read in batches of at most STAGE_BATCH_BYTES. */
async function* rowTexts(engine: BrainEngine, sourceId: string, rows: readonly ManifestRow[]): AsyncIterable<[ManifestRow, Uint8Array]> {
  for (let i = 0; i < rows.length;) {
    let j = i, bytes = 0;
    while (j < rows.length && (j === i || bytes + rows[j]!.byteLen <= STAGE_BATCH_BYTES[engine.kind])) bytes += rows[j++]!.byteLen;
    const batch = rows.slice(i, j);
    const texts = await engine.readSegmentTexts(sourceId, batch.map(row => row.sha256));
    for (const row of batch) {
      const text = texts.get(hexOf(row.sha256));
      if (!text) throw new Error(`Segment text ${hexOf(row.sha256)} of page ${row.pageId} is missing.`);
      spliceWork.read += text.length;
      yield [row, text];
    }
    i = j;
  }
}

/** The body's bytes over original [from, to) of one region with `reps` applied, as pieces in order. */
async function* virtualPieces(engine: BrainEngine, sourceId: string, rows: readonly ManifestRow[], reps: readonly BodyReplacement[], from: number, to: number): AsyncIterable<Piece> {
  const covering = rows.filter(row => Number(row.byteStart) < to && Number(row.byteStart) + row.byteLen > from);
  const emitted = new Set<BodyReplacement>();
  for await (const [row, text] of rowTexts(engine, sourceId, covering)) {
    const start = Number(row.byteStart);
    let cur = Math.max(from, start);
    const end = Math.min(to, start + row.byteLen);
    for (const r of reps) {
      if (r.end <= cur || r.start >= end) continue;
      if (r.start > cur) yield { origStart: cur, origEnd: r.start, bytes: text.subarray(cur - start, r.start - start), replaced: false };
      if (!emitted.has(r)) { emitted.add(r); yield { origStart: r.start, origEnd: r.end, bytes: r.bytes, replaced: true }; }
      cur = Math.min(r.end, end);
    }
    if (cur < end) yield { origStart: cur, origEnd: end, bytes: text.subarray(cur - start, end - start), replaced: false };
  }
}

interface Match { start: number; end: number; prefix: Uint8Array; suffix: Uint8Array }

/**
 * Every match of `needle` in one region's edited bytes over original [from, to), mapped back to original stored
 * coordinates: a match end inside a replacement takes that replacement's whole span, and the replacement's bytes
 * before (`prefix`) and after (`suffix`) the match. Memory is one scan window plus |needle| - 1 bytes.
 */
async function regionMatches(engine: BrainEngine, sourceId: string, rows: readonly ManifestRow[], reps: readonly BodyReplacement[], from: number, to: number,
  needle: Buffer): Promise<Match[]> {
  const found: Match[] = [];
  let buf = Buffer.alloc(0);
  let map: Array<Piece & { v: number }> = [];
  const locate = (v: number, side: 'start' | 'end') => {
    const p = side === 'start' ? map.find(m => v >= m.v && v < m.v + m.bytes.length)! : map.find(m => v > m.v && v <= m.v + m.bytes.length)!;
    if (!p.replaced) return { orig: p.origStart + (v - p.v), rest: new Uint8Array() };
    return side === 'start' ? { orig: p.origStart, rest: p.bytes.subarray(0, v - p.v) } : { orig: p.origEnd, rest: p.bytes.subarray(v - p.v) };
  };
  const search = (final: boolean) => {
    const limit = final ? buf.length : buf.length - (needle.length - 1);
    for (let at = buf.indexOf(needle); at !== -1 && at < limit; at = buf.indexOf(needle, at + 1)) {
      const s = locate(at, 'start'), e = locate(at + needle.length, 'end');
      found.push({ start: s.orig, end: e.orig, prefix: s.rest, suffix: e.rest });
    }
    if (final) return;
    const keep = Math.max(0, buf.length - (needle.length - 1));
    map = map.filter(m => m.v + m.bytes.length > keep).map(m => ({ ...m, v: m.v - keep }));
    buf = buf.subarray(keep);
  };
  for await (const piece of virtualPieces(engine, sourceId, rows, reps, from, to)) {
    if (!piece.bytes.length) continue;
    map.push({ ...piece, v: buf.length });
    buf = Buffer.concat([buf, piece.bytes]);
    if (buf.length >= SCAN_WINDOW_BYTES) search(false);
  }
  search(true);
  return found;
}

/** Stored spans (absolute) an edit never matches into. */
/** Facts, takes and tail text as whole stored runs: the pieces of one region that segment cuts split are joined. */
function hiddenRuns(rows: readonly ManifestRow[]): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  for (const span of protectedSpans(rows, false).sort((x, y) => x.start - y.start)) {
    const last = runs[runs.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else runs.push({ ...span });
  }
  return runs;
}

/**
 * Newlines of the caller's view before stored byte `at` (a line start in `timeline` or truth): the head, the rows'
 * line counts, the separator before the timeline and the containing row's prefix. A remote view renders each hidden
 * run before `at` as sanitizeRemoteBody does, so only those runs are read, never the ordinary text before `at`.
 */
async function viewNewlinesBefore(engine: BrainEngine, input: { sourceId: string; remote: boolean; head: string }, rows: readonly ManifestRow[],
  timeline: boolean, at: number): Promise<number> {
  const count = (b: Uint8Array) => { let n = 0; for (let i = b.indexOf(0x0a); i !== -1; i = b.indexOf(0x0a, i + 1)) n++; return n; };
  const before = rows.filter(row => Number(row.byteStart) < at && (timeline || row.region === 'truth'));
  let lines = count(Buffer.from(input.head + (timeline ? TIMELINE_SEPARATOR : ''), 'utf8'));
  for (const row of before) if (Number(row.byteStart) + row.byteLen <= at) lines += row.lineCount;
  const containing = before.filter(row => Number(row.byteStart) + row.byteLen > at);
  for await (const [row, text] of rowTexts(engine, input.sourceId, containing)) lines += count(text.subarray(0, at - Number(row.byteStart)));
  if (!input.remote) return lines;
  for (const run of hiddenRuns(rows).filter(r => r.end <= at)) {
    const raw: Buffer[] = [];
    for await (const piece of virtualPieces(engine, input.sourceId, rows, [], run.start, run.end)) raw.push(Buffer.from(piece.bytes));
    const text = Buffer.concat(raw);
    lines += count(Buffer.from(sanitizeRemoteBody(text.toString('utf8'), REMOTE_VIEW), 'utf8')) - count(text);
  }
  return lines;
}

/**
 * #6188 (D19) on a segmented page: scanCanonicalFences over the stored fence text (facts, takes, an unclosed tail's
 * first piece, stray markers), each piece at its own line of its section, so the refusal is the whole-body scan's,
 * location included. Only segments holding fence text are read. With `within`, only the fences in the segments it
 * touches and those crossing into them are checked.
 */
async function assertSegmentedFencesCompile(engine: BrainEngine, input: { sourceId: string; slug: string }, rows: readonly ManifestRow[], within?: EditWithin): Promise<void> {
  let pieces = rows.flatMap(row => (row.protectedRegions as StoredRegion[]).filter(r => PROTECTED_KINDS.has(r.kind))
    .map(r => ({ row, kind: r.kind, start: Number(row.byteStart) + r.start, end: Number(row.byteStart) + r.end }))).sort((x, y) => x.start - y.start);
  const firstTail = pieces.findIndex(p => p.kind === 'tail');
  if (firstTail !== -1) pieces = pieces.filter((p, i) => p.kind !== 'tail' || i === firstTail);
  if (within) {
    const touched = rows.filter(row => Number(row.byteStart) < within.byte_end && Number(row.byteStart) + row.byteLen > within.byte_start);
    if (!touched.length) return;
    const lo = Math.min(...touched.map(row => Number(row.byteStart))), hi = Math.max(...touched.map(row => Number(row.byteStart) + row.byteLen));
    const runs: Array<typeof pieces> = [];
    for (const piece of pieces) {
      const run = runs[runs.length - 1];
      if (run && piece.start <= run[run.length - 1]!.end) run.push(piece); else runs.push([piece]);
    }
    pieces = runs.filter(run => run[0]!.start < hi && run[run.length - 1]!.end > lo).flat();
  }
  if (!pieces.length) return;
  const count = (b: Uint8Array) => { let n = 0; for (let i = b.indexOf(0x0a); i !== -1; i = b.indexOf(0x0a, i + 1)) n++; return n; };
  const texts = new Map<number, Uint8Array>();
  for await (const [row, text] of rowTexts(engine, input.sourceId, [...new Set(pieces.map(p => p.row))])) texts.set(Number(row.byteStart), text);
  const sections = { truth: { text: [] as Buffer[], lines: 0, first: 0 }, timeline: { text: [] as Buffer[], lines: 0, first: 0 } };
  for (const region of ['truth', 'timeline'] as const) sections[region].first = rows.find(row => row.region === region)?.lineStart ?? 0;
  for (const piece of pieces) {
    const section = sections[piece.row.region === 'timeline' ? 'timeline' : 'truth'];
    const text = texts.get(Number(piece.row.byteStart))!, at = piece.start - Number(piece.row.byteStart);
    const line = piece.row.lineStart - section.first + count(text.subarray(0, at));
    if (line > section.lines) { section.text.push(Buffer.from('\n'.repeat(line - section.lines))); section.lines = line; }
    const bytes = Buffer.from(text.subarray(at, piece.end - Number(piece.row.byteStart)));
    section.text.push(bytes);
    section.lines += count(bytes);
  }
  const [defect] = scanCanonicalFences({ compiled_truth: Buffer.concat(sections.truth.text).toString('utf8'), timeline: Buffer.concat(sections.timeline.text).toString('utf8') }).defects;
  if (defect) throw targetFenceRefusal(defect, input.slug, input.sourceId);
}

/** Submission's fence check of a segmented page's live body, as applyPageEdits refuses an inline one before admission; preparation repeats it. */
export async function assertSegmentedEditFences(engine: BrainEngine, page: { id?: number | null; slug: string; source_id: string }, within?: EditWithin): Promise<void> {
  await assertSegmentedFencesCompile(engine, { sourceId: page.source_id, slug: page.slug }, await engine.readManifest(Number(page.id)), within);
}

function protectedSpans(rows: readonly ManifestRow[], markers = true): Array<{ start: number; end: number }> {
  return rows.flatMap(row => (row.protectedRegions as StoredRegion[]).filter(r => PROTECTED_KINDS.has(r.kind) && (markers || r.kind !== 'marker'))
    .map(r => ({ start: Number(row.byteStart) + r.start, end: Number(row.byteStart) + r.end })));
}

export interface LocatedSegmentedEdits {
  replacements: BodyReplacement[];
  /** The receipt diff fields (editDiff over the touched range). */
  diff: Record<string, unknown>;
}

/**
 * edit_page's matching on a segmented page (spec 6.3), without materializing it: each old_text is found by a
 * streaming scan of the stored body (the edits before it applied), across segment boundaries, in `within` when given
 * (O(range)) or the whole body. The rules are applyPageEdits': exactly one match outside protected takes and facts
 * text, all or none; a remote caller never matches into text its view hides (such a match counts as absent). Null
 * declines to the whole-body path: an old_text that names the timeline sentinel or also occurs in the frontmatter
 * head, or (without `within`, within the whole-body limit) one the body does not hold, which that path settles exactly.
 */
export async function locateSegmentedEdits(engine: BrainEngine, input: { sourceId: string; slug: string; page: SplicePage; edits: PageEdit[]; within?: EditWithin;
  remote: boolean; head: string }): Promise<LocatedSegmentedEdits | null> {
  const { page, within } = input;
  const rows = await engine.readManifest(page.id, { generation: page.generation });
  spliceWork.rows += rows.length;
  await assertSegmentedFencesCompile(engine, input, rows, within);
  const guarded = protectedSpans(rows);
  const regions = [{ lo: 0, hi: page.truthBytes, rows: rows.filter(r => r.region === 'truth') },
    { lo: page.truthBytes, hi: page.bodyBytes, rows: rows.filter(r => r.region === 'timeline') }];
  let reps: BodyReplacement[] = [];
  for (const [index, edit] of input.edits.entries()) {
    if (edit.old_text.includes('<!-- timeline -->') || (!within && input.head.includes(edit.old_text))) return null;
    const needle = Buffer.from(edit.old_text, 'utf8');
    const matches: Match[] = [];
    for (const region of regions) {
      const from = within ? Math.max(region.lo, within.byte_start) : region.lo;
      const to = within ? Math.min(region.hi, within.byte_end) : region.hi;
      if (from >= to) continue;
      matches.push(...await regionMatches(engine, input.sourceId, region.rows, reps, from, to, needle));
    }
    const touches = (m: Match) => guarded.some(g => m.start < g.end && g.start < m.end);
    const visible = input.remote ? matches.filter(m => !touches(m)) : matches;
    const allowed = visible.filter(m => !touches(m));
    if (allowed.length === 0 && visible.length > 0) {
      throw editError('edit_protected_span', `Edit ${index}'s old_text touches a protected takes or facts section.`,
        'Use the takes_* operations or remember/forget for takes and facts, and quote only ordinary page text.', `edit_index=${index}`);
    }
    if (allowed.length === 0) {
      if (!within && page.bodyBytes <= PAGE_MAX_BYTES) return null;
      throw editError('edit_no_match', `Edit ${index}'s old_text was not found in the page${within ? ' range' : ''}.`,
        `${within ? 'Read the range again (get_page body: \'window\' returns edit_target), or omit within to search the whole page. ' : ''}Copy old_text exactly, including whitespace; earlier edits in the same call have already been applied to the text it matches.`,
        `edit_index=${index} match_count=0`);
    }
    if (allowed.length > 1) {
      throw editError('edit_ambiguous_match', `Edit ${index}'s old_text matches ${allowed.length} places.`,
        `Include surrounding text in old_text so it matches exactly once${within ? '' : ', or pass within (edit_target from a get_page window read) to search one range'}.`,
        `edit_index=${index} match_count=${allowed.length}`);
    }
    const m = allowed[0]!;
    const absorbed = reps.filter(r => r.start >= m.start && r.end <= m.end);
    reps = [...reps.filter(r => !absorbed.includes(r)), { start: m.start, end: m.end, bytes: Buffer.concat([m.prefix, Buffer.from(edit.new_text, 'utf8'), m.suffix]) }]
      .sort((a, b) => a.start - b.start);
  }
  return { replacements: reps, diff: await segmentedEditDiff(engine, input, rows, regions, reps) };
}

/** editDiff over the touched range (line-rounded, with context), in the caller's view: remote text is sanitized as get_page shows it. */
async function segmentedEditDiff(engine: BrainEngine, input: { sourceId: string; slug: string; remote: boolean; head: string }, rows: readonly ManifestRow[],
  regions: ReadonlyArray<{ lo: number; hi: number; rows: ManifestRow[] }>, reps: readonly BodyReplacement[]): Promise<Record<string, unknown>> {
  let scoped = reps;
  if (reps[reps.length - 1]!.end - reps[0]!.start > DIFF_SCOPE_MAX_BYTES || regions.some(r => reps[0]!.start < r.hi && reps[reps.length - 1]!.end > r.hi)) scoped = reps.slice(0, 1);
  const region = regions.find(r => scoped[0]!.start >= r.lo && scoped[0]!.start < r.hi) ?? regions[0]!;
  let from = Math.max(region.lo, scoped[0]!.start - DIFF_CONTEXT_BYTES), to = Math.min(region.hi, scoped[scoped.length - 1]!.end + DIFF_CONTEXT_BYTES);
  // Context never starts or ends inside hidden text: a slice of a fence is not sanitized as the fence is.
  for (const run of hiddenRuns(rows)) {
    if (run.start < from && from < run.end) from = run.end;
    if (run.start < to && to < run.end) to = run.start;
  }
  const original: Buffer[] = [];
  for await (const piece of virtualPieces(engine, input.sourceId, region.rows, [], from, to)) original.push(Buffer.from(piece.bytes));
  let raw = Buffer.concat(original);
  let lo = scoped[0]!.start - from, hi = scoped[scoped.length - 1]!.end - from;
  const head = from === region.lo ? 0 : raw.indexOf(0x0a) + 1;
  const tailNl = to === region.hi ? raw.length : raw.lastIndexOf(0x0a) + 1;
  const start = head > 0 && head <= lo ? head : (from === region.lo ? 0 : lo), end = tailNl >= hi && tailNl > 0 ? tailNl : hi;
  const slice = (buf: Buffer, a: number, b: number) => { while (a > 0 && (buf[a]! & 0xc0) === 0x80) a--; while (b < buf.length && (buf[b]! & 0xc0) === 0x80) b++; return [a, b] as const; };
  const [a, b] = slice(raw, start, end);
  raw = raw.subarray(a, b);
  lo -= a; hi -= a;
  const after: Buffer[] = [];
  let cur = 0;
  for (const r of scoped) { after.push(raw.subarray(cur, r.start - from - a), Buffer.from(r.bytes)); cur = r.end - from - a; }
  after.push(raw.subarray(cur));
  const view = (bytes: Buffer) => { const text = bytes.toString('utf8'); return input.remote ? sanitizeRemoteBody(text, REMOTE_VIEW) : text; };
  const lineOffset = await viewNewlinesBefore(engine, input, rows, region !== regions[0], from + a);
  return { ...editDiff(input.slug, view(raw), view(Buffer.concat(after)), lineOffset), ...(scoped.length < reps.length ? { diff_truncated: true as const } : {}),
    ...(input.remote ? {} : { diff_scope: { byte_start: from + a, byte_end: from + b } }) };
}

/**
 * The segmented branch of edit_page's preparation (spec 6.3): locate the edits by streaming the segments, then splice
 * the touched range through the generation flip (persistence/page-append.ts prepareSegmentedSpliceMutation). Null
 * declines to the whole-body path (locateSegmentedEdits, or a splice that does not apply).
 */
export async function prepareSegmentedEditMutation(engine: BrainEngine, row: WriteRequest, stored: PageSnapshot): Promise<PreparedMutation | null> {
  assertEditRevision(stored.revision, row.intent?.expected_revision);
  const edits = parsePageEdits(row.intent?.edits);
  const within = parseEditWithin(row.intent?.within);
  const { prepareSegmentedSpliceMutation } = await import('./page-append.ts');
  const head = serializePageToMarkdown({ ...withoutBody(stored.page), compiled_truth: '', timeline: '' } as Page, stored.tags).slice(0, -1);
  return prepareSegmentedSpliceMutation(engine, row, stored, { replacements: async page => {
    const located = await locateSegmentedEdits(engine, { sourceId: row.source_id, slug: row.slug, page, edits, within, remote: row.authority.remote, head });
    return located && { replacements: located.replacements, outcome: located.diff };
  } });
}
