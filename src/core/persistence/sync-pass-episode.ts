/**
 * #6712 PR 4b (design v3.2 §6, §7): a live pass's episode closure and its cost reservations.
 *
 * **Closure** (§6, dx-outside-1, eng-outside-2). An episode stores its selection, so its universe is `U_E = eligible_E(T)`.
 * A converged round closes it in the pass's checkpoint when either (a) `U_E ⊆ U_pass`, a set inclusion over the paths
 * of `T`, or (b) the pass is at the configured selection, which releases the paths of `U_E` the source does not sync.
 * `chunker_version` is stamped only when (b) holds and `U_E ⊇ U_config`. So a scoped `--full --exclude X` closes its own
 * episode by (a) without advancing `last_commit`; a plain sync closes any episode by (b); a narrower takeover satisfies
 * neither and leaves it open. There is no abandon command: the plain sync (`resume_argv`) always terminates.
 *
 * **Cost** (§7). Each admitted group reserves its priced embedding spend in its own row, `op='sync-pass-cost'`,
 * fingerprint `<source>:<incarnation>:<episode_or_pass_id>:<group_id>`, value `{source_id, incarnation, usd}`, inserted
 * `ON CONFLICT DO NOTHING` inside the group's admission transaction (`reservePassCost`, from `assertPassAdmission`), so a
 * kill after the admission keeps the reservation and a replay adds nothing. `reserved_usd` is a range read. A pass row
 * lost while reservations exist makes the cost `unknown`: paid work defers until the owner approves again (`--yes`).
 */
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { estimateCostFromChars } from '../embedding-pricing.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';
import { isSyncable, matchesAnyGlob } from '../sync.ts';
import { parseUsdLimit } from '../spend-posture.ts';
import { digest } from './digest.ts';
import { readTreeLevel } from './sync-git-stream.ts';
import { loopYield } from './sync-yield.ts';
import { SYNC_PASS_COST_OP, type PassEpisode, type SyncSelection } from './sync-pass-row.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

/** Whether a Git-root path is in the universe of `selection` (the eligibility of sync-pass.ts `readShadowLevel`). */
export function selectionEligible(selection: SyncSelection, scope: string, slugMode: 'git-root' | 'source-root'): (gitPath: string) => boolean {
  const sub = selection.srcSubpath ? selection.srcSubpath.replace(/^\/+|\/+$/g, '') : scope;
  const includeHidden = selection.includeHidden.map(v => v.endsWith('/') ? `${v}**` : v);
  return gitPath => {
    if (sub && !gitPath.startsWith(`${sub}/`)) return false;
    const sourceRelative = sub ? gitPath.slice(sub.length + 1) : gitPath;
    return !matchesAnyGlob(sourceRelative, selection.exclude) && !isReservedSkillBundlePath(slugMode === 'source-root' ? sourceRelative : gitPath)
      && isSyncable(gitPath, { strategy: (selection.strategy ?? 'markdown') as 'markdown', includeHidden });
  };
}

export interface EpisodeClosure {
  closes: boolean;
  by: 'inclusion' | 'configured' | null;
  /** (b) and `U_E ⊇ U_config`. */
  stampChunker: boolean;
  /** Paths of `U_E` outside the configured universe that a closure by (b) releases. */
  released: number;
}

type ClosureInput = { episode: SyncSelection; pass: SyncSelection; configuredSelection: SyncSelection; configured: boolean; scope: string; slugMode: 'git-root' | 'source-root' };
interface ClosureTally { included: boolean; covers: boolean; released: number }

/** One stretch of design §6's closure test: `paths` folded into `tally`. */
function tallyClosure(input: ClosureInput, paths: Iterable<string>, tally: ClosureTally): ClosureTally {
  const inE = selectionEligible(input.episode, input.scope, input.slugMode);
  const inPass = selectionEligible(input.pass, input.scope, input.slugMode);
  const inConfig = selectionEligible(input.configuredSelection, input.scope, input.slugMode);
  for (const path of paths) {
    const e = inE(path), c = inConfig(path);
    if (e && !inPass(path)) tally.included = false;
    if (c && !e) tally.covers = false;
    if (e && !c) tally.released++;
  }
  return tally;
}

function closureOf(configured: boolean, { included, covers, released }: ClosureTally): EpisodeClosure {
  if (configured) return { closes: true, by: 'configured', stampChunker: covers, released };
  return included ? { closes: true, by: 'inclusion', stampChunker: false, released: 0 } : { closes: false, by: null, stampChunker: false, released: 0 };
}

/** Design §6's closure test over the paths of `T` (the module header). */
export function episodeClosure(input: ClosureInput & { treePaths: Iterable<string> }): EpisodeClosure {
  return closureOf(input.configured, tallyClosure(input, input.treePaths, { included: true, covers: true, released: 0 }));
}

/** The closure of an open episode at the pinned target `head` (one `ls-tree` of the whole commit), yielding between stretches. */
export async function passEpisodeClosure(input: { gitRoot: string; root: string; head: string; slugMode: 'git-root' | 'source-root'; episode: PassEpisode; pass: SyncSelection;
  configuredSelection: SyncSelection; configured: boolean }): Promise<EpisodeClosure> {
  const scope = relative(realpathSync.native(input.gitRoot), realpathSync.native(input.root)).split(sep).join('/');
  const paths = [...(await readTreeLevel(input.gitRoot, input.head, '')).keys()];
  const closure: ClosureInput = { episode: input.episode.selection, pass: input.pass, configuredSelection: input.configuredSelection, configured: input.configured, scope, slugMode: input.slugMode };
  const tally: ClosureTally = { included: true, covers: true, released: 0 };
  const step = loopYield();
  for (let i = 0; i < paths.length; i += CLOSURE_STRETCH) {
    tallyClosure(closure, paths.slice(i, i + CLOSURE_STRETCH), tally);
    if (step.due(CLOSURE_STRETCH)) await step.pause();
  }
  return closureOf(input.configured, tally);
}
const CLOSURE_STRETCH = 2_048;

