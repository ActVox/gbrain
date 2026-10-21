/**
 * CLI half of the warm CLI socket. Before a read (search, query, get, recall)
 * opens its own database connection, the CLI looks for a serve's socket in
 * `$GBRAIN_HOME/.gbrain/run/`; when a serve bound to the same brain identity
 * answers, the CLI prints that answer with the cold path's own renderer and
 * exit codes. A missing, unsafe, stale, busy, refusing or dying socket returns
 * false and the cold path runs as if the socket did not exist (a note goes to
 * stderr only with GBRAIN_DEBUG=1). GBRAIN_CLI_SOCKET=0 skips the socket.
 */
import net from 'node:net';
import { loadConfig, configDir, configPath, isThinClient } from '../core/config.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { VERSION } from '../version.ts';
import { cliSocketDir, cliSocketPath, connectProblem } from '../core/cli-socket/fs-guard.ts';
import { cliSocketIdentity } from '../core/cli-socket/identity.ts';
import { peerCredSupport, peerUid } from '../core/cli-socket/peer-cred.ts';
import {
  CONNECT_TIMEOUT_MS, DEFAULT_READ_WALLCLOCK_MS, FrameReader, HANDSHAKE_TIMEOUT_MS, MAX_RESPONSE_BYTES, reviveOperationError,
  type CliSocketOp, type CliSocketRequest, type HandshakeFrame, type OutputChunk, type ResultFrame,
} from '../core/cli-socket/protocol.ts';

export const CLI_SOCKET_COMMANDS: readonly string[] = ['search', 'query', 'get', 'recall'];
const SOCKET_OPS: Record<string, CliSocketOp> = { search: 'search', query: 'query', get_page: 'get_page' };
/** How long past the read wallclock the CLI waits before treating the serve as wedged. */
const RESULT_GRACE_MS = 10_000;

function debug(reason: string): void {
  if (process.env.GBRAIN_DEBUG === '1') process.stderr.write(`[cli-socket] cold path: ${reason}\n`);
}

type Exchange = { frame: ResultFrame } | { reason: string };

/** One request on one connection: connect, verify the serve's uid, send, read the handshake, then the result. */
export function exchangeCliSocket(path: string, request: CliSocketRequest, resultTimeoutMs: number): Promise<Exchange> {
  return new Promise(resolve => {
    const socket = net.createConnection(path);
    const reader = new FrameReader(MAX_RESPONSE_BYTES);
    let accepted = false;
    let settled = false;
    let timer = setTimeout(() => finish({ reason: 'connect_timeout' }), CONNECT_TIMEOUT_MS);
    const finish = (outcome: Exchange) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const arm = (ms: number, reason: string) => { clearTimeout(timer); timer = setTimeout(() => finish({ reason }), ms); };
    socket.once('error', error => finish({ reason: `${accepted ? 'lost' : 'connect_failed'} (${(error as NodeJS.ErrnoException).code ?? error.message})` }));
    socket.once('close', () => finish({ reason: accepted ? 'serve_closed_mid_request' : 'serve_closed' }));
    socket.once('connect', () => {
      const support = peerCredSupport();
      if (support.ok && peerUid(socket, support.read) !== process.getuid?.()) { finish({ reason: 'serve_uid_mismatch' }); return; }
      arm(HANDSHAKE_TIMEOUT_MS, 'handshake_timeout');
      socket.write(JSON.stringify(request) + '\n');
    });
    socket.on('data', data => {
      const frames = reader.push(typeof data === 'string' ? Buffer.from(data) : data);
      if (frames === 'overflow') { finish({ reason: 'response_too_large' }); return; }
      for (const text of frames) {
        let value: unknown;
        try { value = JSON.parse(text); } catch { finish({ reason: 'malformed_response' }); return; }
        if (!accepted) {
          const handshake = value as HandshakeFrame;
          if (handshake?.v !== 1 || handshake.accepted !== true) { finish({ reason: `refused (${(handshake as { reason?: string })?.reason ?? 'unknown'})` }); return; }
          accepted = true;
          arm(resultTimeoutMs, 'result_timeout');
          continue;
        }
        const result = value as ResultFrame;
        finish(result?.v === 1 && typeof result.kind === 'string' ? { frame: result } : { reason: 'malformed_response' });
        return;
      }
    });
  });
}

/** Restores what the cold process would have by now: the pinned fix source and the operation's own output. */
async function replay(frame: { output: OutputChunk[]; source?: string | null }): Promise<void> {
  if (frame.source) (await import('../core/fix-routing.ts')).noteResolvedSource(frame.source);
  for (const [stream, text] of frame.output) {
    if (stream === 'stdout') process.stdout.write(text);
    else process.stderr.write(text);
  }
}

async function opRequest(command: string, args: string[]): Promise<{ op: import('../core/operations.ts').Operation; params: Record<string, unknown> } | string> {
  const { cliOps } = await import('./op-manifest.ts');
  const { cliAliases, parseOpArgs } = await import('./main.ts');
  const meta = cliOps.get(command) ?? cliAliases.get(command);
  if (!meta || !SOCKET_OPS[meta.name]) return 'not_a_socket_op';
  const { loadOperation } = await import('../core/operation-load.ts');
  const op = (await loadOperation(meta.name))!;
  const params = parseOpArgs(op, args);
  if (op.cliHints?.stdin && !params[op.cliHints.stdin]) return 'stdin_input';
  if (typeof params.image === 'string' && params.image.length > 0) return 'image_query';
  if (Object.entries(op.params).some(([key, def]) => def.required && params[key] === undefined)) return 'missing_param';
  if (typeof params.source === 'string' && params.source.length > 0 && (params.source_id !== undefined || params.all_sources === true)) return 'conflicting_scope';
  return { op, params };
}

