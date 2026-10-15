/**
 * Pass 1 of streaming ingest (Wave B, spec 3.1): one read of a raw markdown
 * file that decides what parseMarkdown decides, without ever holding the
 * file as one string. Memory is O(longest line) beyond a bounded head.
 *
 * Head. The frontmatter readers run on a prefix `P` of the file (at most
 * FRONTMATTER_HEAD_MAX_BYTES) through the same code parseMarkdown uses
 * (`parseMarkdownHead`, `parsedMarkdownFields`), so frontmatter, title, type,
 * tags, slug and validation findings equal `parseMarkdown(content)`. `P` is the
 * whole file when it fits; otherwise the head up to its last newline (or any
 * prefix when the first non-blank character is not `-`, which no reader can
 * take for a fence). When a reader's fence would close beyond `P`, the result
 * is `frontmatter_head_unbounded` and the caller holds the file as
 * `invalid_frontmatter`. The readers that must close inside `P`: the data
 * fence (`scanDataFrontmatter`), the pre-quote pass's fence (unless no later
 * line closes it, or closing it would change no line), and with `validate`
 * the validator's `---` line. A NUL beyond `P` is added to the findings as
 * parseMarkdown's whole-file NULL_BYTES check would report it.
 *
 * Body. One line iterator runs, in body order, splitBody's state machine
 * (sentinel lines with the quoted-sentinel fallback of
 * findLineOutsideFencedCode, the pending `---` before a Timeline/History H2,
 * the bare timeline section), the body title readers, and fence walks over
 * each candidate region. At EOF the split is final and is reported as byte
 * ranges of the file: concatenating `truth` reproduces exactly
 * `parseMarkdown(content).compiled_truth`, and `timeline` its `.timeline`.
 * splitBody's `.trim()` becomes range endpoints (the first and last
 * non-whitespace code point of each region). The bare section's truth is two
 * ranges (before the section, and from the next H2 on). One rewrite is not a
 * range: when the pre-quote pass rewrites body lines inside `P` (a fence that
 * closes on a later bare `---` line), that part of the body is a `{ text }`
 * piece holding the rewritten text, exactly as parseMarkdown sees it.
 *
 * `body_flags.fence_trust` / `timeline_fence_trust` are scanMarkdownCode's
 * trust of each region's text as stored: no unclosed and no mispaired fence.
 *
 * Not applied here: `sanitizeText` (batch-rows.ts) strips NUL from the stored
 * regions after the split on today's path; the caller applies it per segment
 * in pass 2 (`body_flags.has_nul` says whether it changes anything). Lone
 * surrogates cannot occur: the file must be valid UTF-8 (`invalid_utf8`).
 */
import { scanDataFrontmatter } from '../data-frontmatter.ts';
import { stepFenceWalk, type FenceWalk } from '../fence-scan.ts';
import {
  bareTimelineSectionLine, comparableFrontmatter, embeddedTitleLineValue, FENCE_TOGGLE_RE, frontmatterQuoteFence,
  h1TitleLineValue, isBareTimelineHeading, isTimelineHeadingAfterDash, nullBytesError, parsedMarkdownFields,
  parseMarkdownHead, quoteAmbiguousFrontmatterLine, timelineSentinelKind, validatorFrontmatterFence,
  type ParsedMarkdown, type ParsedMarkdownHead, type ParseOpts,
} from '../markdown.ts';
import { FRONTMATTER_HEAD_MAX_BYTES } from './limits.ts';

/** A file byte range `[start, end)`, or rewritten text the pre-quote pass produced inside the head. */
export type BodyPiece = { start: number; end: number } | { text: string };
export type FenceTrust = 'trusted' | 'void';

export interface BodyFlags {
  /** scanMarkdownCode trust of compiled_truth: 'void' when a fence is unclosed or mispaired. */
  fence_trust: FenceTrust;
  timeline_fence_trust: FenceTrust;
  /** How splitBody split: at a sentinel line, by moving a bare Timeline/History section, or not at all. */
  timeline_split: 'none' | 'sentinel' | 'bare_section';
  has_nul: boolean;
}

