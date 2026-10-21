/**
 * Warm CLI socket: the guards that decide whether a CLI may talk to a serve.
 *
 * 1. Protects: the identity token changes with the database target, config home,
 *    config bytes and version (never with the password); the run directory and
 *    socket checks refuse symlinks, foreign owners and open permissions; the
 *    serve rejects a peer whose kernel-reported uid differs, refuses to start
 *    when peer credentials cannot be read, refuses a mismatched identity, and a
 *    serve that dies mid-request sends the CLI to its cold path.
 * 2. Fails when: a token input is dropped, a check follows a symlink or skips
 *    the uid comparison, or the peer-credential branch is removed.
 * 3. The Postgres E2E (test/e2e/cli-socket-postgres.test.ts) exercises the
 *    happy path and fallbacks end to end; another uid cannot be produced there.
 * 4. Seams: startCliSocketServer's peerCred/identity/execute/home options.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { canonicalDatabaseTarget, cliSocketIdentity } from '../src/core/cli-socket/identity.ts';
import { cliSocketPath, connectProblem, ensurePrivateDir, privateDirProblem, privateSocketProblem, type FsGuardDeps } from '../src/core/cli-socket/fs-guard.ts';
import { peerCredSupport } from '../src/core/cli-socket/peer-cred.ts';
import { startCliSocketServer, type CliSocketBinding } from '../src/core/cli-socket/server.ts';
import { exchangeCliSocket } from '../src/cli/cli-socket-client.ts';
import { reviveOperationError, serializeOperationError, type CliSocketRequest } from '../src/core/cli-socket/protocol.ts';
import { opError, OperationError } from '../src/core/ops/contract.ts';

const uid = process.getuid!();
const engine = { kind: 'postgres' } as BrainEngine;
let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gbrain-cli-sock-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function homeWithConfig(name: string, body = '{"engine":"postgres"}'): { dir: string; file: string } {
  const dir = join(root, name, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), body);
  return { dir, file: join(dir, 'config.json') };
}

describe('identity token', () => {
  const url = 'postgresql://alice-example:secret-one@db.acme-example.test:6543/brain?sslmode=require&application_name=x';
  const token = (overrides: Partial<Parameters<typeof cliSocketIdentity>[0]> = {}) => {
    const dir = join(root, 'a', '.gbrain');
    return cliSocketIdentity({ config: { engine: 'postgres', database_url: url }, configDir: dir, configFile: join(dir, 'config.json'), version: '1.0.0', ...overrides });
  };

  test('ignores the password and query-parameter order, keeps host, port, database and user', () => {
    expect(canonicalDatabaseTarget(url)).toBe(canonicalDatabaseTarget('postgres://alice-example:other@DB.acme-example.test:6543/brain?application_name=x&sslmode=require'));
    expect(canonicalDatabaseTarget(url)).not.toContain('secret-one');
    for (const other of [
      url.replace(':6543', ':5432'), url.replace('/brain', '/brain2'), url.replace('db.acme', 'db2.acme'), url.replace('alice-example', 'bob-example'),
    ]) expect(canonicalDatabaseTarget(other)).not.toBe(canonicalDatabaseTarget(url));
  });

  test('changes with the database, config home, config bytes and version', () => {
    const home = homeWithConfig('a');
    const base = token();
    expect(token()).toBe(base);
    expect(token({ config: { engine: 'postgres', database_url: url.replace('secret-one', 'rotated') } })).toBe(base);
    expect(token({ config: { engine: 'postgres', database_url: url.replace('/brain', '/other') } })).not.toBe(base);
    expect(token({ version: '1.0.1' })).not.toBe(base);
    const other = homeWithConfig('b');
    expect(token({ configDir: other.dir, configFile: other.file })).not.toBe(base);
    writeFileSync(home.file, '{"engine":"postgres","edited":true}');
    expect(token()).not.toBe(base);
  });
});

describe('run directory and socket checks', () => {
  test('ensurePrivateDir creates 0700, tightens an open directory this uid owns, refuses a symlink', () => {
    const dir = join(root, 'home', '.gbrain', 'run');
    ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(dir, 0o755);
    expect(privateDirProblem(dir)).toBe('open_permissions');
    ensurePrivateDir(dir);
    expect(privateDirProblem(dir)).toBeNull();
    const link = join(root, 'link-run');
    symlinkSync(dir, link);
    expect(privateDirProblem(link)).toBe('symlink');
    expect(() => ensurePrivateDir(link)).toThrow(/symlink/);
  });

  test('a directory or socket owned by another uid is refused, never repaired', () => {
    const dir = join(root, 'run');
    ensurePrivateDir(dir);
    const foreign: FsGuardDeps = { lstat: path => lstatSync(path), uid: () => uid + 1 };
    expect(privateDirProblem(dir, foreign)).toBe('foreign_owner');
    expect(() => ensurePrivateDir(dir, foreign)).toThrow(/foreign_owner/);
    expect(privateDirProblem(dir, { ...foreign, uid: () => undefined })).toBe('no_uid');
  });

  test('the CLI refuses a regular file, a symlinked socket and an open socket before connecting', async () => {
    const dir = join(root, 'run');
    ensurePrivateDir(dir);
    const path = join(dir, 'cli.sock');
    expect(connectProblem(path, dir)).toBe('missing');
    writeFileSync(path, 'x');
    expect(privateSocketProblem(path)).toBe('not_socket');
    rmSync(path);
    const real = join(root, 'real.sock');
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(real, resolve));
    try {
      symlinkSync(real, path);
      expect(connectProblem(path, dir)).toBe('symlink');
      rmSync(path);
      chmodSync(real, 0o666);
      expect(privateSocketProblem(real)).toBe('open_permissions');
      chmodSync(real, 0o600);
      expect(privateSocketProblem(real)).toBeNull();
      expect(privateSocketProblem(real, { lstat: p => lstatSync(p), uid: () => uid + 1 })).toBe('foreign_owner');
    } finally {
      server.close();
    }
  });
});

describe('serve listener', () => {
  const bindings: CliSocketBinding[] = [];
  afterEach(() => { for (const b of bindings.splice(0)) b.close(); });

  const request = (identity: string): CliSocketRequest => ({ v: 1, identity, command: 'search', kind: 'op', op: 'search', params: { query: 'q' },
    routing: { cwd: '/', source_env: null }, cli: { quiet: false, timeout_ms: null } });

  async function start(overrides: Partial<Parameters<typeof startCliSocketServer>[0]> = {}) {
    const lines: string[] = [];
    const home = join(root, 'home', '.gbrain');
    const binding = await startCliSocketServer({ engine, log: line => lines.push(line), home, identity: 'token-a',
      execute: async () => ({ v: 1, kind: 'result', result: ['ok'], meta: null, notices: [], output: [], source: null }), ...overrides });
    if (binding) bindings.push(binding);
    return { binding, lines, path: cliSocketPath(home) };
  }

  test('this platform reads peer credentials (otherwise the serve would refuse to start)', () => {
    if (process.platform === 'linux' || process.platform === 'darwin') expect(peerCredSupport().ok).toBe(true);
  });

  test('binds 0600 and answers a matching identity; refuses a mismatched one', async () => {
    const { binding, path } = await start();
    expect(binding).not.toBeNull();
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(await exchangeCliSocket(path, request('token-a'), 5_000)).toEqual({ frame: { v: 1, kind: 'result', result: ['ok'], meta: null, notices: [], output: [], source: null } });
    expect(await exchangeCliSocket(path, request('token-b'), 5_000)).toEqual({ reason: 'refused (identity_mismatch)' });
  });

  test('rejects a peer whose kernel uid differs, and one whose uid cannot be read', async () => {
    let calls = 0;
    // The first read is the start-up self-test on this process's own connection.
    const { binding, path, lines } = await start({ peerCred: { ok: true, read: () => (calls++ === 0 ? uid : uid + 1) } });
    expect(binding).not.toBeNull();
    const outcome = await exchangeCliSocket(path, request('token-a'), 5_000);
    expect('reason' in outcome && outcome.reason).toMatch(/^serve_closed|connect_failed|lost/);
    expect(lines.join('\n')).toContain(`rejected a connection from uid ${uid + 1}`);
    binding!.close();
    bindings.length = 0;
    calls = 0;
    const second = await start({ peerCred: { ok: true, read: () => (calls++ === 0 ? uid : null) } });
    expect(await exchangeCliSocket(second.path, request('token-a'), 5_000)).toHaveProperty('reason');
    expect(second.lines.join('\n')).toContain('rejected a connection from an unverifiable peer');
  });

  test('fails closed when peer credentials are unsupported or the self-test sees another uid', async () => {
    const unsupported = await start({ peerCred: { ok: false, reason: 'no peer-credential call is wired for testos' } });
    expect(unsupported.binding).toBeNull();
    expect(unsupported.lines.join('\n')).toContain('peer credentials cannot be verified on this platform (no peer-credential call is wired for testos)');
    expect(() => lstatSync(unsupported.path)).toThrow();
    const wrong = await start({ peerCred: { ok: true, read: () => uid + 1 } });
    expect(wrong.binding).toBeNull();
    expect(wrong.lines.join('\n')).toContain('self-test');
  });

  test('refuses PGLite brains and a symlinked run directory', async () => {
    expect((await start({ engine: { kind: 'pglite' } as BrainEngine })).binding).toBeNull();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(root, 'home', '.gbrain'), { recursive: true });
    symlinkSync(elsewhere, join(root, 'home', '.gbrain', 'run'));
    const { binding, lines } = await start();
    expect(binding).toBeNull();
    expect(lines.join('\n')).toContain('(symlink)');
  });

  test('a serve that dies after the handshake sends the CLI to its cold path', async () => {
    const dir = join(root, 'run');
    ensurePrivateDir(dir);
    const path = join(dir, 'cli.sock');
    const server = net.createServer(socket => socket.once('data', () => { socket.write('{"v":1,"accepted":true}\n'); setTimeout(() => socket.destroy(), 20); }));
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      expect(await exchangeCliSocket(path, request('token-a'), 5_000)).toEqual({ reason: 'serve_closed_mid_request' });
    } finally {
      server.close();
    }
  });

  test('a wedged serve that never answers the handshake is abandoned within the handshake timeout', async () => {
    const dir = join(root, 'run');
    ensurePrivateDir(dir);
    const path = join(dir, 'cli.sock');
    const server = net.createServer(() => { /* never answers */ });
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      const started = performance.now();
      expect(await exchangeCliSocket(path, request('token-a'), 60_000)).toEqual({ reason: 'handshake_timeout' });
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      server.close();
    }
  });
});

test('an OperationError round-trips with every field the CLI renderer reads', () => {
  const original = opError('page_not_found', 'Page not found: notes/alpha-example', 'Check the slug.', {
    fix: { argv: ['gbrain', 'get', 'notes/alpha-example', '--include-deleted'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows deleted pages too.' },
  });
  const revived = reviveOperationError(JSON.parse(JSON.stringify(serializeOperationError(original))));
  expect(revived).toBeInstanceOf(OperationError);
  expect(revived.toJSON()).toEqual(original.toJSON());
  expect({ ...revived }).toEqual({ ...original });
});
