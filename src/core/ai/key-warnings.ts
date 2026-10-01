/**
 * #5137: the two key-source messages, each printed at most once per process
 * through one replaceable sink. Env keeps winning over config keys
 * (mergedProviderEnv); these only say which key is in effect and how to
 * change that. Neither prints a key or any part of one.
 *
 * - warnShadowedProviderKeys: the CLI startup seam (src/cli.ts, which also
 *   starts `gbrain serve`) calls it for every command except `gbrain hook`.
 * - reportEmbeddingAuthFailure: the gateway calls it on the first embedding
 *   401/403, so a revoked key no longer fails silently.
 */
import { configPath, loadConfigFileOnly, type GBrainConfig } from '../config.ts';
import { catalogueError } from '../error-catalogue.ts';
import type { OperationError } from '../ops/contract.ts';
import { providerKeyShadows, providerKeySource, type ProviderKeyShadow } from './provider-env.ts';

type Env = Record<string, string | undefined>;
const stderrSink = (line: string) => { process.stderr.write(`${line}\n`); };
let sink: (line: string) => void = stderrSink;
let shadowsWarned = false;
let authFailureReported = false;

/** Test seam: capture lines and reset both once-per-process latches. */
export function _setKeyWarningSinkForTests(next?: (line: string) => void): void {
  sink = next ?? stderrSink;
  shadowsWarned = false;
  authFailureReported = false;
}

const removeVariable = (variable: string) =>
  `To use the config key, remove ${variable} from the environment of the process that reported this (shell profile, ~/.gbrain/.env, or for a daemon its service definition) and restart that process.`;

export function keyShadowWarning(shadow: ProviderKeyShadow, file = configPath()): string {
  return `[gbrain] warning: ${shadow.variable} in this process's environment differs from ${shadow.config_key} in ${file}; the environment value is in effect. `
    + `${removeVariable(shadow.variable)} If the environment key is intended, run \`gbrain config unset ${shadow.config_key}\`, which also stops this warning.`;
}

export function warnShadowedProviderKeys(fileCfg: GBrainConfig | null = loadConfigFileOnly(), env: Env = process.env): void {
  if (shadowsWarned) return;
  shadowsWarned = true;
  try {
    for (const shadow of providerKeyShadows(fileCfg, env)) sink(keyShadowWarning(shadow));
  } catch { /* an invalid GBRAIN_HOME is reported by the command itself */ }
}

export interface AuthFailedProvider { id: string; name: string; auth_env?: { required: readonly string[] } }

/** DX-O8: names the key source in effect and the fixes for it. */
export function embeddingAuthFailedError(provider: AuthFailedProvider, status: number,
  fileCfg: GBrainConfig | null = loadConfigFileOnly(), env: Env = process.env, file = configPath()): OperationError {
  const name = provider.auth_env?.required[0];
  const rejected = `The ${provider.name} embedding provider rejected its key (HTTP ${status})`;
  const backfill = 'Then run `gbrain embed --stale` to embed what was saved while the key was rejected.';
  if (!name) return catalogueError('embedding_auth_failed', `${rejected}.`, `Check the ${provider.name} credentials, restart the process that reported this, then run \`gbrain embed --stale\`.`);
  const source = providerKeySource(fileCfg, env, name);
  if (source.kind === 'config') {
    return catalogueError('embedding_auth_failed',
      `${rejected}; the key in effect is ${source.config_key} in ${file} (${source.variable} is not set).`,
      `Run \`gbrain config set ${source.config_key} <valid key>\` and restart any daemon that uses it. ${backfill}`);
  }
  if (source.kind === 'missing') {
    return catalogueError('embedding_auth_failed', `${rejected}; ${source.variable} is not set in this process, so the key came from the caller's gateway configuration.`,
      `${source.config_key ? `Run \`gbrain config set ${source.config_key} <valid key>\`` : `Set ${source.variable} to a valid key in the environment of the process that reported this`}, restart that process, then run \`gbrain embed --stale\`.`);
  }
  const differs = source.shadows_config && source.config_key ? `, which differs from ${source.config_key} in ${file}` : '';
  const intended = source.config_key
    ? `If the environment key is intended, replace it with a valid key, restart, and run \`gbrain config unset ${source.config_key}\`.`
    : 'Replace it with a valid key and restart that process.';
  return catalogueError('embedding_auth_failed',
    `${rejected}; the key in effect is ${source.variable} from this process's environment${differs}.`,
    `${source.shadows_config ? `${removeVariable(source.variable)} ` : ''}${intended} ${backfill}`);
}

/** The HTTP status of a provider 401/403, from a fetch status or an SDK error (`statusCode`). */
function authFailureStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; apiErrorStatus?: unknown } | null;
  const status = [e?.status, e?.statusCode, e?.apiErrorStatus].find(value => typeof value === 'number');
  return status === 401 || status === 403 ? status : undefined;
}

/** Prints embedding_auth_failed for the first embedding 401/403 in this process; anything else is ignored. */
export function reportEmbeddingAuthFailure(provider: AuthFailedProvider, failure: unknown,
  fileCfg?: GBrainConfig | null, env?: Env): void {
  const status = authFailureStatus(failure);
  if (status === undefined || authFailureReported) return;
  authFailureReported = true;
  try {
    const error = embeddingAuthFailedError(provider, status, fileCfg === undefined ? loadConfigFileOnly() : fileCfg, env ?? process.env);
    sink(`[gbrain] Error [${error.code}]: ${error.message}\nFix: ${error.suggestion}\nDocs: ${error.docs}`);
  } catch { /* a diagnostic must never replace the provider error */ }
}
