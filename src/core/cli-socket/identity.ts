/**
 * The brain identity the warm CLI socket is bound to. A serve computes it once
 * when it binds; the CLI computes it per call and sends it in the request. The
 * serve answers only an identical token, so a CLI aimed at another database,
 * another GBRAIN_HOME, an edited config file or another gbrain release always
 * takes its own cold path. The socket path alone never decides.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import type { GBrainConfig } from '../config.ts';

/** Database URL without its password, with the host, port and query parameters in one canonical spelling. */
export function canonicalDatabaseTarget(databaseUrl: string): string {
  let url: URL;
  try { url = new URL(databaseUrl); }
  catch { return `unparsed:${createHash('sha256').update(databaseUrl).digest('hex')}`; }
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !/pass/i.test(key))
    .sort(([a, av], [b, bv]) => a === b ? av.localeCompare(bv) : a.localeCompare(b));
  const protocol = url.protocol === 'postgres:' ? 'postgresql:' : url.protocol;
  const user = decodeURIComponent(url.username);
  return `${protocol}//${user ? `${user}@` : ''}${url.hostname.toLowerCase()}:${url.port || '5432'}`
    + `${decodeURIComponent(url.pathname) || '/'}${params.length ? `?${new URLSearchParams(params).toString()}` : ''}`;
}

function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return `absent:${path}`; }
}

function fileDigest(path: string): string {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return 'absent'; }
}

export interface CliSocketIdentityInput {
  config: Pick<GBrainConfig, 'engine' | 'database_url'>;
  configDir: string;
  configFile: string;
  version: string;
}

/** SHA-256 over the canonical database target, the config home and file (realpath and content) and the gbrain version. */
export function cliSocketIdentity(input: CliSocketIdentityInput): string {
  const fields = {
    v: 1,
    version: input.version,
    brain: 'host',
    engine: input.config.engine,
    database: input.config.database_url ? canonicalDatabaseTarget(input.config.database_url) : null,
    config_dir: realpathOr(input.configDir),
    config_file: realpathOr(input.configFile),
    config_sha256: fileDigest(input.configFile),
  };
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
