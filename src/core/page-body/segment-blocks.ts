/**
 * Segmented page storage (Wave B, spec 8, PR 2 full-pass mode): a segmented
 * page's trusted body for the derived passes (links, timeline, mentions,
 * takes), one block at a time, never the whole body as one string.
 *
 * The text is the joined body `${compiled_truth}\n${timeline}` (or the regions
 * and separator a pass names) after the withdrawal overlay, read with
 * `readBodyRange` (stored space, trusted audience): what readPageSnapshot gives
 * a trusted reader of an inline page. A block is one segment, or a run of
 * segments joined across forced cuts, so every block starts where the
 * segmenter's parsers start fresh: outside code fences, protected regions,
 * fence blocks, timeline detail runs and conversation messages. A run of
 * forced cuts longer than BLOCK_MAX_BYTES (a line or fence many segments long)
 * refuses with `page_body_segmented`; a facts fence crossing a forced cut while
 * the source has withdrawals refuses with `page_projection_stale` (read-range.ts).
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { SEGMENT_MAX_BYTES } from './limits.ts';
import { openSegmentedBody, readBodyRange } from './read-range.ts';
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
}

/** `page_body_segmented`: a run a derived pass must read whole is over BLOCK_MAX_BYTES. */
export function blockTooLargeError(slug: string, sourceId: string, bytes: number) {
  return opError('page_body_segmented',
    `Page ${slug} (source ${sourceId}) has a ${bytes}-byte run a derived pass must read whole (a line or fence longer than a segment), over its ${BLOCK_MAX_BYTES}-byte bound. Nothing was derived from it.`,
    'Break the long line or fence into shorter lines and write the page again.');
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
    const rows = body.rows.filter(row => row.region === region);
    for (let i = 0; i < rows.length;) {
      let j = i;
      while (j + 1 < rows.length && forced.has(rows[j]!.seq)) j++;
      const start = rows[i]!.byteStart;
      const end = rows[j]!.byteStart + rows[j]!.byteLen;
      if (end - start > BLOCK_MAX_BYTES) throw blockTooLargeError(page.slug, body.sourceId, end - start);
      const parts: Buffer[] = [];
      for await (const piece of readBodyRange(engine, { pageId: body.pageId, space: 'stored', start, end, audience: 'trusted', region, body })) parts.push(piece.bytes);
      const text = Buffer.concat(parts).toString('utf8');
      collect(end - start);
      yield { region, text, at };
      at += text.length;
      i = j + 1;
    }
  }
}

/** The first `chars` UTF-16 units of a segmented page's trusted compiled truth, reading at most 4 x `chars` + 4 bytes. */
export async function truthLead(engine: BrainEngine, pageId: number, chars: number): Promise<string> {
  const parts: Buffer[] = [];
  for await (const piece of readBodyRange(engine, { pageId, space: 'stored', start: 0, end: 4 * chars + 4, audience: 'trusted', region: 'truth' })) parts.push(piece.bytes);
  return new TextDecoder().decode(Buffer.concat(parts)).slice(0, chars);
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
