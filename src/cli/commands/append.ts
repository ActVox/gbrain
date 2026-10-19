/**
 * Wave B write operations, CLI side (spec 6.1, 6.2, 6.5).
 *
 *   gbrain append <slug> [--file PATH]     append text to the end of a page
 *   gbrain put <slug> --file PATH          replace or create a page from a file
 *
 * `append` calls append_page with a generated request_id (`--request-id`
 * replays one); text whose append_page request would not fit the smallest
 * transport cap goes through an upload session with mode `append`.
 * `put --file` sends put_page while the page fits one request (the trusted
 * local CLI: the page ceiling; a thin client: the smallest transport cap) and
 * otherwise streams the file through an upload session, never holding it as
 * one string. Every call goes where any other CLI write goes: the remote
 * brain on a thin client, the resident owner when a serve holds the brain,
 * else this process's engine.
 */
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';
import { loadConfig, isThinClient } from '../../core/config.ts';
import { getCliOptions } from '../../core/cli-options.ts';
import { currentCliWriteWait } from '../../core/persistence/write-wait.ts';
import { maybeDelegateLocalOperation } from '../../core/persistence/local-client.ts';
import { RemoteMcpError } from '../../core/remote-mcp-error.ts';
import { OperationError, opError } from '../../core/ops/contract.ts';
import { PAGE_MAX_BYTES } from '../../core/page-size-policy.ts';
import { detectBinaryNullByte, detectBinarySignature } from '../../core/capture-content.ts';
import { readStdinPayload } from '../../core/stdin-read.ts';
import { finishCliTeardown, setCliExitVerdict, writeStdoutFinal } from '../../core/cli-force-exit.ts';
import { usageError, writeCliError } from '../cli-error.ts';
import { callRemoteTool, stringUploadBody, toolCallFrameBytes, unpackToolResult, uploadPageBody, type UploadBody, type UploadToolCall } from '../../core/mcp-client.ts';

/** The smallest inbound cap any transport has (legacy HTTP, 1 MiB) less the 4 KiB envelope reserve: a request this size reaches every brain. */
export const DIRECT_FRAME_MAX_BYTES = 1024 * 1024 - 4096;

/** Where a CLI write goes, plus the transient-failure test the upload driver resumes on. */
export interface PageWriteCaller {
  thin: boolean;
  call: UploadToolCall;
  transient(error: unknown): boolean;
  close(): Promise<void>;
}

/**
 * The CLI's route for page writes: `callRemoteTool` on a thin client, the
 * resident owner's socket when a serve holds this brain, else this process's
 * engine (connected on first use, torn down by `close`). `source` is the
 * `--source` flag; locally it resolves through the ambient chain, on a thin
 * client it travels as `source_id` and the host's grant decides. `teardown:
 * false` leaves an engine `connect` shares with the caller to the caller.
 */
export function pageWriteCaller(connect: () => Promise<BrainEngine>, source: string | null, opts: { teardown?: boolean } = {}): PageWriteCaller {
  const cfg = loadConfig();
  const cli = getCliOptions();
  const writeWaitMs = currentCliWriteWait().waitMs;
  if (isThinClient(cfg)) {
    return {
      thin: true,
      call: async (tool, args) => {
        const raw = await callRemoteTool(cfg!, tool, { ...args, ...(source ? { source_id: source } : {}) }, { timeoutMs: cli.timeoutMs ?? 120_000, writeWaitMs });
        return unpackToolResult<Record<string, unknown>>(raw);
      },
      transient: error => error instanceof RemoteMcpError && error.reason === 'network' && error.detail?.kind !== 'aborted',
      close: async () => {},
    };
  }
  let engine: BrainEngine | undefined;
  let sourceId: string | undefined;
  return {
    thin: false,
    call: async (tool, args) => {
      const wire = { ...args };
      const delegated = await maybeDelegateLocalOperation(tool, wire, cfg, { brain: cli.brain, source, timeoutMs: cli.timeoutMs ?? undefined, writeWaitMs });
      if (delegated.handled) return delegated.result as Record<string, unknown>;
      engine ??= await connect();
      if (sourceId === undefined) {
        const { resolveSourceWithTier } = await import('../../core/source-resolver.ts');
        sourceId = (await resolveSourceWithTier(engine, source)).source_id;
      }
      const { handleToolCall } = await import('../../mcp/server.ts');
      return await handleToolCall(engine, tool, wire, { sourceId, writeWaitMs }) as Record<string, unknown>;
    },
    transient: () => false,
    close: async () => { if (engine && opts.teardown !== false) await finishCliTeardown({ engine, drainTimeoutMs: 1000 }); },
  };
}

