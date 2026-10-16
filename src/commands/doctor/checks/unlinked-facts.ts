/**
 * unlinked_facts (#5836): how many active facts carry no entity, so recall by
 * entity and the conflict sweep never see them, and whether new writes keep
 * adding to the pile.
 *
 * Reports, per the doctor's source scope (`--source`, else every source; the
 * caller's grant on the remote path): the unlinked share of the newest
 * active facts per source (capped so a 1M-fact brain stays fast), the
 * unlinked share of facts created in the last 7 days, how many facts
 * `gbrain facts relink` already judged to have no subject (`no_subject`),
 * the fence-owned unlinked rows (row_num or source_markdown_slug set: relink
 * rewrites their fence row), the conversation extractor's derived rows
 * (#6764: relink never examines them; re-extraction, which runs write-time
 * inference, is their fix), the top origins of unlinked facts, and the
 * 7-day links by tier from write-time inference and from relink.
 *
 * Warns when more than 25% of at least 20 new facts (facts judged
 * no_subject excluded) are unlinked. Every query is bounded by created_at
 * through idx_facts_since (source_id, created_at DESC WHERE expired_at IS
 * NULL) or by primary key; without fact_relink_attempts (a brain before
 * v187) the relink figures are omitted and nothing is excluded.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { AUDIT_ROW_SOURCES } from '../../../core/facts/audit-sources.ts';
import type { Check } from '../../doctor.ts';
import type { Action } from '../../../core/agent-output.ts';
import { doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

export const UNLINKED_NEW_SHARE_WARN = 0.25;
export const UNLINKED_NEW_MIN_FACTS = 20;
/** Newest active facts per source the overall share is computed over. */
export const UNLINKED_WINDOW_PER_SOURCE = 100_000;
/** Conversation pages one re-extraction fix names (`--slugs`). */
export const CONVERSATION_FIX_SLUGS = 50;
const DERIVED = `f.source LIKE 'cli:extract-conversation-facts%'`;

export interface UnlinkedFactsStats {
  sources: number;
  window: { active: number; unlinked: number; fence_owned: number; conversation: number; capped: boolean };
  /** The source with the most unlinked conversation-extractor rows in the window, and their pages (most rows first). */
  conversation: { source_id: string; pages: number; slugs: string[] } | null;
  new_7d: { facts: number; unlinked: number; no_subject: number };
  no_subject: number | null;
  origins: Array<{ origin: string; unlinked: number }>;
  inferred_7d: { page: number; mention: number };
  relinked_7d: Record<string, number> | null;
}

const ACTIVE = `f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source <> ALL($2::text[])`;
const ORIGIN = `CASE WHEN ${DERIVED} THEN 'conversation' WHEN f.source = 'mcp:put_page' THEN 'mcp:put_page'
  WHEN f.source LIKE 'mcp:%' OR f.source LIKE 'sync:%' OR f.source LIKE 'hook:%' OR f.source IN ('file_upload', 'code_import') THEN 'extraction'
  ELSE 'remember' END`;
const INFERRED = `(f.context LIKE 'entity inferred from %' OR f.context LIKE '% — entity inferred from %')`;
const INFERRED_TIER = `substring(f.context from 'entity inferred from ([a-z]+)')`;

const n = (v: unknown) => Number(v ?? 0);

