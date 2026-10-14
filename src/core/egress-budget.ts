/**
 * Large pages (Wave A): the per-connection egress budget. Every MCP tool
 * result is measured as the complete JSON-RPC response frame it becomes
 * (content blocks, notices and `_meta` included, every string escaped), not as
 * the body's character count, and a result over the connection's cap is
 * replaced by a structured `result_too_large` error instead of a frame the
 * client cannot read (the TypeScript SDK's stdio reader refuses messages over
 * 10 MiB; Claude Code cuts tool results at about 25k tokens).
 *
 * Defaults: 4 MiB on stdio (under the SDK's 10 MiB stdio buffer with margin),
 * 1 MiB on HTTP. `mcp.max_result_bytes_stdio` / `mcp.max_result_bytes_http`
 * (DB plane, then the config file's `mcp` block) move a cap within
 * [EGRESS_CAP_MIN, EGRESS_CAP_MAX]. Trusted local CLI calls have no cap: they
 * never cross a transport.
 */
import type { BrainEngine } from './engine.ts';
import type { GBrainConfig } from './config.ts';

export type EgressTransport = 'stdio' | 'http';

export const EGRESS_CAP_DEFAULTS: Readonly<Record<EgressTransport, number>> = { stdio: 4 * 1024 * 1024, http: 1024 * 1024 };
export const EGRESS_CAP_CONFIG_KEYS: Readonly<Record<EgressTransport, string>> = {
  stdio: 'mcp.max_result_bytes_stdio',
  http: 'mcp.max_result_bytes_http',
};
/** A configured cap is clamped to this range: big enough for any windowed read, small enough for the SDK's 10 MiB stdio reader. */
export const EGRESS_CAP_MIN = 256 * 1024;
export const EGRESS_CAP_MAX = 9 * 1024 * 1024;
/** Bytes a frame spends outside the measured result: the request id and the transport's own framing (SSE `data:` lines). */
export const FRAME_RESERVE_BYTES = 1024;

export interface EgressCaller {
  remote: boolean;
  transport?: EgressTransport;
  engine?: Pick<BrainEngine, 'getConfig'>;
  config?: GBrainConfig | null;
}

/** The transport a caller's results travel over; null for the trusted local CLI. */
export function egressTransport(caller: Pick<EgressCaller, 'remote' | 'transport'>): EgressTransport | null {
  if (caller.remote === false) return null;
  return caller.transport === 'stdio' ? 'stdio' : 'http';
}

function parseCap(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(EGRESS_CAP_MAX, Math.max(EGRESS_CAP_MIN, Math.floor(n)));
}

/**
 * The connection's result cap in bytes of the final encoded frame: Infinity
 * for the trusted local CLI, else the DB plane, the file plane, the default.
 * A config read that fails falls through; resolving a cap never fails a call.
 */
export async function resultByteCap(caller: EgressCaller): Promise<number> {
  const transport = egressTransport(caller);
  if (transport === null) return Number.POSITIVE_INFINITY;
  const key = EGRESS_CAP_CONFIG_KEYS[transport];
  try {
    const db = parseCap(await caller.engine?.getConfig(key));
    if (db !== null) return db;
  } catch {
    // Engine without a config table / transient error: the file plane decides.
  }
  const mcp = caller.config?.mcp as Record<string, unknown> | undefined;
  return parseCap(mcp?.[`max_result_bytes_${transport}`]) ?? EGRESS_CAP_DEFAULTS[transport];
}

/** Bytes of the complete JSON-RPC response frame carrying `result`, plus the framing reserve. */
export function encodedFrameBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 0, result }), 'utf8') + FRAME_RESERVE_BYTES;
}