export interface BodyScan {
  kind: 'ok';
  /** parseMarkdown(content) without the body regions. */
  parsed: Omit<ParsedMarkdown, 'compiled_truth' | 'timeline'>;
  truth: BodyPiece[];
  timeline: BodyPiece[];
  truthBytes: number;
  timelineBytes: number;
  /** Lines of the stored stream (truth then timeline, no separator): newlines + 1, or 0 when empty. */
  bodyLines: number;
  totalBytes: number;
  bodyFlags: BodyFlags;
}

export type HeadReader = 'first_line' | 'data_fence' | 'quote_fence' | 'validator_fence';

export type BodyScanResult =
  | BodyScan
  | { kind: 'frontmatter_head_unbounded'; reader: HeadReader; message: string }
  | { kind: 'invalid_utf8'; offset: number };

type BodyScanRefusal = Exclude<BodyScanResult, BodyScan>;

/** A position in the virtual body (literal piece, then file bytes) and the 0-based line holding it. */
interface Pos { byte: number; line: number }

interface Line {
  index: number;
  start: number;
  text: string;
  hasNewline: boolean;
  /** First non-whitespace code point, or null for a blank line. */
  contentStart: Pos | null;
  /** End of the last non-whitespace code point. */
  contentEnd: Pos | null;
}

/** scanMarkdownCode's fence pairing over a region's text, fed line by line with the region's trim applied. */
class RegionFenceWalk {
  private walk: FenceWalk = { opener: null, mispaired: false };
  /** The region's last content line so far, not yet stepped: the trailing trim may still shorten it. */
  private pending: string | null = null;

  push(line: Line): void {
    if (!line.contentStart) return;
    if (this.pending === null) {
      this.pending = line.text.trimStart();
      return;
    }
    stepRegionLine(this.walk, this.pending);
    this.pending = line.text;
  }

  clone(): RegionFenceWalk {
    const copy = new RegionFenceWalk();
    copy.walk = { ...this.walk };
    copy.pending = this.pending;
    return copy;
  }

  trust(): FenceTrust {
    const walk = { ...this.walk };
    if (this.pending !== null) stepRegionLine(walk, this.pending.trimEnd());
    return walk.opener || walk.mispaired ? 'void' : 'trusted';
  }
}

/** scanMarkdownCode ends lines at CR too; stepFenceWalk takes '\n' lines. */
function stepRegionLine(walk: FenceWalk, text: string): void {
  for (const sub of text.split('\r')) stepFenceWalk(walk, sub);
}

interface SentinelCandidate {
  line: Line;
  /** Last content before the sentinel line (truth end), null when nothing precedes it. */
  truthEnd: Pos | null;
  truthWalk: RegionFenceWalk;
  timelineFirst: Pos | null;
  timelineWalk: RegionFenceWalk;
}

interface BareCandidate {
  line: Line;
  bullets: number;
  truthEnd: Pos | null;
  truthWalk: RegionFenceWalk;
  timelineWalk: RegionFenceWalk;
}

interface BareSection extends BareCandidate {
  /** Start of the next H2 (null when the section runs to EOF) and the last content before it. */
  end: Pos | null;
  timelineEnd: Pos;
}

interface QuoteWatch { anyBefore: boolean; prev: boolean; prevChanged: boolean }

const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Offset of the first byte that is not valid UTF-8 (an incomplete tail counts only when `final`), or -1. */
export function firstInvalidUtf8(bytes: Uint8Array, final = true): number {
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    const need = b < 0x80 ? 0 : b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
    if (need < 0) return i;
    const lo = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80;
    const hi = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;
    for (let k = 1; k <= need; k++) {
      if (i + k >= bytes.length) return final ? i : -1;
      const c = bytes[i + k]!;
      if (k === 1 ? c < lo || c > hi : (c & 0xc0) !== 0x80) return i;
    }
    i += need + 1;
  }
  return -1;
}

/**
 * Push-based pass 1. `push` the raw file bytes in order (any chunking), then
 * `finish`. Throws FrontmatterLanguageError exactly where parseMarkdown would.
 */
export class BodyScanner {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private refusal: BodyScanRefusal | null = null;
  private headParts: Uint8Array[] = [];
  private totalBytes = 0;
  private started = false;

