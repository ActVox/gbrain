/**
 * A repair item's request id named its page and revision, not the item. Two items of one run that write the same page
 * (two facts of one fence) at the same revision got one id: while the first write was still pending, the second item
 * reused its id for a different write, and admission refused it as idempotency_conflict, which an approved apply
 * (--expect) does not continue past (#7436). Each item now gets its own id.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { repairRequestId, resolveRepairScope, runRepair, type RepairHandler, type RepairItem } from '../src/core/repair/core.ts';
import { repairSpec } from '../src/core/repair/registry.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-repair-per-item-'));
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(dataDir, { recursive: true, force: true }); });

const ctxFor = (sourceId: string, writeWaitMs?: number) => ({ engine, sourceId, remote: false as const, config: { engine: 'pglite', embedding_disabled: true },
  dryRun: false, logger: quiet, ...(writeWaitMs === undefined ? {} : { writeWaitMs }) }) as never;
const page = (body: string) => `---\ntype: note\ntitle: Example\n---\n${body}\n`;

describe('repair request ids are per item', () => {
  test('a second item writing the same page while the first is pending is admitted under its own id, not refused as idempotency_conflict', async () => {
    const dir = mkdtempSync(join(dataDir, 'case-'));
    const source = `repair-${randomUUID().slice(0, 8)}`;
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      try {
        const root = join(dir, source); mkdirSync(root);
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
        await claimWorktree(engine, source, root);
        await submitPageMutation(ctxFor(source), { operation: 'put_page', params: { slug: 'notes/a', content: page('Fact one. Fact two.'), request_id: randomUUID() } });
        const ids: string[] = [];
        const item = (id: number): RepairItem => ({ cursor: { phase: 0, id }, source_id: source, slug: 'notes/a', chars: 1, action: `mark fact ${id}` });
        const handler: RepairHandler = { kind: 'visibility', embeds: false,
          async plan(_engine, _scope, after) { return { items: [0, 1, 2].map(item).filter(i => !after || i.cursor.id > after.id), residuals: {}, preview_hash: 'h' }; },
          async apply(ctx, it) {
            const snapshot = (await engine.readPageSnapshot('notes/a', { sourceId: source }))!;
            const request_id = await repairRequestId(ctx, 'visibility', it, snapshot.revision);
            ids.push(request_id);
            await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', source_id: source, expected_revision: snapshot.revision,
              content: page(`Fact one. Fact two. Marked ${it.cursor.id}.`), request_id } });
            return true;
          } };
        let held = true;
        installFaultHook(async point => { if (point === 'consumer:prepared' && held) { held = false; await new Promise(resolve => setTimeout(resolve, 1_500)); } });
        const scope = await resolveRepairScope(engine);
        const result = await runRepair(ctxFor(source, 1_000), handler, scope, { apply: true, spec: repairSpec('visibility'), embed: false, expect: 'h',
          publicationOwner: async () => ({ alive: true, owner: 'this process' }) });
        expect(new Set(ids).size).toBe(3);
        expect(result.failed).toEqual([]);
        expect(result.stopped).toBeUndefined();
        expect(result.applied + result.skipped).toBe(3);
      } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
    });
  }, 120_000);
});
