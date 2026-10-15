/**
 * Wave B (spec 3.1): pass 1 stays linear in the file size.
 *
 * Protects: the streamed body scan does O(bytes) work: CPU time at 2n bytes is
 * under 2.5x the time at n bytes (n = 4 MiB, best of five interleaved runs) on a page dense with every state the scan
 * carries (quoted sentinels inside fences, `---` lines awaiting a Timeline
 * H2, bare-section headings that fail their lookahead, CRLF, astral text).
 * Fails when: a step re-reads buffered input per line or per chunk (a
 * re-decoded prefix, a re-split carry, a per-candidate rescan); the forced
 * probe below runs exactly such a variant and asserts the ratio catches it.
 * Why existing coverage misses it: split-body-linear covers the whole-string
 * splitBody, not the streaming scanner.
 * Seams: none; the quadratic variant wraps the public push API.
 */
import { describe, expect, test } from 'bun:test';
import { BodyScanner } from '../../src/core/page-body/body-scan.ts';
import { cpuScalingRatio } from '../helpers/cpu-time.ts';

const MB = 1024 * 1024;
const RATIO_LIMIT = 2.5;

function page(bytes: number): Uint8Array {
  const unit = [
    '## Message from alice-example', 'Some prose with **bold** and 😀 𝄞', '', '---', '```ts', 'const x = 1; <!-- timeline -->', '```',
    '- 2024-05-01: dated entry', '## History', 'prose disqualifies the bare section', '  indented continuation',
  ].join('\r\n') + '\r\n';
  const head = '---\ntitle: Linear Example\ntags: [a, b]\n---\n';
  return Buffer.from(head + unit.repeat(Math.ceil(bytes / unit.length)) + '<!-- timeline -->\n- 2024: end\n');
}

function scan(bytes: Uint8Array): void {
  const scanner = new BodyScanner('notes/linear-example.md', { validate: true });
  for (let at = 0; at < bytes.length; at += 64 * 1024) scanner.push(bytes.subarray(at, at + 64 * 1024));
  expect(scanner.finish().kind).toBe('ok');
}

/** The deliberately quadratic variant: re-decodes everything buffered so far before each 1 KiB push. */
function quadraticScan(bytes: Uint8Array): void {
  const scanner = new BodyScanner('notes/linear-example.md', { validate: true });
  const decoder = new TextDecoder();
  for (let at = 0; at < bytes.length; at += 1024) {
    decoder.decode(bytes.subarray(0, at));
    scanner.push(bytes.subarray(at, at + 1024));
  }
  expect(scanner.finish().kind).toBe('ok');
}

function ratio(run: (bytes: Uint8Array) => void, n: number, runs: number): number {
  const small = page(n);
  const large = page(2 * n);
  return cpuScalingRatio(() => run(small), () => run(large), runs);
}

describe('body scan cost', () => {
  test(`CPU time at 2n stays under ${RATIO_LIMIT}x the time at n`, () => {
    expect(ratio(scan, 4 * MB, 5)).toBeLessThan(RATIO_LIMIT);
  }, 60_000);

  test('forced probe: the same ratio fails a scan that re-reads its buffered prefix', () => {
    expect(ratio(quadraticScan, MB, 3)).toBeGreaterThan(RATIO_LIMIT);
  }, 120_000);
});