  private head!: ParsedMarkdownHead;
  /** File bytes the head prefix `P` covers; later lines are checked by the quote watch. */
  private headEnd = 0;
  private literalBytes = 0;
  private literalNewlines = 0;
  private bodyFileStart = 0;
  private fileNewlinesBeforeBody = 0;
  private firstNulLine: number | null = null;
  private hasNul = false;
  private quoteWatch: QuoteWatch | null = null;

  private carry: Uint8Array[] = [];
  private carryBytes = 0;
  private pos = 0;
  private lineIndex = 0;

  private firstContent: Line | null = null;
  private lastContentEnd: Pos | null = null;
  private readonly allWalk = new RegionFenceWalk();

  private readonly sentinelWalk: FenceWalk = { opener: null, mispaired: false };
  private decided: SentinelCandidate | null = null;
  private firstQuoted: SentinelCandidate | null = null;
  private firstOutside: SentinelCandidate | null = null;
  private pendingDash: { candidate: SentinelCandidate; opener: boolean; mispaired: boolean } | null = null;

  private inFence = false;
  private bareCandidate: BareCandidate | null = null;
  private bare: BareSection | null = null;

  private bodyTitle: string | null = null;
  private readonly embedded = { state: 'start' as 'start' | 'block' | 'done', opener: -1, first: null as string | null, title: '' };

  constructor(private readonly filePath?: string, private readonly opts?: ParseOpts) {}

  push(chunk: Uint8Array): void {
    if (this.refusal || chunk.length === 0) return;
    this.totalBytes += chunk.length;
    if (this.started) return this.feed(chunk);
    this.headParts.push(chunk);
    if (this.totalBytes > FRONTMATTER_HEAD_MAX_BYTES) this.startBody(false);
  }

  finish(): BodyScanResult {
    if (!this.refusal && !this.started) this.startBody(true);
    if (!this.refusal) this.onLine(concatBytes(this.carry, this.carryBytes), false);
    return this.refusal ?? this.compose();
  }

