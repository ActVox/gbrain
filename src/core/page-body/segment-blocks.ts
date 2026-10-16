/**
 * Segmented page storage (Wave B, spec 8, PR 2 full-pass mode): a segmented
 * page's trusted body for the derived passes (links, timeline, mentions,
 * takes), one block at a time, never the whole body as one string.
 *
 * The text is the joined body `${compiled_truth}\n${timeline}` (or the regions
 * and separator a pass names) after the withdrawal overlay, read with
 * `trustedSegments` (read-range.ts, the trusted stored read): what readPageSnapshot
 * gives a trusted reader of an inline page. The manifest is walked once per
 * region. A block is one segment, or a run of segments joined across forced
 * cuts that fell where the segmenter's parsers do not start fresh, so every
 * block starts outside code fences, protected regions, fence blocks, timeline
 * detail runs and long lines. A forced cut after a `\n` before a line the
 * segmenter's no-cut rules allow (`cutBlocked` on the next segment's entry
 * state and first line, as a structural cut is judged) is a block boundary:
 * ordinary short lines or dated bullets with no structural candidate are cut
 * only by force. A joined run longer than BLOCK_MAX_BYTES (a line or fence many
 * segments long) refuses with `page_body_segmented`; a facts fence crossing a
 * forced cut while the source has withdrawals refuses with
 * `page_projection_stale` (read-range.ts).
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { SEGMENT_MAX_BYTES } from './limits.ts';
import { bodyRowWork, openSegmentedBody, readBodyRange, trustedSegments, type TrustedSegment } from './read-range.ts';
import { cutBlocked } from './segmenter.ts';
import { readEntryState } from './entry-state.ts';
import type { BodyRegion } from './types.ts';

/** Bytes a pass reads between two full collections (ingest.ts collectBatchGarbage: one per 4 MiB staging batch). */
const COLLECT_EVERY_BYTES = 4 * 1024 * 1024;

/**
 * A full collection every COLLECT_EVERY_BYTES read. Each segment read leaves garbage several times its size (driver
 * buffers, decoded texts), and JSC sizes its threshold to a heap PGLite's WASM memory makes large, so a pass over a
 * 40 MiB page peaked ~0.8 GB above its live heap without this. Feed it the bytes of each piece read.
 */
export function readGarbageCollector(): (bytes: number) => void {
  let since = 0;
  return bytes => {
    since += bytes;
    if (since < COLLECT_EVERY_BYTES) return;
    since = 0;
    Bun.gc(true);
  };
}

/**
 * @internal Work the derived passes do over a segmented body, for the linearity test: bytes read (`bytes`), UTF-16
 * units of the blocks yielded (`blocks`) and of the link-extraction windows built around them (`windows`), and units a
 * pass copies past its block (`carry`: a takes fence joined across blocks, the watermark planner's tail window),
 * and bytes scanned for the first line after a forced cut (`lines`). Counts, not time, so a busy machine cannot move them.
 */
export const segmentedPassWork = { bytes: 0, blocks: 0, windows: 0, carry: 0, lines: 0 };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The longest run of segments joined across forced cuts that a pass holds as one string. */
export const BLOCK_MAX_BYTES = 8 * SEGMENT_MAX_BYTES;

export interface BodyBlock {
  /** The block's region; null for the separator between two regions. */
  region: BodyRegion | null;
  text: string;
  /** UTF-16 offset of `text` in the joined text. */
  at: number;
}

export interface BodyBlockOptions {
  /** Regions in order (default: truth, then timeline). */
  regions?: readonly BodyRegion[];
  /** Text between two regions (default '\n', as in `${compiled_truth}\n${timeline}`). */
  separator?: string;
  /**
   * Read only the runs this accepts (the manifest seqs of a run of segments joined by forced cuts, one block or more,
   * and whether it is its region's first); it is asked as each run is reached, so it may depend on the blocks already
   * read. A block after a skipped run has `at` NaN.
   */
  want?: (run: { seqs: readonly number[]; first: boolean }) => boolean;
}

/** `page_body_segmented`: a run a derived pass must read whole is over BLOCK_MAX_BYTES. */
export function blockTooLargeError(slug: string, sourceId: string, bytes: number) {
  return opError('page_body_segmented',
    `Page ${slug} (source ${sourceId}) has a ${bytes}-byte run a derived pass must read whole (a line or fence longer than a segment), over its ${BLOCK_MAX_BYTES}-byte bound. Nothing was derived from it.`,
    'Break the long line or fence into shorter lines and write the page again.');
}

