import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { downloadPinnedArchive } from '../../scripts/native/setup-toolchain';

const bytes = Buffer.from('verified compiler fixture');
const shasum = createHash('sha256').update(bytes).digest('hex');

async function exercise(mirror: () => Response, options: { rejectOrigin?: boolean; timeout?: number; list?: string } = {}) {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === '/list') return new Response(options.list ?? 'https://mirror.example\n');
      if (path.startsWith('/mirror/')) return mirror();
      return options.rejectOrigin ? new Response('unavailable', { status: 503 }) : new Response(bytes);
    },
  });
  const root = `http://127.0.0.1:${server.port}`;
  try {
    const result = await downloadPinnedArchive({ tarball: `${root}/origin/compiler.tar.xz`, shasum, size: String(bytes.length) }, {
      attemptTimeoutMs: options.timeout ?? 1000,
      fetch(url, init) {
        if (url.endsWith('/community-mirrors.txt')) return fetch(`${root}/list`, init);
        if (url.startsWith('https://mirror.example/')) return fetch(`${root}/mirror/compiler.tar.xz`, init);
        return fetch(url, init);
      },
    });
    return { result, paths };
  } finally {
    server.stop(true);
  }
}

test('a verified mirror supplies the pinned compiler without fetching origin', async () => {
  const { result, paths } = await exercise(() => new Response(bytes), {
    list: 'http://insecure.example\ninvalid\nhttps://user:password@invalid.example\nhttps://mirror.example\n',
  });
  expect(Buffer.from(result)).toEqual(bytes);
  expect(paths).toEqual(['/list', '/mirror/compiler.tar.xz']);
});

for (const [kind, response] of [
  ['HTTP failure', () => new Response('unavailable', { status: 503 })],
  ['wrong hash', () => new Response(Buffer.alloc(bytes.length))],
  ['oversized body', () => new Response(Buffer.alloc(bytes.length + 1))],
  ['truncated body', () => new Response(bytes.subarray(1))],
] as const) {
  test(`${kind} falls through to a verified origin archive`, async () => {
    const { result, paths } = await exercise(response);
    expect(Buffer.from(result)).toEqual(bytes);
    expect(paths).toEqual(['/list', '/mirror/compiler.tar.xz', '/origin/compiler.tar.xz']);
  });
}

test('the deadline covers a stalled response body, not only HTTP headers', async () => {
  const { result, paths } = await exercise(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 1)); },
  })), { timeout: 100 });
  expect(Buffer.from(result)).toEqual(bytes);
  expect(paths).toContain('/origin/compiler.tar.xz');
});

test('exhausted sources fail closed without accepting a corrupt compiler', async () => {
  await expect(exercise(() => new Response(Buffer.alloc(bytes.length)), { rejectOrigin: true })).rejects.toThrow('Unable to download the pinned Zig archive');
});

test('an unusable mirror list still permits the verified origin', async () => {
  const { result, paths } = await exercise(() => new Response(bytes), { list: 'http://insecure.example\ninvalid\n' });
  expect(Buffer.from(result)).toEqual(bytes);
  expect(paths).toEqual(['/list', '/origin/compiler.tar.xz']);
});
