/**
 * Where the warm CLI socket lives and the filesystem checks around it. The
 * socket is `$GBRAIN_HOME/.gbrain/run/cli.sock`: a Unix domain socket (never
 * TCP) in a directory that is 0700 and owned by the current user, the socket
 * itself 0600. Both the serve (before bind) and the CLI (before connect)
 * lstat the directory and the socket path, so a symlink, a foreign owner or
 * open permissions refuse instead of being followed or repaired.
 */
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config.ts';
import { UNIX_SOCKET_PATH_MAX_BYTES } from '../context/ipc-path.ts';

export interface FsGuardDeps {
  lstat: (path: string) => Stats;
  uid: () => number | undefined;
}

const realDeps: FsGuardDeps = { lstat: path => lstatSync(path), uid: () => process.getuid?.() };

export type UnsafeReason = 'missing' | 'symlink' | 'not_directory' | 'not_socket' | 'foreign_owner' | 'open_permissions' | 'no_uid';

export function cliSocketDir(home: string = configDir()): string {
  return join(home, 'run');
}

export function cliSocketPath(home: string = configDir()): string {
  return join(cliSocketDir(home), 'cli.sock');
}

/** AF_UNIX addresses are capped (104 bytes on darwin, the stricter of the two); a longer GBRAIN_HOME cannot host the socket. */
export function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path) <= UNIX_SOCKET_PATH_MAX_BYTES;
}

function lstatOrNull(path: string, deps: FsGuardDeps): Stats | null {
  try { return deps.lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** null when `dir` is a real directory owned by this uid with no group or other access. */
export function privateDirProblem(dir: string, deps: FsGuardDeps = realDeps): UnsafeReason | null {
  const uid = deps.uid();
  if (uid === undefined) return 'no_uid';
  const st = lstatOrNull(dir, deps);
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return 'symlink';
  if (!st.isDirectory()) return 'not_directory';
  if (st.uid !== uid) return 'foreign_owner';
  if ((st.mode & 0o077) !== 0) return 'open_permissions';
  return null;
}

/** null when `path` is a socket (not a symlink) owned by this uid with no group or other access. */
export function privateSocketProblem(path: string, deps: FsGuardDeps = realDeps): UnsafeReason | null {
  const uid = deps.uid();
  if (uid === undefined) return 'no_uid';
  const st = lstatOrNull(path, deps);
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return 'symlink';
  if (!st.isSocket()) return 'not_socket';
  if (st.uid !== uid) return 'foreign_owner';
  if ((st.mode & 0o077) !== 0) return 'open_permissions';
  return null;
}

/** The CLI's pre-connect check: both the directory and the socket must pass, or the CLI never connects. */
export function connectProblem(path: string, dir: string, deps: FsGuardDeps = realDeps): UnsafeReason | null {
  return privateDirProblem(dir, deps) ?? privateSocketProblem(path, deps);
}

export class CliSocketUnsafeError extends Error {
  constructor(public readonly reason: UnsafeReason, public readonly path: string) {
    super(`refusing the CLI socket: ${path} is unsafe (${reason})`);
    this.name = 'CliSocketUnsafeError';
  }
}

/**
 * The serve's pre-bind step: create the run directory 0700 when it is missing,
 * tighten one this uid already owns, and refuse a symlink, a non-directory or
 * a directory another uid owns.
 */
export function ensurePrivateDir(dir: string, deps: FsGuardDeps = realDeps, fs: { mkdir: (path: string) => void; chmod: (path: string) => void } = {
  mkdir: path => mkdirSync(path, { recursive: true, mode: 0o700 }),
  chmod: path => chmodSync(path, 0o700),
}): void {
  let problem = privateDirProblem(dir, deps);
  if (problem === 'missing') { fs.mkdir(dir); problem = privateDirProblem(dir, deps); }
  if (problem === 'open_permissions') { fs.chmod(dir); problem = privateDirProblem(dir, deps); }
  if (problem) throw new CliSocketUnsafeError(problem, dir);
}
