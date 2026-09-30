#!/usr/bin/env bun
/** Download the exact compiler archive pinned in the checked-in manifest. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import toolchain from './toolchain.json';

type Archive = { tarball: string; shasum: string; size: string };
type DownloaderOptions = {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  attemptTimeoutMs?: number;
};

/** Mirrors supply bytes only; the checked-in size and SHA-256 remain authoritative. */
export async function downloadPinnedArchive(info: Archive, options: DownloaderOptions = {}): Promise<Uint8Array> {
  const request = options.fetch ?? ((url, init) => fetch(url, init));
  const timeout = options.attemptTimeoutMs ?? 60_000;
  const basename = new URL(info.tarball).pathname.split('/').at(-1)!;
  const mirrors: string[] = [];
  try {
    const response = await request('https://ziglang.org/download/community-mirrors.txt', { signal: AbortSignal.timeout(Math.min(timeout, 5_000)) });
    if (!response.ok) throw new Error(`Mirror list HTTP ${response.status}`);
    const list = await response.text();
    for (const line of list.split('\n')) {
      try {
        const url = new URL(line.trim());
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) mirrors.push(url.href.replace(/\/$/, ''));
      } catch { /* Ignore malformed mirror entries. */ }
    }
  } catch (error) {
    console.warn(`Zig mirror list unavailable: ${String(error)}`);
  }
  // Follow Zig's randomized mirror guidance without unbounded retries.
  const shuffled = [...new Set(mirrors)];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const urls = shuffled.slice(0, 4).map(base => `${base}/${basename}?source=actvox-gbrain`);
  urls.push(info.tarball);
  for (const url of urls) {
    try {
      console.error(`Downloading pinned Zig from ${new URL(url).host}`);
      const response = await request(url, { signal: AbortSignal.timeout(timeout) });
      if (!response.ok || !response.body) throw new Error(`Compiler download HTTP ${response.status}`);
      const expectedSize = Number(info.size);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > expectedSize) throw new Error('Pinned compiler size mismatch');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (size !== expectedSize) throw new Error('Pinned compiler size mismatch');
      const bytes = Buffer.concat(chunks, size);
      if (createHash('sha256').update(bytes).digest('hex') !== info.shasum) throw new Error('Pinned compiler checksum mismatch');
      return bytes;
    } catch (error) {
      console.warn(`Zig download rejected from ${new URL(url).host}: ${String(error)}`);
    }
  }
  throw new Error('Unable to download the pinned Zig archive from any bounded source');
}

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--dir');
  const directory = resolve(index < 0 ? '.context/native-toolchain' : args[index + 1]);
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
  const key = `${arch}-${platform}` as keyof typeof toolchain.archives;
  const archiveInfo = toolchain.archives[key];
  if (!archiveInfo) throw new Error(`No pinned Zig archive for ${key}`);
  mkdirSync(directory, { recursive: true });
  const archive = join(directory, archiveInfo.tarball.split('/').at(-1)!);
  if (!existsSync(archive)) {
    writeFileSync(archive, await downloadPinnedArchive(archiveInfo));
  }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== archiveInfo.shasum) throw new Error('Pinned compiler checksum mismatch');
  execFileSync('tar', ['-xf', archive, '-C', directory], { stdio: 'inherit' });
  const extracted = readdirSync(directory, { withFileTypes: true }).find(entry => entry.isDirectory() && entry.name.startsWith('zig-'));
  if (!extracted) throw new Error('Compiler archive did not contain Zig');
  const binary = join(directory, extracted.name, process.platform === 'win32' ? 'zig.exe' : 'zig');
  if (execFileSync(binary, ['version'], { encoding: 'utf8' }).trim() !== toolchain.version) throw new Error('Extracted compiler version mismatch');
  if (args.includes('--github-path')) {
    if (!process.env.GITHUB_PATH || !process.env.GITHUB_ENV) throw new Error('GitHub environment files are missing');
    appendFileSync(process.env.GITHUB_PATH, dirname(binary) + '\n');
    appendFileSync(process.env.GITHUB_ENV, `ZIG=${binary}\n`);
  }
  console.log(binary);
}

if (import.meta.main) await main();
