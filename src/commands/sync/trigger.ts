/** `gbrain sync trigger`: ask for a sync of one source without waiting for it (GBRA-133 PR 2a). */
import type { BrainEngine } from '../../core/engine.ts';

export type TriggerAction = 'queued' | 'nudged' | 'coalesced' | 'no_resident';

export interface TriggerOutcome {
  action: TriggerAction;
  source_id: string;
  intent: 'freshness' | 'pull' | 'full';
  wanted_head: string | null;
  marker_generation: number;
  job_id?: number;
}

const USAGE = 'Usage: gbrain sync trigger --source <id> [--priority high|normal|low] [--json]';

export function printSyncTriggerHelp(): void {
  console.log(`${USAGE}

Ask for a sync of one source without waiting for it. The request is recorded
as a wanted marker (one per source and intent: freshness for a managed source,
its checkout's HEAD; pull for a classic source), so it is never lost while
another sync runs: whoever drains the source re-checks the marker afterwards.

Outcomes (stdout keeps job_id=N whenever a job is queued; --json prints
{action, job_id?, wanted_head, ...}):
  queued      a sync job was queued (Postgres; a jobs worker or autopilot runs it)
  coalesced   a sync job for this source is already waiting or running; the
              marker makes it (or the notifier) run once more if needed
  nudged      the running gbrain serve recorded the request and its notifier
              starts the sync (PGLite)
  no_resident the request is recorded, but nothing on this brain will sync it
              until a resident starts; exit 3 with the fix
              gbrain sync --source <id> --no-pull

Exit 0 for queued, coalesced and nudged; 3 for no_resident.

See also:
  gbrain sources webhook set <id>   Set up GitHub-signed push webhook
  gbrain sync status --source <id>  The notifier block: who syncs it, its state
`);
}

export function printTriggerOutcome(o: TriggerOutcome, json: boolean): void {
  if (json) { console.log(JSON.stringify(o)); return; }
  const head = o.wanted_head ? o.wanted_head.slice(0, 8) : 'upstream';
  if (o.job_id !== undefined) console.log(`job_id=${o.job_id}`);
  else console.log(`action=${o.action}`);
  const line: Record<TriggerAction, string> = {
    queued: `queued sync job ${o.job_id} for ${o.source_id} (${o.intent}, wanted ${head})`,
    coalesced: `a sync job for ${o.source_id} is already waiting or running (job ${o.job_id}); the request is recorded and runs once more if that job does not reach ${head}`,
    nudged: `the running serve recorded the request for ${o.source_id} (${o.intent}, wanted ${head}) and its notifier starts the sync`,
    no_resident: `recorded the request for ${o.source_id} (${o.intent}, wanted ${head}), but no resident (gbrain serve, gbrain jobs work or the autopilot daemon) runs on this brain to sync it. Run: gbrain sync --source ${o.source_id} --no-pull`,
  };
  console.error(`[sync trigger] ${line[o.action]}`);
}

/**
 * The engine path: Postgres queues a job (single flight per source through maxPending 1; the wanted marker replaces
 * the old 30 s idempotency bucket), PGLite records the marker and reports no_resident (a live serve would have taken
 * the request over its IPC socket before this process could open the brain, commands/sync-delegate.ts).
 */
export async function runSyncTrigger(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) return printSyncTriggerHelp();
  const sourceIdArg = args.find((a, i) => args[i - 1] === '--source') ?? null;
  if (!sourceIdArg) {
    console.error('Error: --source <id> is required');
    console.error(USAGE);
    process.exit(2);
  }
  const priorityArg = args.find((a, i) => args[i - 1] === '--priority') ?? 'high';
  const priorityMap: Record<string, number> = { high: -10, normal: 0, low: 5 };
  const priority = priorityMap[priorityArg];
  if (priority === undefined) {
    console.error(`Invalid --priority value: "${priorityArg}". Must be high|normal|low.`);
    process.exit(2);
  }
  const json = args.includes('--json');
  const { recordTriggerMarker } = await import('../../core/notifier/nudge.ts');
  const recorded = await recordTriggerMarker(engine, { sourceId: sourceIdArg, requestedBy: 'sync_trigger' });
  if (!recorded) {
    console.error(`Source "${sourceIdArg}" not found. List with: gbrain sources list`);
    process.exit(1);
  }
  const { marker, managed } = recorded;
  const base = { source_id: marker.source_id, intent: marker.intent, wanted_head: marker.wanted_head, marker_generation: marker.generation };
  if (engine.kind === 'pglite') return finishTrigger({ action: 'no_resident', ...base }, json);
  const { MinionQueue } = await import('../../core/minions/queue.ts');
  const job = await new MinionQueue(engine).add('sync', {
    sourceId: marker.source_id,
    ...(managed || marker.intent === 'freshness' ? { noPull: true } : {}),
    noExtract: false,
    auto_embed_backfill: true,
    embed_reason: 'sync_trigger',
  }, { priority, maxPending: 1 });
  const { attachMarkerJob } = await import('../../core/notifier/store.ts');
  await attachMarkerJob(engine, marker.source_id, marker.intent, marker.generation, job.id);
  await finishTrigger({ action: job.coalesced ? 'coalesced' : 'queued', ...base, job_id: job.id }, json);
}

/** Prints the outcome; no_resident also carries the error envelope (--json) and exits 3 with the fix. */
export async function finishTrigger(o: TriggerOutcome, json: boolean): Promise<void> {
  if (o.action !== 'no_resident') return printTriggerOutcome(o, json);
  if (json) {
    const { opError } = await import('../../core/ops/contract.ts');
    const error = opError('no_resident', `No resident process syncs source ${o.source_id}; the request is recorded and waits for one.`,
      `Run gbrain sync --source ${o.source_id} --no-pull now, or start gbrain serve; the recorded request is drained by the next resident.`,
      { fix: { argv: ['gbrain', 'sync', '--source', o.source_id, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Syncs the checkout HEAD now; the recorded marker clears once last_commit reaches it.' } });
    console.log(JSON.stringify({ ...o, error: error.toJSON() }));
  } else printTriggerOutcome(o, false);
  const { setCliExitVerdict } = await import('../../core/cli-force-exit.ts');
  setCliExitVerdict(3);
}