async function renderOp(command: string, op: import('../core/operations.ts').Operation, params: Record<string, unknown>, frame: Exclude<ResultFrame, { kind: 'fallback' }>): Promise<void> {
  const { formatResult, captureRetrievalMeta, maybePrintConceptNudge } = await import('./main.ts');
  const { applyCliOpNotices, captureOpNotice } = await import('./op-notices.ts');
  const { setCliExitVerdict, writeStdoutFinal } = await import('../core/cli-force-exit.ts');
  await replay(frame);
  if (frame.kind === 'timeout') {
    const hint = getCliOptions().timeoutMs ? '' : ` (default ${frame.ms}ms; pass --timeout=Ns to override)`;
    console.error(`${frame.label} timed out${hint}.`);
    setCliExitVerdict(124);
    return;
  }
  if (frame.kind === 'error') {
    const { writeCliError } = await import('./cli-error.ts');
    const { reportPersistenceCliError } = await import('../commands/persistence-delegate.ts');
    const e = reviveOperationError(frame.error);
    if (!e.writeRequest || !await reportPersistenceCliError(e, params.json === true || !!e.writeRequest)) setCliExitVerdict(writeCliError(e, command));
    return;
  }
  if (frame.meta) captureRetrievalMeta('retrieval', frame.meta);
  for (const notice of frame.notices) captureOpNotice(notice);
  const { result, stderr: noticeText } = applyCliOpNotices(frame.result, params.json === true);
  const output = formatResult(op.name, result, params);
  if (output) await writeStdoutFinal(output);
  if (noticeText) process.stderr.write(noticeText);
  if (typeof result === 'object' && result !== null && !Array.isArray(result) && (result as { status?: unknown }).status === 'error') {
    const detail = (result as { error?: unknown }).error;
    console.error(`gbrain ${command}: operation reported status 'error'` + (typeof detail === 'string' && detail ? ` — ${detail}` : '') + '.');
    setCliExitVerdict(1);
  }
  maybePrintConceptNudge(op.name, params);
}

/**
 * Serves `command` from a warm serve when one is bound to this CLI's brain.
 * True means the output was printed and the exit verdict set; false means the
 * caller runs the normal cold path.
 */
export async function maybeServeFromCliSocket(command: string, args: string[]): Promise<boolean> {
  if (!CLI_SOCKET_COMMANDS.includes(command) || process.env.GBRAIN_CLI_SOCKET === '0') return false;
  const config = loadConfig();
  if (!config || config.engine !== 'postgres' || !config.database_url || isThinClient(config)) return false;
  const cliOpts = getCliOptions();
  if (cliOpts.explain) return false;
  const home = configDir();
  const path = cliSocketPath(home);
  const problem = connectProblem(path, cliSocketDir(home));
  if (problem) { if (problem !== 'missing') debug(`socket refused before connect (${problem})`); return false; }
  try { if (resolveBrainId(cliOpts.brain) !== 'host') return false; } catch { return false; }

  const base = {
    v: 1 as const,
    identity: cliSocketIdentity({ config, configDir: home, configFile: configPath(), version: VERSION }),
    command,
    routing: { cwd: process.cwd(), source_env: process.env.GBRAIN_SOURCE ?? null },
    cli: { quiet: cliOpts.quiet, timeout_ms: cliOpts.timeoutMs },
  };
  const resultTimeoutMs = (cliOpts.timeoutMs ?? DEFAULT_READ_WALLCLOCK_MS) + RESULT_GRACE_MS;

  if (command === 'recall') {
    const recall = await import('../commands/recall.ts');
    if (args.includes('--help') || args.includes('-h')) return false;
    let flags: ReturnType<typeof recall.parseFlags>;
    try { flags = recall.parseFlags(args); } catch { return false; }
    if (!recall.isRecallVerbForm(flags)) return false;
    if (!recall.isOneShotRecall(flags)) recall.validateAndNormalizeFlags(flags);
    const outcome = await exchangeCliSocket(path, { ...base, kind: 'recall', args }, resultTimeoutMs);
    if ('reason' in outcome) { debug(outcome.reason); return false; }
    if (outcome.frame.kind === 'fallback' || outcome.frame.kind === 'timeout') { debug(outcome.frame.kind === 'fallback' ? outcome.frame.reason : 'timeout'); return false; }
    await replay(outcome.frame);
    if (outcome.frame.kind === 'result') { recall.renderRecallVerbResult(flags, outcome.frame.result as Parameters<typeof recall.renderRecallVerbResult>[1]); return true; }
    const error = reviveOperationError(outcome.frame.error);
    if (recall.isOneShotRecall(flags)) await recall.reportOneShotRecallError(error, flags);
    else throw error;
    return true;
  }

  const prepared = await opRequest(command, args);
  if (typeof prepared === 'string') { debug(prepared); return false; }
  const outcome = await exchangeCliSocket(path, { ...base, kind: 'op', op: SOCKET_OPS[prepared.op.name]!, params: prepared.params }, resultTimeoutMs);
  if ('reason' in outcome) { debug(outcome.reason); return false; }
  if (outcome.frame.kind === 'fallback') { debug(outcome.frame.reason); return false; }
  await renderOp(command, prepared.op, prepared.params, outcome.frame);
  return true;
}
