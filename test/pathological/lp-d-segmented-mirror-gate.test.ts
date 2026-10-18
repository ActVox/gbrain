/**
 * LPH (d) part 2: no version 2 withdrawal-mirror record while a gbrain that cannot read one may claim it.
 *
 * 1. Protects: while the segmented-storage writer gate sees a writer below SEGMENTED_WRITER_FLOOR in its 7-day window (an
 *    import run of v0.60.290.0, which reads a version 2 record's `after: null` as a version 1 record and wedges the
 *    worktree), a withdrawal on a segmented, file-backed page commits but its mirror writes no recovery record and stages
 *    nothing: it refuses `segmented_mirror_writer_gate` (fix.next `tell_user_to_run` `gbrain upgrade`, naming the host),
 *    retries, and parks after PARK_AFTER_FAILURES attempts like any failed mirror, so writes on the worktree are not held;
 *    the canonical file keeps the withdrawn row meanwhile. The gate is read from its TTL cache, not once per attempt. Once
 *    the older writer is outside the window, the parked mirror runs again by itself and the file loses the row.
 * 2. Fails when: the mirror stages a version 2 record while the gate holds (master), the hold never parks or parks without
 *    its code, the gate is read per attempt, or the parked mirror never resumes after the gate clears.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. The older writer is an ingest_log row stamped v0.60.290.0 with the
 *    segment-reader mark, as test/large-pages/segmented-switch.test.ts seeds the doctor segmented_storage cases.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cliRenderContext, renderAction } from '../../src/core/agent-output.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { SEGMENTED_WRITER_FLOOR } from '../../src/core/page-body/writer-floor.ts';
import { _resetSegmentedWriterGateForTests, segmentedWriterGateWork } from '../../src/core/page-body/limits.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { PARK_AFTER_FAILURES } from '../../src/core/persistence/effect-model.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { _resetGatedMirrorResumeForTests, assertSegmentedMirrorGate } from '../../src/core/persistence/segmented-mirror-gate.ts';
import { compareWriterVersions } from '../../src/core/persistence/writer-versions.ts';
import { openTwinBrain, type TwinBrain } from '../helpers/segmented-twins.ts';
import { exported, fileOf, settle } from '../helpers/segmented-withdrawal.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { withEnv } from '../helpers/with-env.ts';

const SEGMENTED = 'people/sei-example';
const CLAIM = 'Twin Example vault code is 5510';
const KEPT = 'Twin Example adopted a narwhalbot';
const OLDER = '0.60.290.0';
const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;

for (const kind of testBackends()) {
  describe(kind + ': a segmented mirror holds while an older gbrain could claim its recovery record', () => {
    let brain: TwinBrain;
    const oldHost = randomUUID();

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [], async seed => { await seed.setSwitch(true); await seed.put(SEGMENTED, 1_100_000); });
      brain.setChatReply(JSON.stringify({ facts: [CLAIM, KEPT].map(fact => ({ fact, kind: 'fact', entity: SEGMENTED, confidence: 1, notability: 'high' })) }));
      expect(await brain.call('extract_facts', { turn_text: 'Synthetic meeting record. ' + CLAIM + '. ' + KEPT + '.', visibility: 'world', valid_from: '2026-10-15T00:00:00Z' }, SEGMENTED))
        .toMatchObject({ inserted: 2 });
      expect(await brain.storageOf(SEGMENTED)).toBe('segmented');
      await settle(brain, kind);
    }, 600_000);

    afterAll(() => { installFaultHook(undefined); return brain.close(); }, 120_000);

    test('the mirror writes no version 2 record, parks with segmented_mirror_writer_gate, and resumes once the older writer ages out', async () => {
      expect(compareWriterVersions(OLDER, SEGMENTED_WRITER_FLOOR)).toBeLessThan(0);
      await brain.engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary, writer_version, writer_host_id, writer_segment_reader, created_at)
        VALUES ($1, 'import', 'lp-d-older-writer', '[]'::jsonb, 'run', $2, $3::uuid, true, now() - interval '1 hour')`, [brain.sourceId, OLDER, oldHost]);
      _resetSegmentedWriterGateForTests();
      _resetGatedMirrorResumeForTests();
      const file = fileOf(brain, SEGMENTED);
      const before = readFileSync(file);
      expect(before.toString('utf8')).toContain(CLAIM);

      // Every recovery record the mirror reserves passes the before_stage seam; none may be reserved while the gate holds.
      const reserved: unknown[] = [];
      installFaultHook(async (point, detail) => {
        if (point !== 'effect_recovery:before_stage') return;
        const [row] = await brain.engine.executeRaw<{ recovery: unknown }>('SELECT recovery FROM persistence_effects WHERE id=$1', [detail.effectId]);
        reserved.push(json(row?.recovery));
      });
      const reads = segmentedWriterGateWork.reads;
      const [fact] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3', [brain.sourceId, SEGMENTED, CLAIM]);
      const dry = await brain.call('purge_fact', { id: Number(fact!.id), dry_run: true }, SEGMENTED);
      const requestId = randomUUID();
      expect((await brain.call('purge_fact', { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: requestId }, SEGMENTED)).state).toBe('committed');
      const mirror = async () => (await brain.engine.executeRaw<{ state: string; error_code: string | null; recovery: unknown; data: any; attempts: number }>(
        `SELECT e.state, e.error_code, e.recovery, e.data, e.attempts FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
          WHERE r.request_id=$1::uuid AND e.kind='withdrawal-mirror'`, [requestId]))[0]!;
      const pass = () => withEnv(brain.env(), async () => {
        await brain.engine.executeRaw(`UPDATE persistence_effects SET next_attempt_at=now() WHERE source_id=$1 AND state='queued'`, [brain.sourceId]);
        await runPersistenceEffects(brain.engine, { engine: kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 });
      });
      try {
        const recordsSeen: unknown[] = [];
        await waitFor(async () => {
          await pass();
          const row = await mirror();
          if (row.recovery) recordsSeen.push(json(row.recovery));
          return row.state === 'failed' || row.state === 'committed';
        }, { timeoutMs: 120_000, intervalMs: 100, label: 'the mirror parked or committed' });
        const held = await mirror();
        // No record was reserved or seen, nothing was staged, and the file still holds the purged claim.
        expect(reserved).toEqual([]);
        expect(recordsSeen).toEqual([]);
        expect(held.recovery).toBeNull();
        expect(readFileSync(file).equals(before)).toBe(true);
        // Parked like any failed mirror after its attempts, with the gate's code on the target.
        expect(held.state).toBe('failed');
        expect(held.error_code).toBe('targets_parked');
        expect(json(held.data).parked).toEqual([{ slug: SEGMENTED, error_code: 'segmented_mirror_writer_gate' }]);
        expect(held.attempts).toBeGreaterThanOrEqual(PARK_AFTER_FAILURES);
        // The gate was read from its cache: at most once for all of those attempts.
        expect(segmentedWriterGateWork.reads - reads).toBeLessThanOrEqual(1);
        // Its refusal names the older host and tells the user to upgrade it.
        const refusal = await assertSegmentedMirrorGate(brain.engine, { source_id: brain.sourceId } as never, SEGMENTED).then(() => null, error => error);
        expect(refusal).toBeInstanceOf(OperationError);
        expect((refusal as OperationError).code).toBe('segmented_mirror_writer_gate');
        expect((refusal as OperationError).suggestion).toContain(oldHost);
        expect((refusal as OperationError).fix?.argv).toEqual(['gbrain', 'upgrade']);
        expect((refusal as OperationError).fix?.user_message).toContain(oldHost);
        expect(renderAction((refusal as OperationError).fix!, cliRenderContext()).next).toBe('tell_user_to_run');

        // The older writer ages out of the window: the parked mirror runs again by itself and the file loses the row.
        await brain.engine.executeRaw(`UPDATE ingest_log SET created_at=now() - interval '8 days' WHERE source_ref='lp-d-older-writer'`);
        _resetSegmentedWriterGateForTests();
        _resetGatedMirrorResumeForTests();
        await waitFor(async () => { await pass(); return (await mirror()).state === 'committed'; }, { timeoutMs: 120_000, intervalMs: 100, label: 'the mirror resumed and committed' });
        await settle(brain, kind);
        const after = readFileSync(file);
        expect(after.toString('utf8')).not.toContain(CLAIM);
        expect(after.toString('utf8')).toContain(KEPT);
        expect(after.equals(await exported(brain, SEGMENTED))).toBe(true);
        expect(reserved).toHaveLength(1);
        expect(reserved[0]).toMatchObject({ version: 2, after: null });
      } finally { installFaultHook(undefined); }
    }, 600_000);
  });
}
