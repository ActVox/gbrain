/**
 * #2556 — persist a take row from a think synthesis (`gbrain think --take`).
 *
 * The `--take` flag has been documented since v0.28 ("appends a take row to
 * the anchor page") but `RunThinkOpts.take` was never read anywhere in the
 * pipeline: the CLI parsed it, the MCP op gated it (`safeTake`), and both
 * forwarded it into runThink where it died silently. This module is the
 * missing execution half, wired by commands/think.ts and the `think` op.
 *
 * Semantics:
 *   - synthesisOk === false → warn-skip (never persist a stub/empty answer;
 *     same gate persistSynthesis uses).
 *   - claim = the first substantive line of stripGapsSection(answer),
 *     markdown markers stripped, sanitized to a single fence-safe cell
 *     (control chars collapsed, fence-marker text removed, bounded length).
 *   - holder = resolveOwnerHolder (config emotional_weight.user_holder,
 *     else 'self') — the take is the OWNER's synthesized position.
 *   - persistence goes through the coordinated `takes_add` mutation (the
 *     same path `gbrain takes add` uses), which composes the fence from the
 *     page's database snapshot: a database-only page (`sync.write_through`
 *     off, a `storage.db_only` directory) gets the take in its database body
 *     and no file; a page whose file and database differ is refused
 *     (`source_changed`) with both copies kept (#6982). Before, the legacy
 *     md-first writer treated a page with no file as an empty body and
 *     created a takes-only file that the next sync imported over the page.
 *   - no brain repo (resolveTakesRepoDir null) → TAKE_MIRROR_UNAVAILABLE
 *     warning, nothing written.
 *
 * Remote (MCP) callers never reach this — the `think` op forces
 * safeTake=false for ctx.remote !== false, unchanged.
 */

import type { BrainEngine } from '../engine.ts';
import { stripGapsSection, type ThinkResult } from './index.ts';
import { resolveOwnerHolder } from '../owner-holder.ts';
import { resolveTakesRepoDir } from '../takes-write.ts';
import { deriveTrust, derivedMaintenanceTransaction } from '../trust/taint.ts';
import { loadConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { resolvePageWriteTarget } from '../write-through.ts';

/** Max claim length for a fence cell — one readable line, not an essay. */
export const TAKE_CLAIM_MAX_CHARS = 300;

export interface PersistTakeResult {
  /** Appended fence row number, or null when nothing was written. */
  take_row: number | null;
  /** Markdown file the row landed in (unset when nothing was written or the page is database-only). */
  path?: string;
  /** Machine-stable warning codes (mirrors the think warnings channel). */
  warnings: string[];
}

/**
 * Extract the claim line: first substantive line of the gaps-stripped answer,
 * heading/bullet/quote markers removed, sanitized to a single fence-safe
 * cell. Returns null when the answer has no substantive line. Pure — the
 * unit-test surface.
 */
export function claimFromAnswer(answer: string): string | null {
  const stripped = stripGapsSection(answer ?? '');
  for (const raw of stripped.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+>]\s+/, '').trim();
    if (!line) continue;
    // Fence-cell safety (assertSafeCellText would THROW on these; sanitizing
    // here keeps --take best-effort instead of failing the whole think run):
    // collapse control chars to spaces, drop the fence-marker substring.
    line = line
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\n\r\t]+/g, ' ')
      .replaceAll('gbrain:takes', '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!line) continue;
    if (line.length > TAKE_CLAIM_MAX_CHARS) {
      line = `${line.slice(0, TAKE_CLAIM_MAX_CHARS - 1).trimEnd()}…`;
    }
    // A wholly-strikethrough claim round-trips as active:false — unwrap it.
    const struck = /^~~([\s\S]*)~~$/.exec(line);
    if (struck) line = struck[1].trim();
    if (!line) continue;
    return line;
  }
  return null;
}

/**
 * Append the synthesis claim as a take row on the anchor page. Never throws
 * for the expected refusal shapes (no repo, empty answer, failed synthesis) —
 * those return take_row:null with a machine-stable warning so both callers
 * (CLI + op) surface the same story.
 */
export async function persistTakeFromSynthesis(
  engine: BrainEngine,
  result: Pick<ThinkResult, 'answer' | 'synthesisOk' | 'taint_refs'>,
  opts: { anchor: string; sourceId?: string },
): Promise<PersistTakeResult> {
  const warnings: string[] = [];

  // Same persistence gate as persistSynthesis: an explicit false means the
  // stub/malformed/empty path — a take asserting nothing must not be minted.
  if (result.synthesisOk === false) {
    warnings.push('TAKE_SKIPPED_SYNTHESIS_FAILED');
    return { take_row: null, warnings };
  }

  const claim = claimFromAnswer(result.answer);
  if (!claim) {
    warnings.push('TAKE_SKIPPED_EMPTY_ANSWER');
    return { take_row: null, warnings };
  }

  const brainDir = await resolveTakesRepoDir(engine);
  if (!brainDir) {
    // md is canonical for takes — with no repo there is nothing durable to
    // write (a DB-only row would be deleted by the next fence reconcile).
    warnings.push('TAKE_MIRROR_UNAVAILABLE');
    return { take_row: null, warnings };
  }

  const holder = resolveOwnerHolder({
    configValue: await engine.getConfig('emotional_weight.user_holder'),
  });
  const sourceId = opts.sourceId ?? 'default';

  // #5575 I2: the take restates the synthesis, so it carries the tier of everything in the synthesis prompt.
  const derivation = await deriveTrust(engine, result.taint_refs ?? [], { channel: 'derive:think' });
  try {
    const written = await submitPageMutation({
      engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, sourceId, dryRun: false,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }, { operation: 'takes_add', params: { slug: opts.anchor, claim, kind: 'take', holder, source: 'think', source_id: sourceId } });
    const rowNum = Number(written.row_num);
    await derivedMaintenanceTransaction(engine, derivation, async tx => ({ result: undefined, rows: (await tx.executeRaw<{ id: number }>(
      'SELECT k.id FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND p.slug=$2 AND k.row_num=$3',
      [sourceId, opts.anchor, rowNum])).map(take => ({ table: 'takes' as const, id: Number(take.id), sourceId })) }));
    const target = written.mirror_written ? await resolvePageWriteTarget(engine, opts.anchor, sourceId) : null;
    return { take_row: rowNum, ...(target?.ok ? { path: target.filePath } : {}), warnings };
  } catch (e) {
    // Typed write refusals (page not found, a file that differs from the
    // database, a malformed fence) become a loud warning + null row — think's
    // answer already printed and must not be lost to a persistence failure.
    const detail = e instanceof OperationError ? `${e.code}: ${e.message}` : (e instanceof Error ? e.message : String(e));
    warnings.push(`TAKE_WRITE_FAILED: ${detail}`);
    return { take_row: null, warnings };
  }
}
