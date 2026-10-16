/**
 * Regression probes for the lane A findings of the #6806 review (purge,
 * redaction, mirror). Each was reproduced failing on the reviewed code; each
 * runs on PGLite and on Postgres when DATABASE_URL is set.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { __setBeliefEmitterFaultForTests } from '../src/core/belief/append.ts';
import { withBeliefBatch } from '../src/core/belief/ledger.ts';
import { REDACTION_MARKER } from '../src/core/belief/keys.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { operations } from '../src/core/operations.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain, type BeliefEvent } from './helpers/belief-ledger.ts';

afterEach(() => { __setBeliefEmitterFaultForTests(null); });

const X = 'Door code is 4417';
const purgeOp = operations.find(o => o.name === 'purge_fact')!;
const deleteOp = operations.find(o => o.name === 'delete_page')!;

async function purgeFact(b: BeliefBrain, claim: string): Promise<Record<string, any>> {
  const [row] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL ORDER BY id LIMIT 1', [b.sourceId, claim]);
  const dry = await purgeOp.handler(b.ctx, { id: Number(row!.id), dry_run: true }) as Record<string, any>;
  return await purgeOp.handler(b.ctx, { id: Number(row!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
}

async function purgePage(b: BeliefBrain, slug: string): Promise<Record<string, any>> {
  const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId, includeDeleted: true });
  return await deleteOp.handler(b.ctx, { slug, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() }) as Record<string, any>;
}

const requestOf = async (b: BeliefBrain, clientRequestId: string) =>
  (await b.engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id = $1::uuid', [clientRequestId]))[0]!.id;

const quoting = (events: BeliefEvent[], claim: string) => events.filter(e => JSON.stringify(e.value ?? {}).toLowerCase().includes(claim.toLowerCase())).map(e => [e.id, e.event_type, e.origin]);

/** Runs a brain scenario to completion (teardown included) and returns what it reported. */
async function collect<T>(run: (report: (value: T) => void) => Promise<void>): Promise<T> {
  let out: T | undefined;
  await run(value => { out = value; });
  return out as T;
}

/** An owner-tier, trusted local write in its own batch: the shape of sync, reconcile and file repair (or, with ownerEdit, an explicit owner edit). */
const ownerTierWrite = (b: BeliefBrain, slug: string, op: string, sql: string, ownerEdit = false) => b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
  await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
  await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [slug], op, remote: false, ...(ownerEdit ? { ownerEdit } : {}) }, () => tx.executeRaw(sql, [b.sourceId]));
}, { ...TEST_WRITE_ATTRIBUTION, trust: { tier: 'operator_curated', origin: { channel: op } } }));

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger purge review (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, managed = true) => beliefBrain(run, { managed, databaseUrl: engineCase.databaseUrl });

    test('#1: sync, reconcile and file repair at owner tier never release a redaction; an explicit owner edit releases only a different value', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const slug = 'companies/acme-example';
        await b.put(slug, beliefPage({ facts: [X, { claim: 'Acme sells widgets', context: `notes say ${X}` }] }));
        const request = await requestOf(b, String((await purgeFact(b, X)).request_id));
        const ctx = async (fn: () => Promise<unknown>) => { const mark = await b.lastId(); await fn(); return (await b.events(mark)).filter(e => e.event_type.startsWith('fact.')).map(e => e.value?.context); };
        const fact = `source_id = $1 AND fact = 'Acme sells widgets' AND expired_at IS NULL`;
        const out: Record<string, unknown> = { request };
        for (const op of ['canonical_reconcile', 'managed_file_import', 'managed_file_repair', 'trust_release', 'trust_accept'])
          out[op] = await ctx(() => ownerTierWrite(b, slug, op, `UPDATE facts SET confidence = confidence * 0.9 WHERE ${fact}`));
        out.unchangedOwnerEdit = await ctx(() => ownerTierWrite(b, slug, 'owner_edit', `UPDATE facts SET confidence = 0.4 WHERE ${fact}`, true));
        out.syncSetsField = await ctx(() => ownerTierWrite(b, slug, 'managed_file_import', `UPDATE facts SET context = 'sync rewrote it' WHERE ${fact}`));
        out.ownerEdit = await ctx(() => ownerTierWrite(b, slug, 'owner_edit', `UPDATE facts SET context = 'owner rewrote it' WHERE ${fact}`, true));
        out.released = (await b.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM belief_redactions WHERE source_id = $1 AND released_hash IS NOT NULL', [b.sourceId]))[0]!.n;
        report(out);
      }));
      const m = REDACTION_MARKER(r.request as string);
      expect(r).toEqual({ request: r.request, canonical_reconcile: [m], managed_file_import: [m], managed_file_repair: [m], trust_release: [m], trust_accept: [m],
        unchangedOwnerEdit: [m], syncSetsField: [m], ownerEdit: ['owner rewrote it'], released: 1 });
    }, 240_000);

    test('#2: the first page purge in a source writes no purged text into the ledger', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const claim = 'Vault code is 7731';
        await submitRememberMutation(b.ctx, { fact: 'Secret example owns a vault', entity: 'people/secret-example', provenance: 'probe' });
        await b.put('people/secret-example', beliefPage({ type: 'person', title: 'Secret Example', facts: [claim] }));
        await b.engine.executeRaw(`UPDATE facts SET context = $2 WHERE source_id = $1 AND source_markdown_slug IS NULL AND entity_slug = 'people/secret-example'`,
          [b.sourceId, `per memo: ${claim.toLowerCase()}`]);
        const mark = await b.lastId();
        const result = await purgePage(b, 'people/secret-example');
        report({ status: result.status, leaks: quoting(await b.events(), claim), published: (await b.events(mark)).filter(e => e.subject_kind === 'fact').map(e => [e.event_type, e.redacted_fields]) });
      }, false));
      expect(r.status).toBe('purged');
      expect(r.leaks).toEqual([]);
    }, 240_000);
  });
}
