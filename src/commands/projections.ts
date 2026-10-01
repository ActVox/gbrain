/**
 * `gbrain projections drain` (#5401): rebuilds queued Markdown and code text
 * projections in-process, in batches of up to 100, until every row queued
 * before the run started has been tried once. Trusted local CLI only; it is not
 * an operation, so MCP and remediation cannot run it.
 *
 * Postgres: safe beside a resident owner, because each page is rebuilt under
 * its page lock with a revision recheck. PGLite: a resident owner holds the
 * datastore, so the command refuses before opening the engine and the
 * resident drains the backlog itself.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { OperationError } from '../core/ops/contract.ts';
import { catalogueError } from '../core/error-catalogue.ts';
import type { LockHolderInfo } from '../core/pglite-lock.ts';
import type { ProgressReporter } from '../core/progress.ts';
import {
  projectionBacklog, rebuildPendingPageProjections, type ProjectionRebuildFailure,
} from '../core/page-state/projections.ts';
import { SERVE_LAUNCHD_LABEL, SERVE_SYSTEMD_UNIT } from '../core/serve-service.ts';
import { AUTOPILOT_SYSTEMD_UNIT } from './autopilot.ts';
import { autopilotLaunchdLabel } from '../core/autopilot-paths.ts';

export const PROJECTION_DRAIN_DOCS = 'docs/guides/repair.md#projection-drain';
const BATCH = 100;

export const PROJECTIONS_HELP = `Usage: gbrain projections drain [--limit <n>] [--json]

Rebuild queued Markdown and code text projections now, in batches of up to 100,
until every row queued before the run started has been tried once.

  --limit <n>   Try at most n pages in this run (default: no cap)
  --json        Print {rebuilt, superseded, failed, remaining} to stdout

Exit codes: 0 nothing tried failed; 1 some pages failed; 2 did not run
(projection_owner_resident: a resident gbrain process holds this PGLite brain
and drains it itself).

On Postgres the drain is safe while \`gbrain serve\` runs. Progress goes to stderr.
Docs: ${PROJECTION_DRAIN_DOCS}
`;

export interface ProjectionDrainResult {
  rebuilt: number;
  superseded: number;
  failed: ProjectionRebuildFailure[];
  remaining: number;
  limited: boolean;
}

export async function drainProjections(engine: BrainEngine, opts: { limit?: number; progress?: ProgressReporter } = {}): Promise<ProjectionDrainResult> {
  const [{ runStart }] = await engine.executeRaw<{ runStart: string }>('SELECT now()::text AS "runStart"');
  // PGLite's clock can be coarse: wait until it passes the run start, so a page
  // that fails in this run is stamped after it and is not tried again.
  while (!(await engine.executeRaw<{ passed: boolean }>('SELECT now()>$1::text::timestamptz AS passed', [runStart]))[0]?.passed) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const total = (await projectionBacklog(engine)).pending;
  opts.progress?.start('projections.drain', opts.limit === undefined ? total : Math.min(total, opts.limit));
  const failed: ProjectionRebuildFailure[] = [];
  let rebuilt = 0;
  let superseded = 0;
  let tried = 0;
  try {
    while (opts.limit === undefined || tried < opts.limit) {
      const failuresBefore = failed.length;
      const batch = await rebuildPendingPageProjections(engine, Math.min(BATCH, (opts.limit ?? Infinity) - tried),
        { notAfter: runStart, onFailure: failure => failed.push(failure) });
      const attempted = batch.rebuilt + batch.superseded + failed.length - failuresBefore;
      if (attempted === 0) break;
      rebuilt += batch.rebuilt;
      superseded += batch.superseded;
      tried += attempted;
      opts.progress?.tick(attempted, `${rebuilt} rebuilt, ${failed.length} failed`);
    }
  } finally {
    opts.progress?.finish();
  }
  const remaining = (await projectionBacklog(engine)).pending;
  return { rebuilt, superseded, failed, remaining, limited: opts.limit !== undefined && tried >= opts.limit && remaining > 0 };
}

/** The next step for one failed page, from the preparation error it reported. */
export function projectionFailureNextAction(failure: ProjectionRebuildFailure): string {
  if (failure.reason.startsWith('Code projection requires a recorded source path')) {
    return `restore frontmatter.file or source_path on ${failure.slug}, then run \`gbrain projections drain\` again`;
  }
  if (failure.reason.startsWith('This page kind requires its source importer')) {
    return `re-import it from its source: \`gbrain sync --source ${failure.source_id}\``;
  }
  return 'run `gbrain doctor`; the page stays queued and `gbrain projections drain` tries it again on its next run';
}

/** Stop, drain and restart commands for each way a resident owner can run. */
export function residentDrainSteps(pid: number | undefined): string {
  const uid = '$(id -u)';
  return [
    `To drain faster, stop the owner, drain, then restart it:`,
    `  gbrain serve service (launchd): launchctl bootout gui/${uid}/${SERVE_LAUNCHD_LABEL} && gbrain projections drain && launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/${SERVE_LAUNCHD_LABEL}.plist`,
    `  gbrain serve service (systemd): systemctl --user stop ${SERVE_SYSTEMD_UNIT} && gbrain projections drain && systemctl --user start ${SERVE_SYSTEMD_UNIT}`,
    `  autopilot (launchd): launchctl bootout gui/${uid}/${autopilotLaunchdLabel()} && gbrain projections drain && launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/${autopilotLaunchdLabel()}.plist`,
    `  autopilot (systemd): systemctl --user stop ${AUTOPILOT_SYSTEMD_UNIT} && gbrain projections drain && systemctl --user start ${AUTOPILOT_SYSTEMD_UNIT}`,
    `  a manual gbrain serve: stop it${pid ? ` (kill ${pid})` : ''}, run gbrain projections drain, then start gbrain serve again`,
  ].join('\n');
}

/** DX-O5 refusal: the drain did not run because a resident process holds this PGLite brain. */
export function projectionOwnerResidentError(holder: LockHolderInfo, dataDir: string): OperationError {
  const owner = `${holder.subcommand ? `gbrain ${holder.subcommand}` : 'a gbrain process'}${holder.pid ? ` (pid ${holder.pid})` : ''}`;
  return catalogueError('projection_owner_resident',
    `The PGLite brain at ${dataDir} is held by ${owner}, so the drain did not run.`,
    [
      `The upgraded resident drains queued projections itself (up to 100 pages per pass, fewer while writes wait); watch the pending count with \`gbrain doctor\` (text_projection_readiness).`,
      residentDrainSteps(holder.pid),
    ].join('\n'));
}