const utf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function notUtf8(label: string): OperationError {
  return opError('invalid_params', `${label} is not valid UTF-8 text.`,
    'Pages store UTF-8 text, so nothing was written. Convert the input to UTF-8 (for example with iconv) and run the command again.');
}

/** Refuses binary input by its head, the way capture does: a magic-byte signature or a NUL in the first 8 KiB. */
function assertTextHead(head: Buffer, label: string): void {
  const format = detectBinarySignature(head);
  const nul = detectBinaryNullByte(head);
  if (format === null && nul === -1) return;
  throw opError('invalid_params', `${label} is binary${format ? ` (${format})` : `: a NUL byte at offset ${nul}`}, not text.`,
    'Pages store text, so nothing was written. Extract the text first (for a PDF: pdftotext FILE -), then write that.');
}

/** Decodes bytes as strict UTF-8 after the binary guard; a BOM is kept so the stored bytes match the input. */
export function decodeTextInput(raw: Buffer, label: string): string {
  assertTextHead(raw.subarray(0, 8192), label);
  try { return utf8().decode(raw); } catch { throw notUtf8(label); }
}

/** A file as an upload body: hashed in one streaming pass, read again in order (strict UTF-8) for the parts. */
export async function fileUploadBody(path: string): Promise<UploadBody> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    assertTextHead(head.subarray(0, bytesRead), path);
  } finally { await handle.close(); }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return {
    bytes,
    sha256: hash.digest('hex'),
    async *text(fromByte: number) {
      const decoder = utf8();
      try {
        for await (const chunk of createReadStream(path, { start: fromByte })) {
          const text = decoder.decode(chunk as Buffer, { stream: true });
          if (text) yield text;
        }
        const tail = decoder.decode();
        if (tail) yield tail;
      } catch (error) {
        if (error instanceof TypeError) throw notUtf8(path);
        throw error;
      }
    },
  };
}

async function reportFailure(error: unknown, command: string, json: boolean, requestId: string | undefined): Promise<void> {
  const { reportPersistenceCliError } = await import('../../commands/persistence-delegate.ts');
  const receipt = !(error instanceof OperationError) || !!error.writeRequest;
  if (!receipt || !await reportPersistenceCliError(error, json || !!(error as OperationError)?.writeRequest)) setCliExitVerdict(writeCliError(error, command));
  if (requestId) process.stderr.write(`Retry the same ${command} with --request-id ${requestId}.\n`);
}

const HELP = `Usage: gbrain append <slug> [--file PATH] [options]
       gbrain append <slug> [options] < file

Adds text to the end of a page in time proportional to the text added
(append_page). Use it for conversation logs and running notes: re-putting a
large page to add a message rewrites the whole page.

Options:
  --file PATH            Read the text from a file (default: stdin)
  --request-id UUID      Replay an earlier append (retries never double-append)
  --expected-revision R  Append only to this revision of the page
  --expect-tail SHA256   Append only if the region still ends with this tail
                         (get_page body:'none' returns tail_sha256)
  --region R             auto (default: the last non-empty region), truth, timeline
  --separator S          auto (default: one newline when the tail lacks one), none
  --source ID            Multi-source brains: append to a page in this source
  --json                 Print the receipt as JSON
  --help, -h             Show this help

Text over one request goes through an upload session (begin, parts, commit)
and appends at the end of the page with region and separator auto.

Examples:
  echo "- 14:02 the next message" | gbrain append conversations/sessions/2026-10-19-standup
  gbrain append notes/running-log --file ./today.md --request-id 5f0c…
`;