/** Null when the brain has no facts table (nothing to report). */
export async function unlinkedFactsStats(engine: BrainEngine, sourceIds?: readonly string[]): Promise<UnlinkedFactsStats | null> {
  const [tables] = await engine.executeRaw<{ facts: string | null; attempts: string | null }>(
    `SELECT to_regclass('facts')::text AS facts, to_regclass('fact_relink_attempts')::text AS attempts`);
  if (!tables?.facts) return null;
  const hasAttempts = !!tables.attempts;
  const ids = sourceIds?.length ? [...sourceIds] : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id')).map((r) => r.id);
  const audit = [...AUDIT_ROW_SOURCES];
  const windowRows = await engine.executeRaw<{ source_id: string; origin: string; active: number; unlinked: number; fence_owned: number; conversation: number }>(
    `SELECT s.id AS source_id, w.origin, COUNT(*)::int AS active, COUNT(*) FILTER (WHERE w.unlinked)::int AS unlinked,
            COUNT(*) FILTER (WHERE w.unlinked AND w.fence_owned AND NOT w.derived)::int AS fence_owned,
            COUNT(*) FILTER (WHERE w.unlinked AND w.derived)::int AS conversation
       FROM unnest($1::text[]) AS s(id) CROSS JOIN LATERAL (
         SELECT ${ORIGIN} AS origin, f.entity_slug IS NULL AS unlinked, ${DERIVED} AS derived,
                (f.row_num IS NOT NULL OR f.source_markdown_slug IS NOT NULL) AS fence_owned
           FROM facts f WHERE f.source_id = s.id AND ${ACTIVE}
          ORDER BY f.created_at DESC LIMIT $3) w
      GROUP BY s.id, w.origin`,
    [ids, audit, UNLINKED_WINDOW_PER_SOURCE],
  );
  const perSource = new Map<string, number>();
  const byOrigin = new Map<string, number>();
  const derivedBySource = new Map<string, number>();
  for (const r of windowRows) {
    perSource.set(r.source_id, (perSource.get(r.source_id) ?? 0) + n(r.active));
    derivedBySource.set(r.source_id, (derivedBySource.get(r.source_id) ?? 0) + n(r.conversation));
    if (n(r.unlinked) > 0) byOrigin.set(r.origin, (byOrigin.get(r.origin) ?? 0) + n(r.unlinked));
  }
  const judged = hasAttempts
    ? `EXISTS (SELECT 1 FROM fact_relink_attempts a WHERE a.source_id = f.source_id AND a.fact_id = f.id AND a.outcome = 'no_subject')`
    : 'false';
  const [recent] = await engine.executeRaw<Record<string, unknown>>(
    `SELECT COUNT(*)::int AS facts, COUNT(*) FILTER (WHERE f.entity_slug IS NULL)::int AS unlinked,
            COUNT(*) FILTER (WHERE f.entity_slug IS NULL AND ${judged})::int AS no_subject,
            COUNT(*) FILTER (WHERE ${INFERRED} AND ${INFERRED_TIER} = 'page')::int AS inferred_page,
            COUNT(*) FILTER (WHERE ${INFERRED} AND ${INFERRED_TIER} = 'mention')::int AS inferred_mention
       FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.created_at >= now() - interval '7 days' AND ${ACTIVE}`,
    [ids, audit],
  );
  let noSubject: number | null = null;
  let relinked: Record<string, number> | null = null;
  if (hasAttempts) {
    const rows = await engine.executeRaw<{ outcome: string; tier: string | null; n: number }>(
      `SELECT outcome, tier, COUNT(*)::int AS n FROM fact_relink_attempts
        WHERE source_id = ANY($1::text[])
          AND (outcome = 'no_subject' OR (outcome = 'linked' AND attempted_at >= now() - interval '7 days'))
        GROUP BY outcome, tier`,
      [ids],
    );
    noSubject = rows.filter((r) => r.outcome === 'no_subject').reduce((sum, r) => sum + n(r.n), 0);
    relinked = {};
    for (const r of rows.filter((x) => x.outcome === 'linked')) relinked[r.tier ?? 'unknown'] = (relinked[r.tier ?? 'unknown'] ?? 0) + n(r.n);
  }
  const [derivedSource] = [...derivedBySource].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  let conversation: UnlinkedFactsStats['conversation'] = null;
  if (derivedSource) {
    const pages = await engine.executeRaw<{ slug: string }>(
      `SELECT w.slug FROM (SELECT f.source_markdown_slug AS slug, f.entity_slug IS NULL AND ${DERIVED} AS hit
           FROM facts f WHERE f.source_id = $1 AND ${ACTIVE} ORDER BY f.created_at DESC LIMIT $3) w
        WHERE w.hit AND w.slug IS NOT NULL GROUP BY w.slug ORDER BY COUNT(*) DESC, w.slug`,
      [derivedSource[0], audit, UNLINKED_WINDOW_PER_SOURCE],
    );
    conversation = { source_id: derivedSource[0], pages: pages.length, slugs: pages.slice(0, CONVERSATION_FIX_SLUGS).map(r => r.slug) };
  }
  return {
    sources: ids.length,
    conversation,
    window: {
      active: windowRows.reduce((sum, r) => sum + n(r.active), 0),
      unlinked: windowRows.reduce((sum, r) => sum + n(r.unlinked), 0),
      fence_owned: windowRows.reduce((sum, r) => sum + n(r.fence_owned), 0),
      conversation: windowRows.reduce((sum, r) => sum + n(r.conversation), 0),
      capped: [...perSource.values()].some((c) => c >= UNLINKED_WINDOW_PER_SOURCE),
    },
    new_7d: { facts: n(recent?.facts), unlinked: n(recent?.unlinked), no_subject: n(recent?.no_subject) },
    no_subject: noSubject,
    origins: [...byOrigin].map(([origin, unlinked]) => ({ origin, unlinked })).sort((a, b) => b.unlinked - a.unlinked || a.origin.localeCompare(b.origin)),
    inferred_7d: { page: n(recent?.inferred_page), mention: n(recent?.inferred_mention) },
    relinked_7d: relinked,
  };
}

const pct = (part: number, whole: number) => whole > 0 ? `${(100 * part / whole).toFixed(1)}%` : '0%';

/**
 * The check body (status, message, details) for the stats. `thinClient`: the caller cannot run relink itself (the
 * remote doctor path), so the hint asks the brain host operator to.
 */
