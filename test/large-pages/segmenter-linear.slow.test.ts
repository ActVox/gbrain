/**
 * The segmenter is linear in the input, and appending through a stored entry
 * state is linear in the appended text (plus one segment).
 *
 * 1. Protects: ingest of a 256 MB page and repeated appends to a large page
 *    stay O(bytes); a cut decision that rescans the open segment, or an
 *    append that resegments the page, would make both quadratic.
 * 2. Fails when: the growth exponent k in CPU time ~ bytes^k, measured at 4x
 *    the input, reaches 1.3 (linear 1, quadratic 2), for prose, short lines,
 *    one newline-free line, a giant fence, an unterminated protected region
 *    and key-dense text, or for the resuming append.
 * 3. Forced probes: the same exponent check run on a cut search that rescans
 *    everything pushed so far, and on an append path that resegments the whole
 *    prefix on each append (the quadratic variants), exceeds the bound, so the
 *    check can tell the two apart.
 * 4. After one warm-up run of each size, the ratio is the median of three
 *    rounds, each the best of three samples per size in thread CPU time; a
 *    sample repeats the call until it holds 200 ms (cpuScalingRatio).
 * 5. Why 4x and an exponent: at 2x with a 2.5x bound, linear shapes read up to
 *    2.54x and the rescanning probe as low as 2.66x on a loaded 4-core machine,
 *    and CI's stress gate failed 2 of 10 runs (newline-free line, whose 28 ms
 *    small call sits on the 4 ms thread-CPU step, and the unterminated region).
 *    Measuring at 4x halves the exponent error of the same noise.
 * 6. Measured (16 runs, 4 and 8 in parallel on a 4-core machine): every shape
 *    and the resuming append 0.95-1.06; the probes, the rescanning cut search
 *    1.59-1.68 and whole-page resegmenting per append 1.69-1.77.
 */
import { describe, expect, test } from 'bun:test';
import { initialEntryState } from '../../src/core/page-body/entry-state.ts';
import { Segmenter, segmentString, type SegmentOut } from '../../src/core/page-body/segmenter.ts';
import { cpuScalingRatio } from '../helpers/cpu-time.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { bigPage, PEM_BLOCK, segmentOptions } from '../helpers/segment-bodies.ts';

const MB = 1024 * 1024;
const SCALE = 4;
const MAX_EXPONENT = 1.3;
const entry = () => initialEntryState({ region: 'truth' });

/** The growth exponent k in time ~ bytes^k, from the CPU-time ratio at SCALE times the input (linear 1, quadratic 2). */
function exponent(make: (bytes: number) => string, small: number, run: (body: string) => unknown): number {
  const a = make(small);
  const b = make(SCALE * small);
  return Math.log(cpuScalingRatio(() => run(a), () => run(b))) / Math.log(SCALE);
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
    ['mixed page', prefix, 1 * MB],
    ['short lines', bytes => 'a\n'.repeat(bytes / 2), MB / 2],
    ['one newline-free line', bytes => 'x'.repeat(bytes), 4 * MB],
    ['giant fence', bytes => '```\n' + '## not a heading\n\ncode line\n'.repeat(bytes / 28), 1 * MB],
    ['unterminated protected region', bytes => '<!--- gbrain:takes:begin -->\n' + '## secret\n\nwords here\n'.repeat(bytes / 23), 1 * MB],
    ['key-dense text', bytes => PEM_BLOCK.repeat(bytes / PEM_BLOCK.length), 2 * MB],
  ];
  for (const [name, make, small] of shapes) {
    test(`${name}: growth exponent under ${MAX_EXPONENT}`, () => {
      const k = exponent(make, small, segmentStreaming);
      console.log(`[segmenter-linear] ${name}: exponent ${k.toFixed(2)}`);
      expect(k).toBeLessThan(MAX_EXPONENT);
    }, 120_000);
  }

  test('forced probe: a cut search that rescans the pushed input exceeds the bound', () => {
    const giantFence = shapes.find(([name]) => name === 'giant fence')!;
    const k = exponent(giantFence[1], giantFence[2], segmentRescanningCuts);
    console.log(`[segmenter-linear] giant fence, rescanning cut search (quadratic probe): exponent ${k.toFixed(2)}`);
    expect(k).toBeGreaterThan(MAX_EXPONENT);
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

  test(`appended text: growth exponent under ${MAX_EXPONENT}`, () => {
    const k = exponent(ascii, 1 * MB, appendResuming);
    console.log(`[segmenter-linear] appends resuming: exponent ${k.toFixed(2)}`);
    expect(k).toBeLessThan(MAX_EXPONENT);
  }, 120_000);

  test('forced probe: resegmenting the whole page per append exceeds the bound', () => {
    const k = exponent(ascii, MB / 4, appendResegmenting);
    console.log(`[segmenter-linear] appends resegmenting (quadratic probe): exponent ${k.toFixed(2)}`);
    expect(k).toBeGreaterThan(MAX_EXPONENT);
  }, 120_000);
});