  private startBody(complete: boolean): void {
    this.started = true;
    const all = concatBytes(this.headParts, this.totalBytes);
    this.headParts = [];
    const headBytes = complete ? all : all.subarray(0, FRONTMATTER_HEAD_MAX_BYTES);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(headBytes, { stream: !complete });
    } catch {
      this.refusal = { kind: 'invalid_utf8', offset: firstInvalidUtf8(headBytes, complete) };
      return;
    }
    const firstContent = text.search(/\S/);
    const bounded = !complete && (firstContent === -1 || text[firstContent] === '-');
    const prefix = bounded ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
    if (bounded && !/\S/.test(prefix)) return this.unbounded('first_line');
    const head = parseMarkdownHead(prefix, this.opts);
    this.head = head;
    this.headEnd = utf8(prefix);
    if (bounded) {
      let data: ReturnType<typeof scanDataFrontmatter> | null;
      try { data = scanDataFrontmatter(head.safeContent); } catch { data = null; }
      if (data?.fenced && data.fenced.content === null) return this.unbounded('data_fence');
      if (this.opts?.validate) {
        const fence = validatorFrontmatterFence(prefix.split('\n'));
        if (fence.opens && fence.closeLine === -1) return this.unbounded('validator_fence');
      }
      if (frontmatterQuoteFence(head.lifted) === 'open') {
        const watch = { anyBefore: false, prev: false, prevChanged: false };
        const lines = head.lifted.split('\n');
        for (let k = 1; k < lines.length - 1; k++) watchQuoteLine(watch, lines[k]!);
        this.quoteWatch = watch;
      }
    }
    if (prefix.endsWith(head.body)) {
      this.bodyFileStart = this.headEnd - utf8(head.body);
    } else {
      const literal = Buffer.from(head.body, 'utf8');
      this.literalBytes = literal.length;
      for (let k = 0; k < literal.length; k++) if (literal[k] === 10) this.literalNewlines++;
      this.bodyFileStart = this.headEnd;
      this.feed(literal);
    }
    for (let k = 0; k < this.bodyFileStart; k++) if (all[k] === 10) this.fileNewlinesBeforeBody++;
    this.feed(all.subarray(this.bodyFileStart));
  }

  private unbounded(reader: HeadReader): void {
    const what = reader === 'first_line' ? 'the first line' : 'the frontmatter block';
    this.refusal = { kind: 'frontmatter_head_unbounded', reader,
      message: `Frontmatter not readable: ${what} does not end within the first ${FRONTMATTER_HEAD_MAX_BYTES} bytes.` };
  }

  /** Split virtual body bytes into '\n' lines (body.split('\n') semantics; the last line arrives in `finish`). */
  private feed(bytes: Uint8Array): void {
    let from = 0;
    while (!this.refusal) {
      const nl = bytes.indexOf(10, from);
      if (nl === -1) {
        if (from < bytes.length) {
          this.carry.push(bytes.slice(from));
          this.carryBytes += bytes.length - from;
        }
        return;
      }
      const piece = bytes.subarray(from, nl);
      if (this.carryBytes > 0) {
        this.carry.push(piece);
        const line = concatBytes(this.carry, this.carryBytes + piece.length);
        this.carry = [];
        this.carryBytes = 0;
        this.onLine(line, true);
      } else {
        this.onLine(piece, true);
      }
      from = nl + 1;
    }
  }

  /** File offset of virtual body byte `v` (the literal piece, when any, precedes the file bytes). */
  private fileOffset(v: number): number {
    return v - this.literalBytes + this.bodyFileStart;
  }

  private onLine(bytes: Uint8Array, hasNewline: boolean): void {
    const start = this.pos;
    const index = this.lineIndex++;
    this.pos = start + bytes.length + (hasNewline ? 1 : 0);
    const inFile = start >= this.literalBytes;
    let text: string;
    try {
      text = this.decoder.decode(bytes);
    } catch {
      this.refusal = { kind: 'invalid_utf8', offset: this.fileOffset(start) + firstInvalidUtf8(bytes) };
      return;
    }
    if (bytes.indexOf(0) !== -1) {
      this.hasNul = true;
      if (inFile && this.firstNulLine === null) this.firstNulLine = this.fileNewlinesBeforeBody + index - this.literalNewlines + 1;
    }
    if (this.quoteWatch && inFile && this.fileOffset(start) >= this.headEnd) {
      if (text === '---' || (text === '---\r' && hasNewline)) {
        if (this.quoteWatch.anyBefore || this.quoteWatch.prevChanged) return this.unbounded('quote_fence');
        this.quoteWatch = null;
      } else {
        watchQuoteLine(this.quoteWatch, text);
      }
    }
    const lead = text.search(/\S/);
    let contentStart: Pos | null = null;
    let contentEnd: Pos | null = null;
    if (lead !== -1) {
      const trailing = text.length - text.trimEnd().length;
      contentStart = { byte: start + utf8(text.slice(0, lead)), line: index };
      contentEnd = { byte: start + bytes.length - utf8(text.slice(text.length - trailing)), line: index };
    }
    this.step({ index, start, text, hasNewline, contentStart, contentEnd });
  }

  private newCandidate(line: Line): SentinelCandidate {
    return { line, truthEnd: this.lastContentEnd, truthWalk: this.allWalk.clone(), timelineFirst: null, timelineWalk: new RegionFenceWalk() };
  }

  /** findLineOutsideFencedCode's decision for one candidate line, given the fence walk before it. */
  private register(candidate: SentinelCandidate, opener: boolean, mispaired: boolean): void {
    if (this.decided) return;
    if (!opener) {
      if (!this.firstQuoted || mispaired) {
        this.decided = this.firstQuoted ?? candidate;
        this.firstOutside ??= candidate;
        return;
      }
      this.firstOutside ??= candidate;
    } else {
      this.firstQuoted ??= candidate;
    }
  }

  private step(line: Line): void {
    const { text, contentStart } = line;
    const trimmed = contentStart ? text.trim() : '';

    if (this.pendingDash && contentStart) {
      const { candidate, opener, mispaired } = this.pendingDash;
      this.pendingDash = null;
      if (isTimelineHeadingAfterDash(trimmed)) this.register(candidate, opener, mispaired);
    }
    if (!this.decided && contentStart) {
      const kind = timelineSentinelKind(trimmed);
      const opener = this.sentinelWalk.opener !== null;
      const mispaired = this.sentinelWalk.mispaired;
      if (kind === 'marker') this.register(this.newCandidate(line), opener, mispaired);
      else if (kind === 'dash' && this.firstContent) this.pendingDash = { candidate: this.newCandidate(line), opener, mispaired };
    }
    if (!this.decided) stepFenceWalk(this.sentinelWalk, text);
    for (const candidate of new Set([this.firstQuoted, this.firstOutside])) {
      if (!candidate || candidate.line.index >= line.index) continue;
      if (!candidate.timelineFirst && contentStart) candidate.timelineFirst = contentStart;
      candidate.timelineWalk.push(line);
    }

    const toggle = FENCE_TOGGLE_RE.test(text);
    const inFence = this.inFence;
    if (toggle) this.inFence = !inFence;
    this.stepBare(line, toggle || inFence);
    if (this.bodyTitle === null && !toggle && !inFence) this.bodyTitle = h1TitleLineValue(text);
    this.stepEmbeddedTitle(line);

    this.allWalk.push(line);
    if (contentStart) {
      this.firstContent ??= line;
      this.lastContentEnd = line.contentEnd;
    }
  }

  /** findBareTimelineSection, one line at a time; `skip` is a fence toggle or a line inside the toggled fence. */
  private stepBare(line: Line, skip: boolean): void {
    if (this.bare) {
      this.bare.truthWalk.push(line);
      return;
    }
    const pending = this.bareCandidate;
    if (pending) {
      const kind = bareTimelineSectionLine(line.text, pending.bullets);
      if (kind === 'end' || kind === 'other') {
        this.bareCandidate = null;
        if (kind === 'end' && pending.bullets > 0) {
          this.bare = { ...pending, end: { byte: line.start, line: line.index }, timelineEnd: this.lastContentEnd! };
          this.bare.truthWalk.push(line);
          return;
        }
      } else {
        if (kind === 'bullet') pending.bullets++;
        pending.timelineWalk.push(line);
      }
    }
    if (skip || !this.firstContent || !isBareTimelineHeading(line.text)) return;
    const timelineWalk = new RegionFenceWalk();
    timelineWalk.push(line);
    this.bareCandidate = { line, bullets: 0, truthEnd: this.lastContentEnd, truthWalk: this.allWalk.clone(), timelineWalk };
  }

  /** inferTitleFromEmbeddedFrontmatter, one line at a time. */
  private stepEmbeddedTitle(line: Line): void {
    const e = this.embedded;
    if (e.state === 'start') {
      if (!line.contentStart) return;
      e.state = line.hasNewline && /^---[ \t]*\r?$/.test(line.text.trimStart()) ? 'block' : 'done';
      e.opener = line.index;
    } else if (e.state === 'block') {
      const closes = /^---[ \t]*$/.test(line.text) || (line.hasNewline && /^---[ \t]*\r$/.test(line.text));
      if (line.index >= e.opener + 2 && closes) {
        e.title = e.first ?? '';
        e.state = 'done';
      } else if (e.first === null) {
        e.first = embeddedTitleLineValue(line.text);
      }
    }
  }

  private compose(): BodyScan {
    const last = this.lastContentEnd;
    if (this.bareCandidate && this.bareCandidate.bullets > 0) this.bare = { ...this.bareCandidate, end: null, timelineEnd: last! };
    const sentinel = this.decided
      ?? (this.sentinelWalk.opener !== null || this.sentinelWalk.mispaired ? this.firstQuoted : this.firstOutside);
    const first = this.firstContent?.contentStart ?? null;
    let truth: Array<[Pos, Pos]> = [];
    let timeline: Array<[Pos, Pos]> = [];
    let flags: Omit<BodyFlags, 'has_nul'>;
    if (sentinel) {
      if (first && sentinel.truthEnd) truth = [[first, sentinel.truthEnd]];
      if (sentinel.line.hasNewline && sentinel.timelineFirst && last) timeline = [[sentinel.timelineFirst, last]];
      flags = { fence_trust: sentinel.truthWalk.trust(), timeline_fence_trust: sentinel.timelineWalk.trust(), timeline_split: 'sentinel' };
    } else if (this.bare && first) {
      const bare = this.bare;
      truth = bare.end && last && last.line >= bare.end.line
        ? [[first, { byte: bare.line.start, line: bare.line.index }], [bare.end, last]]
        : [[first, bare.truthEnd!]];
      timeline = [[bare.line.contentStart!, bare.timelineEnd]];
      flags = { fence_trust: bare.truthWalk.trust(), timeline_fence_trust: bare.timelineWalk.trust(), timeline_split: 'bare_section' };
    } else {
      if (first && last) truth = [[first, last]];
      flags = { fence_trust: this.allWalk.trust(), timeline_fence_trust: 'trusted', timeline_split: 'none' };
    }
    const bytes = (ranges: Array<[Pos, Pos]>) => ranges.reduce((n, [a, b]) => n + b.byte - a.byte, 0);
    const newlines = (ranges: Array<[Pos, Pos]>) => ranges.reduce((n, [a, b]) => n + b.line - a.line, 0);
    const truthBytes = bytes(truth);
    const timelineBytes = bytes(timeline);
    const head = this.head;
    if (this.opts?.validate && this.firstNulLine !== null && !head.errors.some(error => error.code === 'NULL_BYTES')) {
      head.errors.unshift(nullBytesError(this.firstNulLine));
    }
    const bodyTitle = this.bodyTitle;
    const embeddedTitle = this.embedded.title;
    return {
      kind: 'ok',
      parsed: {
        frontmatter: comparableFrontmatter(head.frontmatter),
        ...parsedMarkdownFields(head, () => bodyTitle || embeddedTitle, this.filePath, this.opts),
      },
      truth: this.pieces(truth),
      timeline: this.pieces(timeline),
      truthBytes,
      timelineBytes,
      bodyLines: truthBytes + timelineBytes === 0 ? 0 : newlines(truth) + newlines(timeline) + 1,
      totalBytes: this.totalBytes,
      bodyFlags: { ...flags, has_nul: this.hasNul },
    };
  }

  /** Virtual ranges as file ranges, with any part inside the literal piece as text. */
  private pieces(ranges: Array<[Pos, Pos]>): BodyPiece[] {
    const out: BodyPiece[] = [];
    const literal = this.literalBytes > 0 ? Buffer.from(this.head.body, 'utf8') : null;
    for (const [a, b] of ranges) {
      if (literal && a.byte < this.literalBytes) {
        out.push({ text: literal.subarray(a.byte, Math.min(b.byte, this.literalBytes)).toString('utf8') });
        if (b.byte > this.literalBytes) out.push({ start: this.bodyFileStart, end: this.fileOffset(b.byte) });
      } else {
        out.push({ start: this.fileOffset(a.byte), end: this.fileOffset(b.byte) });
      }
    }
    return out;
  }
}

