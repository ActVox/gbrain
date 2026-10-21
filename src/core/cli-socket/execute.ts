/**
 * Serve-side execution of one warm CLI request. Shared ops run through the
 * operation's own handler with the trusted local CLI context (remote: false),
 * built the way src/cli/main.ts makeContext builds it but with the CLI's cwd
 * and GBRAIN_SOURCE instead of the serve's. The result goes back as data and
 * the CLI renders it with the cold path's renderer, so the printed bytes come
 * from the same code. `recall` runs its op-backed forms the same way.
 */
import type { Notice } from '../agent-output.ts';
import { takeChatFallbackHopNotices } from '../ai/fallback-hop-queue.ts';
import { DEFAULT_CLI_OPTIONS } from '../cli-options.ts';
import { loadConfig, loadConfigWithEngine, type GBrainConfig } from '../config.ts';
import { withRequestConfigSnapshot } from '../config-snapshot.ts';
import type { BrainEngine } from '../engine.ts';
import { operationsByName } from '../operations.ts';
import { OperationError, opOwnsSource, type Operation, type OperationContext } from '../ops/contract.ts';
import { currentCliWriteWait } from '../persistence/write-wait.ts';
import { localFederatedSourceIds, resolveSourceWithTier, SourceTargetError } from '../source-resolver.ts';
import { OperationTimeoutError, withTimeout } from '../timeout.ts';
import { bigintToStringReplacer } from '../utils.ts';
import { OutputCapture, withOutputCapture } from './output-capture.ts';
import { DEFAULT_READ_WALLCLOCK_MS, serializeOperationError, type CliSocketRequest, type ResultFrame } from './protocol.ts';

/** File config merged with the DB plane, read fresh for every request (inside its config snapshot), as a cold CLI reads it at connect. */
export async function mergedRequestConfig(engine: BrainEngine): Promise<GBrainConfig> {
  const fileConfig = loadConfig() || { engine: 'postgres' as const };
  try {
    return (await loadConfigWithEngine(engine, fileConfig)) ?? fileConfig;
  } catch (err) {
    console.warn(
      `[config] DB-plane merge failed; using file/env config only. ` +
      `Values set via \`gbrain config set\` will not apply to this command: ` +
      `${(err as Error).message}`,
    );
    return fileConfig;
  }
}

/** The CLI's OperationContext for one request: makeContext's fields, with the caller's routing. */
export async function cliRequestContext(engine: BrainEngine, params: Record<string, unknown>, op: Pick<Operation, 'params'>,
  request: Pick<CliSocketRequest, 'routing' | 'cli'>, config: GBrainConfig,
  sinks: { emitResponseMeta: (key: string, value: unknown) => void; emitNotice: (notice: Notice) => void }): Promise<OperationContext> {
  let sourceId: string | undefined;
  let localFederated: string[] | undefined;
  let sourceImplicit = true;
  const explicit = opOwnsSource(op) ? null : (params.source as string | undefined) ?? null;
  const env = request.routing.source_env ?? undefined;
  try {
    const resolved = await resolveSourceWithTier(engine, explicit, request.routing.cwd, { env });
    sourceId = resolved.source_id;
    sourceImplicit = resolved.tier !== 'flag' && resolved.tier !== 'env' && resolved.tier !== 'dotfile';
    localFederated = await localFederatedSourceIds(engine, resolved.source_id, resolved.tier);
  } catch (err) {
    if (explicit || err instanceof SourceTargetError) throw err;
    sourceId = undefined;
  }
  return {
    engine,
    config,
    logger: { info: (...args: unknown[]) => console.log(...args), warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) },
    dryRun: (params.dry_run as boolean) || false,
    remote: false, admissionOrigin: 'interactive',
    cliOpts: { ...DEFAULT_CLI_OPTIONS, quiet: request.cli.quiet, timeoutMs: request.cli.timeout_ms },
    writeWaitMs: currentCliWriteWait().waitMs,
    sourceId: sourceId ?? 'default',
    brainId: 'host',
    ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
    ...(sourceImplicit ? { localSourceImplicit: true } : {}),
    emitResponseMeta: sinks.emitResponseMeta,
    emitNotice: sinks.emitNotice,
  } as OperationContext;
}