/**
 * Whether the segment after a forced cut starts a block: the cut fell after a `\n` (not inside a line longer than a
 * segment, not after a bare `\r`) and a structural cut before the segment's first line would have been allowed
 * (`cutBlocked` on its stored entry state, the parser state at the cut). Pages of another segmenter version never do.
 */
function freshAfterForcedCut(previous: Uint8Array, seg: TrustedSegment, stale: boolean): boolean {
  if (stale || previous[previous.length - 1] !== 0x0a) return false;
  const entry = readEntryState(seg.entryState);
  if (!entry) return false;
  let end = 0;
  while (end < seg.raw.length && seg.raw[end] !== 0x0a && seg.raw[end] !== 0x0d) end++;
  segmentedPassWork.lines += end;
  return !cutBlocked(entry, utf8.decode(seg.raw.subarray(0, end)));
}

export async function* bodyBlocks(engine: BrainEngine, page: { id: number; slug: string; source_id?: string },
  opts: BodyBlockOptions = {}): AsyncIterable<BodyBlock> {
  const body = await openSegmentedBody(engine, { pageId: Number(page.id) });
  const forced = new Set((await engine.executeRaw<{ seq: number }>(`SELECT seq FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL
      AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2) AND cut_kind='forced'`, [body.pageId, body.generation])).map(row => Number(row.seq)));
  const collect = readGarbageCollector();
  let at = 0;
  for (const [n, region] of (opts.regions ?? ['truth', 'timeline'] as const).entries()) {
    if (n > 0) {
      const separator = opts.separator ?? '\n';
      yield { region: null, text: separator, at };
      at += separator.length;
    }
    bodyRowWork.visits += body.rows.length;
    const rows = body.rows.filter(row => row.region === region);
    for (let i = 0; i < rows.length;) {
      let j = i;
      while (j + 1 < rows.length && forced.has(rows[j]!.seq)) j++;
      bodyRowWork.visits += j - i + 1;
      if (opts.want && !opts.want({ seqs: rows.slice(i, j + 1).map(row => row.seq), first: i === 0 })) {
        at = NaN;
        i = j + 1;
        continue;
      }
      let parts: Buffer[] = [];
      let start = rows[i]!.byteStart;
      let previous: Uint8Array | null = null;
      const flush = (end: number): BodyBlock => {
        const text = Buffer.concat(parts).toString('utf8');
        collect(end - start);
        segmentedPassWork.bytes += end - start;
        segmentedPassWork.blocks += text.length;
        const block = { region, text, at };
        at += text.length;
        parts = [];
        start = end;
        return block;
      };
      for await (const seg of trustedSegments(engine, body, rows.slice(i, j + 1))) {
        bodyRowWork.visits++;
        if (previous && freshAfterForcedCut(previous, seg, body.stale)) yield flush(seg.row.byteStart);
        const end = seg.row.byteStart + seg.row.byteLen;
        if (end - start > BLOCK_MAX_BYTES) throw blockTooLargeError(page.slug, body.sourceId, end - start);
        for (const piece of seg.pieces) parts.push(Buffer.from(piece.text, 'utf8'));
        previous = seg.raw;
      }
      yield flush(rows[j]!.byteStart + rows[j]!.byteLen);
      i = j + 1;
    }
  }
}

/** The first `chars` UTF-16 units of a segmented page's trusted compiled truth, reading at most 4 x `chars` + 4 bytes. */
export async function truthLead(engine: BrainEngine, pageId: number, chars: number): Promise<string> {
  const parts: Buffer[] = [];
  for await (const piece of readBodyRange(engine, { pageId, space: 'stored', start: 0, end: 4 * chars + 4, audience: 'trusted', region: 'truth' })) parts.push(piece.bytes);
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(parts)).slice(0, chars);
}

/**
 * A copy of `value` whose strings share nothing with a block's text: a substring (slice, regex match) keeps its whole
 * parent alive (segmenter.ts `detached`), so a result a pass keeps past its block (a link candidate's context, a
 * timeline entry) would pin that block, and a page's results would pin the page. Plain objects and arrays are copied.
 */
export function detachedValue<T>(value: T): T {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('utf8') as T;
  if (Array.isArray(value)) return value.map(detachedValue) as T;
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) copy[key] = detachedValue(field);
  return copy as T;
}