/** What a pass's admissions reserve under (registered at pin, dropped at the pass's end). */
interface PassCostScope { sourceId: string; incarnation: string; scope: string; pricePerMTok: number }
const passCostScopes = new Map<string, PassCostScope>();

export function registerPassCost(passId: string, scope: PassCostScope): void { passCostScopes.set(passId, scope); }
export function unregisterPassCost(passId: string): void { passCostScopes.delete(passId); }

const costPrefix = (sourceId: string, incarnation: string, scope?: string) => `${sourceId}:${incarnation}:${scope === undefined ? '' : `${scope}:`}`;

/** The intent fields a reservation prices: imports whose embeddings are not opted out, by their content's length. */
export interface PricedIntent { passId?: string; kind: string; path?: string | null; level?: string | null; content?: string | null; processingOptions?: { noEmbed?: boolean } | null }

/**
 * Inside a group's admission transaction: reserves the group's priced embedding spend as one `sync-pass-cost` row,
 * `ON CONFLICT DO NOTHING` (a replay of the same group reserves nothing more). A group with no paid import reserves nothing.
 */
export async function reservePassCost(tx: Exec, intents: ReadonlyArray<PricedIntent>): Promise<void> {
  const passId = intents.find(intent => intent.passId)?.passId;
  const scope = passId ? passCostScopes.get(passId) : undefined;
  if (!scope) return;
  const paid = intents.filter(intent => intent.passId === passId && intent.kind === 'managed_sync_import' && intent.processingOptions?.noEmbed !== true && typeof intent.content === 'string');
  if (!paid.length) return;
  const chars = paid.reduce((sum, intent) => sum + intent.content!.length, 0);
  const groupId = digest(['sync-pass-cost-v1', passId!, ...paid.map(intent => `${intent.path ?? ''}\0${intent.level ?? ''}`).sort()]).slice(0, 32);
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array($3::text::jsonb),now()) ON CONFLICT (op,fingerprint) DO NOTHING`,
    [SYNC_PASS_COST_OP, `${costPrefix(scope.sourceId, scope.incarnation, scope.scope)}${groupId}`,
      JSON.stringify({ source_id: scope.sourceId, incarnation: scope.incarnation, usd: estimateCostFromChars(chars, scope.pricePerMTok) })]);
}

/** `reserved_usd`: the reservations of one episode (or pass) scope, or of the whole incarnation; a range read. */
export async function readReservedUsd(exec: Exec, sourceId: string, incarnation: string, scope?: string): Promise<{ usd: number; rows: number }> {
  const [row] = await exec.executeRaw<{ usd: number | string | null; rows: number | string }>(
    `SELECT COALESCE(sum((completed_keys->0->>'usd')::numeric),0)::float8 AS usd, count(*) AS rows FROM op_checkpoints WHERE op=$1 AND starts_with(fingerprint, $2)`,
    [SYNC_PASS_COST_OP, costPrefix(sourceId, incarnation, scope)]);
  return { usd: Number(row?.usd ?? 0), rows: Number(row?.rows ?? 0) };
}

/**
 * The pass's cost decision at pin (design §7, v3 §7): `approved_usd` is the owner's approval (the prior row's, an explicit
 * `--yes`, else the `sync.cost_gate_min_usd` floor); null (`unknown`) when the pass row is missing while reservations of
 * the incarnation exist. `defer`: paid work (embeddings) defers for this pass, because the cost is unknown or the scope's
 * reservations already reached the approval.
 */
export async function passCostDecision(engine: BrainEngine, input: { sourceId: string; incarnation: string; scope: string; priorRow: boolean;
  prior: { approved_usd: number | null; reserved_usd: number } | undefined; approved: boolean }): Promise<{ cost: { approved_usd: number | null; reserved_usd: number }; defer: 'cost_unknown' | 'cost_reserved' | null }> {
  const reserved = await readReservedUsd(engine, input.sourceId, input.incarnation, input.scope);
  const floor = parseUsdLimit(await engine.getConfig('sync.cost_gate_min_usd').catch(() => null), 0.5, { allowZero: true });
  if (input.approved) return { cost: { approved_usd: Number.isFinite(floor) ? Math.max(floor, reserved.usd + floor) : null, reserved_usd: reserved.usd }, defer: null };
  const lost = !input.priorRow && (await readReservedUsd(engine, input.sourceId, input.incarnation)).rows > 0;
  if (lost || (input.priorRow && input.prior && input.prior.approved_usd === null)) return { cost: { approved_usd: null, reserved_usd: reserved.usd }, defer: 'cost_unknown' };
  const approved = input.prior?.approved_usd ?? (Number.isFinite(floor) ? floor : null);
  return { cost: { approved_usd: approved, reserved_usd: reserved.usd }, defer: approved !== null && reserved.usd >= approved && reserved.usd > 0 ? 'cost_reserved' : null };
}