/** Only a plain OperationError round-trips exactly; subclasses and driver errors send the CLI to its cold path. */
function errorFrame(error: unknown, capture: OutputCapture): ResultFrame {
  if (error instanceof OperationError && error.constructor === OperationError && !('consent' in error)) {
    return { v: 1, kind: 'error', error: serializeOperationError(error), output: capture.chunks };
  }
  return { v: 1, kind: 'fallback', reason: 'unportable_error' };
}

async function runOp(engine: BrainEngine, request: Extract<CliSocketRequest, { kind: 'op' }>, capture: OutputCapture): Promise<ResultFrame> {
  const op = operationsByName[request.op];
  if (!op || op.scope !== 'read' || op.mutating) return { v: 1, kind: 'fallback', reason: 'not_a_read_op' };
  const params = request.params;
  const wallclockMs = request.cli.timeout_ms ?? DEFAULT_READ_WALLCLOCK_MS;
  let meta: Record<string, unknown> | null = null;
  const notices: Notice[] = [];
  const sinks = {
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval' && value !== null && typeof value === 'object') meta = value as Record<string, unknown>; },
    emitNotice: (notice: Notice) => { notices.push(notice); },
  };
  let stage = `gbrain ${request.command}: context`;
  try {
    const ctx = await withTimeout(cliRequestContext(engine, params, op, request, await mergedRequestConfig(engine), sinks), wallclockMs, stage);
    stage = `gbrain ${request.command}`;
    const raw = await withTimeout(op.handler(ctx, params), wallclockMs, stage);
    const result = JSON.parse(JSON.stringify(raw, bigintToStringReplacer) ?? 'null');
    return { v: 1, kind: 'result', result, meta, notices: [...notices, ...takeChatFallbackHopNotices()], output: capture.chunks };
  } catch (error) {
    if (error instanceof OperationTimeoutError) return { v: 1, kind: 'timeout', label: error.label, ms: error.ms, output: capture.chunks };
    if (op.name === 'get_page' && (error as { code?: unknown })?.code === 'page_body_segmented') return { v: 1, kind: 'fallback', reason: 'segmented_page' };
    return errorFrame(error, capture);
  }
}

async function runRecall(engine: BrainEngine, request: Extract<CliSocketRequest, { kind: 'recall' }>, capture: OutputCapture): Promise<ResultFrame> {
  const { recallVerbForCaller } = await import('../../commands/recall.ts');
  try {
    const raw = await recallVerbForCaller(engine, request.args, { cwd: request.routing.cwd, env: request.routing.source_env ?? undefined });
    if (raw === null) return { v: 1, kind: 'fallback', reason: 'not_a_recall_verb' };
    const result = JSON.parse(JSON.stringify(raw, bigintToStringReplacer) ?? 'null');
    return { v: 1, kind: 'result', result, meta: null, notices: [], output: capture.chunks };
  } catch (error) {
    return errorFrame(error, capture);
  }
}

/**
 * Runs one accepted request inside its own output capture and its own config
 * snapshot (config-snapshot.ts, the one MCP read ops use): the first config
 * read takes the table in one statement, every later read in the request
 * answers from it, and the snapshot closes when the request settles, so
 * nothing is cached across requests. Every op served here is non-mutating.
 */
export async function executeCliSocketRequest(engine: BrainEngine, request: CliSocketRequest): Promise<ResultFrame> {
  const capture = new OutputCapture();
  const frame = await withOutputCapture(capture, () => withRequestConfigSnapshot(engine, () => request.kind === 'op'
    ? runOp(engine, request, capture)
    : runRecall(engine, request, capture)));
  if (frame.kind === 'fallback') return frame;
  if (capture.overflow) return { v: 1, kind: 'fallback', reason: 'output_too_large' };
  return { ...frame, source: capture.resolvedSource ?? null };
}
