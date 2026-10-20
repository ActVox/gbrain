/**
 * GBRA-133 PR 2b (search during a sync): a pass's batch build (sync-pass-run.ts `batchEntries`) counted each import
 * winner's same-blob twins by filtering every new origin, once per winner: quadratic in a first sync's new files (at 10k,
 * about 10^8 compares and a 1.1-1.4 s stretch that held every concurrent search). Twins are counted once per blob now,
 * and a moved page is looked up by blob instead of by a scan of the leaving pages.
 *
 * Forced probe: a first sync of ${PATHS} new files sharing one blob (each has every other as a twin). The stretch from the
 * batch build's start to the first freeze is timed on the thread's CPU; the run is aborted there, so nothing is imported.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { watchLoopLag } from './helpers/cpu-time.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const PATHS = 8_000;
const MAX_LAG_MS = 100;

const git = (root: string, args: string[], input?: string) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 26 }).trim();
const setup = ({ root }: { root: string }) => {
  git(root, ['init', '-q']);
  const blob = git(root, ['hash-object', '-w', '--stdin'], '---\ntitle: Note\n---\n\nSynthetic note.\n');
  const lines: string[] = [];
  for (let i = 0; i < PATHS; i++) lines.push(`100644 ${blob}\tnotes/d${i % 100}/note-${i}.md`);
  git(root, ['update-index', '--add', '--index-info'], lines.join('\n') + '\n');
  git(root, ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'many notes']);
};

afterEach(() => installFaultHook(undefined));

describe('GBRA-133 PR 2b: a first sync builds its batch in linear time', () => {
  test(`the batch build of ${PATHS} new same-blob files never blocks a timer for ${MAX_LAG_MS} ms`, () => managedBrain(async ({ engine }) => {
    let lag: ReturnType<typeof watchLoopLag> | undefined, maxLag: number | undefined;
    const stop = new AbortController();
    installFaultHook(async point => {
      if (point === 'sync:batch_entries' && !lag) lag = watchLoopLag();
      if (point === 'sync:after_freeze' && lag && maxLag === undefined) { maxLag = lag.stop().maxLag; stop.abort(); }
    });
    await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, signal: stop.signal }).catch(() => undefined);
    installFaultHook(undefined);
    if (lag && maxLag === undefined) lag.stop();
    expect(maxLag).toBeDefined();
    expect(Math.round(maxLag!)).toBeLessThan(MAX_LAG_MS);
  }, { setup }), 300_000);
});
