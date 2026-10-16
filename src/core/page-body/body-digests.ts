/**
 * Wave B: the drift check of a segmented page whose body is over the
 * single-string ceiling (page-prepare.ts `prepareFileTarget`) compares its
 * canonical file with the stored body by digest, never holding either body as
 * one string. The file side is the streamed importer's pass 1 (`BodyScanner`,
 * which splits the regions exactly as parseMarkdown does) over the file's
 * bytes, then each region's byte ranges through SHA-256; the stored side is
 * the trusted stored body (`readBodyRange`, what readPageSnapshot gives an
 * inline page after the withdrawal overlay), one segment at a time.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { ParseOpts } from '../markdown.ts';
import { BodyScanner, type BodyPiece, type BodyScan } from './body-scan.ts';
import { openSegmentedBody, readBodyRange, type BodyLedger } from './read-range.ts';
import { readGarbageCollector } from './segment-blocks.ts';
import { SEGMENT_MAX_BYTES } from './limits.ts';
import type { BodyRegion } from './types.ts';

const FACTS_MARKER = Buffer.from('gbrain:facts:begin', 'utf8');
const REGIONS: readonly BodyRegion[] = ['truth', 'timeline'];

/**
 * @internal Work a digest comparison does, for the memory-bound tests: file bytes the scan and the region hashes read
 * (`fileBytes`), stored bytes hashed (`segmentBytes`), and the largest single piece handed to a scan or hash
 * (`largestPiece`, at most a segment). Counts, not time.
 */
export const bodyDigestWork = { fileBytes: 0, segmentBytes: 0, largestPiece: 0 };

/** SHA-256 (hex) of each region's UTF-8 bytes. */
export type RegionDigests = Record<BodyRegion, string>;

/** A reading of file bytes: `prefix` (inferred frontmatter, empty when none), then the bytes from `skip` on (past a BOM). */
export interface FileReading { prefix: Uint8Array; skip: number }

export type FileDigests =
  | { kind: 'ok'; parsed: BodyScan['parsed']; digests: RegionDigests; factsFence: boolean }
  | { kind: 'unreadable'; reason: 'invalid_utf8' | 'frontmatter_head_unbounded' };

function count(piece: Uint8Array, field: 'fileBytes' | 'segmentBytes'): Uint8Array {
  bodyDigestWork[field] += piece.length;
  if (piece.length > bodyDigestWork.largestPiece) bodyDigestWork.largestPiece = piece.length;
  return piece;
}

/** Bytes `[start, end)` of the virtual stream, as views (no copies). */
function* virtualSlice(bytes: Uint8Array, reading: FileReading, start: number, end: number): Iterable<Uint8Array> {
  const { prefix, skip } = reading;
  if (start < prefix.length) yield prefix.subarray(start, Math.min(end, prefix.length));
  for (let at = Math.max(start, prefix.length); at < end; at += SEGMENT_MAX_BYTES) {
    yield bytes.subarray(skip + at - prefix.length, skip + Math.min(end, at + SEGMENT_MAX_BYTES) - prefix.length);
  }
}

/** The scan of one reading of the file and the digest of each region; `factsFence` when a region holds a facts fence marker. */
export function fileBodyDigests(bytes: Uint8Array, reading: FileReading, filePath: string, opts: ParseOpts): FileDigests {
  const scanner = new BodyScanner(filePath, opts);
  for (const piece of virtualSlice(bytes, reading, 0, reading.prefix.length + bytes.length - reading.skip)) scanner.push(count(piece, 'fileBytes'));
  const scan = scanner.finish();
  if (scan.kind !== 'ok') return { kind: 'unreadable', reason: scan.kind };
  let factsFence = false;
  const digest = (pieces: readonly BodyPiece[]) => {
    const hash = createHash('sha256');
    let tail = Buffer.alloc(0);
    for (const piece of pieces) {
      const parts = 'text' in piece ? [Buffer.from(piece.text, 'utf8')] : virtualSlice(bytes, reading, piece.start, piece.end);
      for (const part of parts) {
        hash.update(count(part, 'fileBytes'));
        const view = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
        const seam = Buffer.concat([tail, view.subarray(0, FACTS_MARKER.length - 1)]);
        if (view.includes(FACTS_MARKER) || seam.includes(FACTS_MARKER)) factsFence = true;
        tail = Buffer.concat([tail, view.subarray(Math.max(0, view.length - FACTS_MARKER.length + 1))]).subarray(-(FACTS_MARKER.length - 1));
      }
    }
    return hash.digest('hex');
  };
  return { kind: 'ok', parsed: scan.parsed, digests: { truth: digest(scan.truth), timeline: digest(scan.timeline) }, factsFence };
}

/** The digest of each region of a segmented page's trusted stored body under `ledger` (the snapshot's withdrawals), one segment at a time. */
export async function storedBodyDigests(engine: BrainEngine, pageId: number, ledger: BodyLedger): Promise<RegionDigests> {
  const body = await openSegmentedBody(engine, { pageId, ledger });
  const collect = readGarbageCollector();
  const digests = {} as RegionDigests;
  for (const region of REGIONS) {
    const hash = createHash('sha256');
    for await (const piece of readBodyRange(engine, { pageId, space: 'stored', start: 0, end: Infinity, audience: 'trusted', region, body })) {
      hash.update(count(piece.bytes, 'segmentBytes'));
      collect(piece.bytes.length);
    }
    digests[region] = hash.digest('hex');
  }
  return digests;
}
