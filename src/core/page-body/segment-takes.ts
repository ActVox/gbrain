/**
 * Segmented page storage (Wave B, spec 8.2 fences, PR 2 full-pass mode):
 * parseTakesFence over a body read block by block (segment-blocks.ts).
 *
 * parseTakesFence reads only the first begin marker outside code, the first
 * end marker outside code after it, and the text between them (or, with no
 * begin, whether an end or a near-miss marker exists). A block starts outside
 * code, so each marker is located in its block; only the fence itself is
 * kept, joined across blocks up to BLOCK_MAX_BYTES, and parsed. The raw
 * marker scans the callers gate on (`includes`) are reported alongside.
 */
import { indexOfOutsideCode } from '../fence-scan.ts';
import { parseTakesFence, TAKES_FENCE_BEGIN, TAKES_FENCE_END, type ParseResult } from '../takes-fence.ts';
import { BLOCK_MAX_BYTES, blockTooLargeError, segmentedPassWork, type BodyBlock } from './segment-blocks.ts';

export interface StreamedTakes {
  parsed: ParseResult;
  /** The body contains TAKES_FENCE_BEGIN anywhere (in code too). */
  hasBegin: boolean;
  /** The body contains `gbrain:takes:` anywhere. */
  hasMarker: boolean;
}

export async function parseTakesFenceBlocks(blocks: AsyncIterable<BodyBlock>, page: { slug: string; source_id: string }): Promise<StreamedTakes> {
  let fence: string[] | null = null;
  let fenceChars = 0;
  let endOnly = false;
  let nearMiss = false;
  let hasBegin = false;
  let hasMarker = false;
  for await (const { text, at } of blocks) {
    hasBegin ||= text.includes(TAKES_FENCE_BEGIN);
    hasMarker ||= text.includes('gbrain:takes:');
    if (!hasMarker) continue;
    let from = 0;
    let search = 0;
    if (!fence) {
      const begin = indexOfOutsideCode(text, TAKES_FENCE_BEGIN);
      if (begin === -1) {
        // parseTakesFence's end search with no begin starts at TAKES_FENCE_BEGIN.length - 1.
        endOnly ||= indexOfOutsideCode(text, TAKES_FENCE_END, Math.max(0, TAKES_FENCE_BEGIN.length - 1 - at)) !== -1;
        nearMiss ||= indexOfOutsideCode(text, 'gbrain:takes:begin') !== -1;
        continue;
      }
      fence = [];
      from = begin;
      search = begin + TAKES_FENCE_BEGIN.length;
    }
    const end = indexOfOutsideCode(text, TAKES_FENCE_END, search);
    const piece = text.slice(from, end === -1 ? text.length : end + TAKES_FENCE_END.length);
    fenceChars += piece.length;
    segmentedPassWork.carry += piece.length;
    if (fenceChars > BLOCK_MAX_BYTES) throw blockTooLargeError(page.slug, page.source_id, fenceChars);
    fence.push(piece);
    if (end !== -1) return { parsed: parseTakesFence(fence.join('')), hasBegin, hasMarker };
  }
  const reduced = fence ? TAKES_FENCE_BEGIN : endOnly ? `${'\n'.repeat(TAKES_FENCE_BEGIN.length)}${TAKES_FENCE_END}` : nearMiss ? 'gbrain:takes:begin' : '';
  return { parsed: parseTakesFence(reduced), hasBegin, hasMarker };
}
