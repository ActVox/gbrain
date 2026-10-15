/**
 * The segmenter is linear in the input, and appending through a stored entry
 * state is linear in the appended text (plus one segment).
 *
 * 1. Protects: ingest of a 256 MB page and repeated appends to a large page
 *    stay O(bytes); a cut decision that rescans the open segment, or an
 *    append that resegments the page, would make both quadratic.
 * 2. Fails when: doubling the input more than 2.5x the CPU time (linear is
 *    2x, quadratic 4x), for prose, short lines, one newline-free line, a
 *    giant fence, an unterminated protected region and key-dense text.
 * 3. Forced probes: the same ratio check run on a cut search that rescans
 *    everything pushed so far, and on an append path that resegments the whole
 *    prefix on each append (the quadratic variants), exceeds the bound, so the
 *    check can tell the two apart.
 * 4. After one warm-up run of each size, the ratio is the median of three
 *    rounds, each the best of three runs per size in thread CPU time
 *    (cpuScalingRatio).
 * 5. Measured (8 runs, 4 in parallel on a 4-core machine): every shape and the
 *    resuming append 1.84-2.18x; the probes, a cut search that rescans the
 *    pushed input 2.85-3.04x and whole-page resegmenting per append 3.52-3.77x.
 */
import { describe, expect, test } from 'bun:test';
import { initialEntryState } from '../../src/core/page-body/entry-state.ts';
import { Segmenter, segmentString, type SegmentOut } from '../../src/core/page-body/segmenter.ts';
import { cpuScalingRatio } from '../helpers/cpu-time.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { bigPage, PEM_BLOCK, segmentOptions } from '../helpers/segment-bodies.ts';

const MB = 1024 * 1024;
const BOUND = 2.5;
const entry = () => initialEntryState({ region: 'truth' });

function ratio(make: (bytes: number) => string, small: number, run: (body: string) => unknown): number {
  const a = make(small);
  const b = make(2 * small);
  return cpuScalingRatio(() => run(a), () => run(b));
}

const page = bigPage(mulberry32(7), 4.5 * MB);
const prefix = (bytes: number) => page.slice(0, page.indexOf('\n', bytes) + 1);
const segmentAll = (body: string) => segmentString(body, entry(), segmentOptions('trusted'));

/** Segment `body` in 256 KiB pushes, keeping only a count (ingest streams segments out; holding them all would time the GC). */
function segmentStreaming(body: string): number {
  const seg = new Segmenter(entry(), segmentOptions('trusted'));
  let n = 0;
  for (let i = 0; i < body.length; i += 256 * 1024) n += seg.push(body.slice(i, i + 256 * 1024)).length;
  return n + seg.finish().length;
}

/**
 * The quadratic cut search: before each 4 KiB push it searches everything pushed so far for the last heading cut
 * candidate, as a cut decision that rescans the open input instead of carrying its scan state would.
 */
function segmentRescanningCuts(body: string): number {
  const seg = new Segmenter(entry(), segmentOptions('trusted'));
  let n = 0;
  let candidates = 0;
  for (let i = 0; i < body.length; i += 4 * 1024) {
    const pushed = body.slice(0, i);
    for (const cut = /\n## /g; cut.exec(pushed);) candidates++;
    n += seg.push(body.slice(i, i + 4 * 1024)).length;
  }
  return n + seg.finish().length + (candidates & 0);
}

describe('the segmenter scales linearly', () => {
  const shapes: Array<[string, (bytes: number) => string, number]> = [
    ['mixed page', prefix, 2 * MB],
    ['short lines', bytes => 'a\n'.repeat(bytes / 2), MB / 2],
    ['one newline-free line', bytes => 'x'.repeat(bytes), 8 * MB],
    ['giant fence', bytes => '```\n' + '## not a heading\n\ncode line\n'.repeat(bytes / 28), 1 * MB],
    ['unterminated protected region', bytes => '<!--- gbrain:takes:begin -->\n' + '## secret\n\nwords here\n'.repeat(bytes / 23), 1 * MB],
    ['key-dense text', bytes => PEM_BLOCK.repeat(bytes / PEM_BLOCK.length), 2 * MB],
  ];
  for (const [name, make, small] of shapes) {
    test(`${name}: twice the input takes under ${BOUND}x the time`, () => {
      const r = ratio(make, small, segmentStreaming);
      console.log(`[segmenter-linear] ${name}: ${r.toFixed(2)}x`);
      expect(r).toBeLessThan(BOUND);
    }, 120_000);
  }

  test('forced probe: a cut search that rescans the pushed input exceeds the bound', () => {
    const giantFence = shapes.find(([name]) => name === 'giant fence')!;
    const r = ratio(giantFence[1], giantFence[2], segmentRescanningCuts);
    console.log(`[segmenter-linear] giant fence, rescanning cut search (quadratic probe): ${r.toFixed(2)}x`);
    expect(r).toBeGreaterThan(BOUND);
  }, 120_000);
});

const STEP = 64 * 1024;

/** Append `body` in STEP-char writes, each resegmenting only the last segment from its stored entry state. */
function appendResuming(body: string): SegmentOut[] {
  const segs: SegmentOut[] = [];
  for (let at = 0; at < body.length; at += STEP) {
    const last = segs.pop();
    const tail = (last ? Buffer.from(last.bytes).toString('utf8') : '') + body.slice(at, at + STEP);
    segs.push(...segmentString(tail, last ? last.entryState : entry(), segmentOptions('trusted', {
      byteStart: last ? last.byteStart : 0, lineStart: last ? last.lineStart : 0,
    })));
  }
  return segs;
}

/** The quadratic variant: every append resegments the whole page. */
function appendResegmenting(body: string): SegmentOut[] {
  let segs: SegmentOut[] = [];
  for (let at = 0; at < body.length; at += STEP) segs = segmentAll(body.slice(0, Math.min(body.length, at + STEP)));
  return segs;
}

describe('appends through a stored entry state', () => {
  const ascii = (bytes: number) => prefix(bytes).replace(/[^\n -~]/g, 'u');

  test('reproduce a full run\'s cuts', () => {
    const body = ascii(1.5 * MB);
    expect(appendResuming(body).map(s => [s.byteStart, s.bytes.length, s.cutKind])).toEqual(segmentAll(body).map(s => [s.byteStart, s.bytes.length, s.cutKind]));
  });

  test(`twice the appended text takes under ${BOUND}x the time`, () => {
    const r = ratio(ascii, 1 * MB, appendResuming);
    console.log(`[segmenter-linear] appends resuming: ${r.toFixed(2)}x`);
    expect(r).toBeLessThan(BOUND);
  }, 120_000);

  test('forced probe: resegmenting the whole page per append exceeds the bound', () => {
    const r = ratio(ascii, 1 * MB, appendResegmenting);
    console.log(`[segmenter-linear] appends resegmenting (quadratic probe): ${r.toFixed(2)}x`);
    expect(r).toBeGreaterThan(BOUND);
  }, 120_000);
});