interface AppendArgs {
  slug?: string; file?: string; request_id?: string; expected_revision?: string; expected_tail_sha256?: string;
  region?: string; separator?: string; source?: string; json: boolean; help: boolean;
}

const APPEND_FLAGS: Record<string, keyof AppendArgs> = {
  '--file': 'file', '--request-id': 'request_id', '--expected-revision': 'expected_revision', '--expect-tail': 'expected_tail_sha256',
  '--region': 'region', '--separator': 'separator', '--source': 'source',
};
const CHOICES: Partial<Record<keyof AppendArgs, readonly string[]>> = { region: ['auto', 'truth', 'timeline'], separator: ['auto', 'none'] };

export function parseAppendArgs(args: string[]): AppendArgs {
  const out: AppendArgs = { json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { if (args[i + 1] !== undefined && out.slug === undefined) out.slug = args[++i]; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    const m = /^(--[a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m && APPEND_FLAGS[m[1]!]) {
      const key = APPEND_FLAGS[m[1]!]!;
      const value = m[2] ?? args[++i];
      if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) throw usageError(`${m[1]} requires a value.`, 'Run gbrain append --help for the options.');
      const choices = CHOICES[key];
      if (choices && !choices.includes(value)) throw usageError(`${m[1]} must be one of: ${choices.join(', ')}; got '${value}'.`, 'Run gbrain append --help for the options.');
      (out as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    if (arg.startsWith('--')) throw usageError(`unknown flag ${arg.split('=')[0]} for 'gbrain append'`, 'Run gbrain append --help for the options.');
    if (out.slug !== undefined) throw usageError(`gbrain append takes one slug; got '${out.slug}' and '${arg}'.`, 'Pass the text with --file or on stdin, not as arguments.');
    out.slug = arg;
  }
  return out;
}

async function readAppendText(parsed: AppendArgs): Promise<string> {
  if (parsed.file) {
    let raw: Buffer;
    try { raw = readFileSync(parsed.file); } catch (error) {
      throw usageError(`Cannot read ${parsed.file}: ${error instanceof Error ? error.message : String(error)}`, 'Pass --file a readable text file.');
    }
    return decodeTextInput(raw, parsed.file);
  }
  if (process.stdin.isTTY) throw usageError('gbrain append needs text: pass --file PATH or pipe it on stdin.', 'Run gbrain append --help for examples.');
  const read = await readStdinPayload('echo "the next message" | gbrain append <slug>');
  if (!read.ok) throw usageError(read.message, 'Pipe the text on stdin, or pass --file PATH.');
  return decodeTextInput(read.raw, 'stdin');
}

function printAppendReceipt(result: Record<string, unknown>, json: boolean): Promise<void> {
  if (json) return writeStdoutFinal(JSON.stringify(result, null, 2) + '\n');
  const receipt = result.write_request as { state?: string; request_id?: string } | undefined;
  if (receipt?.state && receipt.state !== 'committed') {
    process.stderr.write(`Append ${receipt.state}; request_id ${receipt.request_id}. Retry the same request ID for its result.\n`);
    return Promise.resolve();
  }
  const lines = [`appended: ${String(result.slug)}`];
  for (const key of ['revision', 'appended_bytes', 'body_bytes', 'chunks_new', 'size_state']) {
    if (result[key] !== undefined) lines.push(`  ${key}: ${String(result[key])}`);
  }
  if (receipt?.request_id) lines.push(`  request_id: ${receipt.request_id}`);
  return writeStdoutFinal(lines.join('\n') + '\n');
}

/** `gbrain append` (a pre-connect-own-engine command: it opens the engine only when no owner or remote brain takes the call). */
export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  let parsed: AppendArgs;
  try { parsed = parseAppendArgs(args); } catch (error) { setCliExitVerdict(writeCliError(error, 'append')); return; }
  if (parsed.help) { console.log(HELP); return; }
  const requestId = parsed.request_id ?? randomUUID();
  let caller: PageWriteCaller | undefined;
  try {
    if (!parsed.slug) throw usageError("Missing required parameter 'slug' for 'gbrain append'.", 'Usage: gbrain append <slug> [--file PATH] (see `gbrain append --help`).');
    const text = await readAppendText(parsed);
    if (text.length === 0) throw usageError('Nothing to append: the text is empty.', 'Pass non-empty text with --file or on stdin.');
    caller = pageWriteCaller(() => ctx.connectEngine(), parsed.source ?? null);
    const params: Record<string, unknown> = {
      slug: parsed.slug, text, request_id: requestId,
      ...(parsed.expected_revision ? { expected_revision: parsed.expected_revision } : {}),
      ...(parsed.expected_tail_sha256 ? { expected_tail_sha256: parsed.expected_tail_sha256 } : {}),
      ...(parsed.region ? { region: parsed.region } : {}),
      ...(parsed.separator ? { separator: parsed.separator } : {}),
    };
    let result: Record<string, unknown>;
    if (toolCallFrameBytes('append_page', params) <= DIRECT_FRAME_MAX_BYTES) {
      result = await caller.call('append_page', params);
    } else {
      const unsupported = (['expected_tail_sha256', 'region', 'separator'] as const).filter(key => parsed[key] !== undefined);
      if (unsupported.length) {
        throw usageError(`${unsupported.map(key => ({ expected_tail_sha256: '--expect-tail', region: '--region', separator: '--separator' })[key]).join(', ')} apply only to an append that fits one request (about ${DIRECT_FRAME_MAX_BYTES} bytes of JSON).`,
          'A larger append goes through an upload session, which appends at the end with region and separator auto. Drop those flags, or split the text into appends under one request.');
      }
      result = await uploadPageBody(caller.call, {
        slug: parsed.slug, mode: 'append', request_id: requestId,
        ...(parsed.expected_revision ? { expected_revision: parsed.expected_revision } : {}),
      }, stringUploadBody(text), { transient: caller.transient, wait_ms: Math.min(currentCliWriteWait().waitMs, 30_000) });
    }
    await printAppendReceipt(result, parsed.json);
  } catch (error) {
    await reportFailure(error, 'append', parsed.json, requestId);
  } finally {
    await caller?.close();
  }
}

/**
 * `gbrain put <slug> --file PATH`: `params` are put's parsed CLI params with
 * `file`. Returns false after filling `content` from the file when the page
 * fits one put_page request, so the ordinary put dispatch sends it; returns
 * true after uploading a larger file through an upload session and printing
 * the receipt with `format`.
 */
export async function runPutFile(params: Record<string, unknown>, opts: {
  connect: () => Promise<BrainEngine>;
  format: (op: string, result: unknown, params: Record<string, unknown>) => string;
}): Promise<boolean> {
  const path = String(params.file);
  delete params.file;
  let size: number;
  try { size = statSync(path).size; } catch (error) {
    throw usageError(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, 'Pass --file a readable text file.');
  }
  const thin = isThinClient(loadConfig());
  if (size <= PAGE_MAX_BYTES) {
    const content = decodeTextInput(readFileSync(path), path);
    const fitsOneRequest = !thin || toolCallFrameBytes('put_page', { ...params, content }) <= DIRECT_FRAME_MAX_BYTES;
    if (fitsOneRequest) { params.content = content; return false; }
  }
  const json = params.json === true;
  const requestId = typeof params.request_id === 'string' ? params.request_id : randomUUID();
  const source = typeof params.source === 'string' ? params.source : typeof params.source_id === 'string' ? params.source_id : null;
  const caller = pageWriteCaller(opts.connect, source);
  try {
    const oneRequestOnly = ['allow_empty', 'allow_shrink', 'drop_timeline', 'force', 'dry_run'].filter(key => params[key] !== undefined && params[key] !== false);
    if (oneRequestOnly.length) {
      throw usageError(`${oneRequestOnly.map(key => `--${key.replace(/_/g, '-')}`).join(', ')} apply only to a page that fits one put_page request.`,
        `${path} is larger than one request, so it goes through an upload session, which replaces a page only with --expected-revision. Drop those flags.`);
    }
    const result = await uploadPageBody(caller.call, {
      slug: params.slug, mode: typeof params.expected_revision === 'string' ? 'replace' : 'create', request_id: requestId,
      ...(typeof params.expected_revision === 'string' ? { expected_revision: params.expected_revision } : {}),
    }, await fileUploadBody(path), {
      transient: caller.transient,
      wait_ms: typeof params.wait_ms === 'number' ? params.wait_ms : Math.min(currentCliWriteWait().waitMs, 30_000),
    });
    const output = opts.format('put_page', result, params);
    if (output) await writeStdoutFinal(output);
  } catch (error) {
    await reportFailure(error, 'put', json, requestId);
  } finally {
    await caller.close();
  }
  return true;
}

/** The capture options an upload of a large capture honors (capture.ts RunOpts). */
export interface CaptureUploadInput {
  slug?: string; type?: string; who?: string; what?: string; where?: string; kind?: string; depth?: string;
  source?: string; expected_revision?: string; force?: boolean;
}

/**
 * `capture --file` with a page larger than one request: the trusted local
 * CLI over the page ceiling, a thin client over the smallest transport cap.
 * The capture op's own admission composes the default slug and the capture
 * frontmatter (page-mutations.ts); an upload session carries a finished page,
 * so this composes them the same way before uploading.
 */
export async function uploadCapture(rawBody: string, input: CaptureUploadInput, requestId: string, connect: () => Promise<BrainEngine>): Promise<Record<string, unknown>> {
  if (input.force && !input.expected_revision) {
    throw usageError('--force applies only to a capture that fits one request.',
      'This capture is larger than one request, so it goes through an upload session, which replaces a page only with --expected-revision. Read the page revision with gbrain get --json and pass it.');
  }
  const caller = pageWriteCaller(connect, input.source ?? null, { teardown: false });
  const { defaultSlug, explicitCaptureType, mergeCaptureFrontmatter, normalizeForHash } = await import('../../core/capture-content.ts');
  const type = explicitCaptureType(rawBody, input.type) ?? 'note';
  const slug = input.slug ?? defaultSlug(normalizeForHash(rawBody), new Date(), type);
  const content = mergeCaptureFrontmatter(rawBody, {
    type, capturedVia: caller.thin ? 'capture-mcp' : 'capture-cli',
    ...Object.fromEntries((['who', 'what', 'where', 'kind', 'depth'] as const).filter(key => input[key] !== undefined).map(key => [key, input[key]])),
  });
  try {
    const result = await uploadPageBody(caller.call, {
      slug, mode: input.expected_revision ? 'replace' : 'create', request_id: requestId,
      ...(input.expected_revision ? { expected_revision: input.expected_revision } : {}),
    }, stringUploadBody(content), { transient: caller.transient, wait_ms: Math.min(currentCliWriteWait().waitMs, 30_000) });
    return { slug, ...result };
  } finally {
    await caller.close();
  }
}

/** Whether a capture's params are over one request on this route: the page ceiling locally, the smallest transport cap on a thin client. */
export function captureNeedsUpload(params: Record<string, unknown>, thin: boolean): boolean {
  if (thin) return toolCallFrameBytes('capture', params) > DIRECT_FRAME_MAX_BYTES;
  return typeof params.content === 'string' && Buffer.byteLength(params.content, 'utf8') > PAGE_MAX_BYTES;
}