export function unlinkedFactsVerdict(stats: UnlinkedFactsStats | null, opts: { thinClient?: boolean } = {}): Omit<Check, 'name'> {
  if (!stats) return { status: 'ok', message: 'No facts table yet; nothing to link.' };
  const { window: w, new_7d: recent } = stats;
  const eligible = recent.facts - recent.no_subject;
  const unlinkedNew = recent.unlinked - recent.no_subject;
  const warn = eligible >= UNLINKED_NEW_MIN_FACTS && unlinkedNew / eligible > UNLINKED_NEW_SHARE_WARN;
  const hint = opts.thinClient
    ? 'ask the brain host operator to run: gbrain facts relink --dry-run'
    : 'preview links: gbrain facts relink --dry-run';
  if (w.active === 0 && recent.facts === 0) return { status: 'ok', message: 'No active facts yet; nothing to link.', details: { ...stats, fix: hint } };
  const parts = [
    `${pct(w.unlinked, w.active)} of ${w.active} active facts have no entity (${w.unlinked}${w.capped ? `; newest ${UNLINKED_WINDOW_PER_SOURCE} per source` : ''}; ${w.fence_owned} fence-owned${w.conversation ? `; ${w.conversation} from conversation extraction` : ''})`,
    `last 7 days: ${pct(unlinkedNew, eligible)} of ${eligible} new facts unlinked`,
    stats.no_subject === null ? 'relink history unavailable (fact_relink_attempts missing)' : `${stats.no_subject} judged no_subject`,
    `7-day links: inferred page ${stats.inferred_7d.page}, mention ${stats.inferred_7d.mention}${stats.relinked_7d ? `; relink ${Object.entries(stats.relinked_7d).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, c]) => `${t} ${c}`).join(', ') || 'none'}` : ''}`,
  ];
  if (stats.origins.length > 0) parts.push(`top origins: ${stats.origins.slice(0, 3).map((o) => `${o.origin} ${o.unlinked}`).join(', ')}`);
  const fix = stats.conversation ? reextractFix(stats.conversation, opts.thinClient === true) : undefined;
  const conversationHint = fix ? ` Conversation facts are derived from their page, so relink never examines them; re-extract instead (paid, preview first): ${fix.preview_argv!.join(' ')}.` : '';
  return {
    status: warn ? 'warn' : 'ok',
    message: `${parts.join('; ')}${warn || w.unlinked > 0 ? `. ${warn ? `Over ${UNLINKED_NEW_SHARE_WARN * 100}% of new facts are unlinked; ` : ''}${hint}` : ''}${conversationHint}`,
    details: { ...stats, new_7d: { ...recent, eligible, unlinked_eligible: unlinkedNew }, fix: hint },
    ...(fix ? { fix } : {}),
  };
}

/**
 * #6764: the conversation share's fix, a bounded re-extraction of the pages
 * holding the most unlinked derived rows in one source, capped at $1, with a
 * free dry run as the preview. Re-extraction reruns the extractor with the
 * page's entity hints and write-time subject inference.
 */
function reextractFix(c: NonNullable<UnlinkedFactsStats['conversation']>, thinClient: boolean): Action {
  const base = ['gbrain', 'extract-conversation-facts', '--source-id', c.source_id, '--slugs', c.slugs.join(','), '--force'];
  return {
    argv: [...base, '--max-cost-usd', '1'], preview_argv: [...base, '--dry-run'], consent: ['paid', 'egress'],
    actor: thinClient ? 'host_admin' : 'agent', ask_user: true, requires_exclusive: false, verify: doctorVerify('unlinked_facts'),
    why: `${c.pages} conversation page(s) in source ${c.source_id} hold extracted facts with no entity${c.pages > c.slugs.length ? ` (the ${c.slugs.length} with the most are named)` : ''}. `
      + 'Re-extraction calls the fact-extraction model again (up to $1) with the page\'s entity hints and write-time subject inference; the dry run shows the plan and makes no model call.',
  };
}

/**
 * The `doctorReportRemote` copy: indexed counts inside the caller's source grant. A remote caller (anything not
 * strictly `remote: false`) cannot run relink, so its hint names the brain host operator.
 */
export async function remoteUnlinkedFactsCheck(engine: BrainEngine, opts: { sourceIds?: string[]; remote?: boolean }): Promise<Check> {
  try {
    return { name: 'unlinked_facts', ...unlinkedFactsVerdict(await unlinkedFactsStats(engine, opts.sourceIds), { thinClient: opts.remote !== false }) };
  } catch (err) {
    return { name: 'unlinked_facts', status: 'warn', message: `Unlinked facts could not be counted: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` };
  }
}

async function runUnlinkedFacts(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('unlinked_facts');
  try {
    const stats = await unlinkedFactsStats(engine, ctx.orphanRatioSourceId ? [ctx.orphanRatioSourceId] : undefined);
    checks.push({ name: 'unlinked_facts', ...unlinkedFactsVerdict(stats) });
  } catch (err) {
    checks.push({ name: 'unlinked_facts', status: 'warn', message: `Unlinked facts could not be counted: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` });
  }
  return checks;
}

export const unlinkedFactsEntry: DoctorEntry = { name: 'unlinked_facts', emits: ['unlinked_facts'], run: runUnlinkedFacts };