/**
 * The pre-quote pass's view of fence lines when its fence did not close in the
 * head: whether closing it on the next line would change any line so far.
 * Every line keeps its CR except the one just before the closing `---`, which
 * the pass rebuilds without its CR (and then may rewrite).
 */
function watchQuoteLine(watch: QuoteWatch, text: string): void {
  watch.anyBefore ||= watch.prev;
  watch.prev = quoteAmbiguousFrontmatterLine(text) !== null;
  watch.prevChanged = text.endsWith('\r') || quoteAmbiguousFrontmatterLine(text) !== null;
}

/** Pass 1 over a streamed file. */
export async function scanMarkdownBody(source: AsyncIterable<Uint8Array>, filePath?: string, opts?: ParseOpts): Promise<BodyScanResult> {
  const scanner = new BodyScanner(filePath, opts);
  for await (const chunk of source) scanner.push(chunk);
  return scanner.finish();
}

/** The text of `pieces` read from the file bytes. */
export function readBodyPieces(pieces: readonly BodyPiece[], file: Uint8Array): string {
  return pieces.map(piece => 'text' in piece ? piece.text : Buffer.from(file.buffer, file.byteOffset + piece.start, piece.end - piece.start).toString('utf8')).join('');
}

/** String form: the scan plus both regions read back as text (tests and the in-memory `put_page` path). */
export function scanMarkdownString(content: string, filePath?: string, opts?: ParseOpts):
  (BodyScan & { text: { compiled_truth: string; timeline: string } }) | BodyScanRefusal {
  const bytes = Buffer.from(content, 'utf8');
  const scanner = new BodyScanner(filePath, opts);
  scanner.push(bytes);
  const scan = scanner.finish();
  if (scan.kind !== 'ok') return scan;
  return { ...scan, text: { compiled_truth: readBodyPieces(scan.truth, bytes), timeline: readBodyPieces(scan.timeline, bytes) } };
}
