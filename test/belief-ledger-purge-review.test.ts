/**
 * Regression probes for the lane A findings of the #6806 review (purge,
 * redaction, mirror). Each was reproduced failing on the reviewed code; each
 * runs on PGLite and on Postgres when DATABASE_URL is set.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { __setBeliefEmitterFaultForTests } from '../src/core/belief/append.ts';
import { withBeliefBatch } from '../src/core/belief/ledger.ts';
import { redactCarryingFields, registerLiveCarriers } from '../src/core/belief/purge.ts';
import { REDACTION_MARKER } from '../src/core/belief/keys.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { operations } from '../src/core/operations.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
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
    test('#6: the purge passes never substring-scan in SQL; 200 claims cost one keyset pass over the carrying fields', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: [{ claim: 'Acme sells widgets', context: `notes say ${X}` }, 'Acme has two offices'] }));
        const claims = [X, ...Array.from({ length: 199 }, (_, i) => `needle claim number ${i} about something`)];
        const statements: Array<{ sql: string; params: unknown[] }> = [];
        const out = await b.engine.transaction(async tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
          const spy = new Proxy(tx, { get: (t, k) => k === 'executeRaw' ? (sql: string, params: unknown[] = []) => { statements.push({ sql, params }); return t.executeRaw(sql, params); }
            : (t as any)[k] });
          const request = randomUUID();
          return { redacted: (await redactCarryingFields(spy, { sourceId: b.sourceId, request, claims })).map(f => f.field),
            live: (await registerLiveCarriers(spy, { sourceId: b.sourceId, request, claims })).map(f => f.field) };
        }, TEST_WRITE_ATTRIBUTION));
        report({ ...out, substring: statements.filter(st => /strpos\(/i.test(st.sql)).length,
          claimParams: statements.filter(st => JSON.stringify(st.params).includes('needle claim')).length });
      }));
      expect(r).toEqual({ redacted: ['context'], live: ['context'], substring: 0, claimParams: 0 });
    }, 240_000);

    test('#11: a claim whose case folds differently in SQL and JS (Turkish dotted I, Greek sigma) is still redacted and registered', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const slug = 'companies/acme-example';
        const claims = ['İstanbul office code is 4417', 'ΟΔΟΣ ΣΟΦΙΑΣ door code 9921'];
        for (const [i, claim] of claims.entries()) await b.put(`vault/code-${i}-example`, beliefPage({ facts: [claim] }));
        await b.put(slug, beliefPage({ prose: 'Acme.' }));
        await b.put(slug, beliefPage({ facts: [{ claim: 'Acme sells widgets', context: `memo: ${claims[0]}` }, { claim: 'Acme has two offices', context: `memo: ${claims[1]}` }] }));
        for (const claim of claims) await purgeFact(b, claim);
        report({ leaks: quoting(await b.events(), claims[0]!).concat(quoting(await b.events(), claims[1]!)),
          register: (await b.engine.executeRaw<{ n: number }>('SELECT count(DISTINCT subject_key)::int AS n FROM belief_redactions WHERE source_id = $1', [b.sourceId]))[0]!.n });
      }));
      expect(r).toEqual({ leaks: [], register: 2 });
    }, 240_000);

    test('#12: the receipt reports another subject\'s recorded value that still quotes the claim, naming its key', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const slug = 'companies/acme-example';
        await b.put(slug, beliefPage({ facts: ['Acme sells widgets'] }));
        await b.put(slug, beliefPage({ facts: [`${X} for the back office`, 'Acme sells widgets'] }));
        await b.put(slug, beliefPage({ facts: [X, 'Acme sells widgets'] }));
        const result = await purgeFact(b, X);
        const store = (result.stores as Array<Record<string, any>>).find(st => st.store === 'belief_events')!;
        const carrier = (await b.events()).find(e => e.value?.fact === `${X} for the back office`)!;
        report({ status: store.status, items: store.items, key: carrier.subject_key });
      }));
      expect(r.status).toBe('out_of_scope');
      expect(r.items).toEqual([`fact@${r.key}`]);
    }, 240_000);
    test('#14: a hard delete (purge, managed and unmanaged retention) records every cascaded inbound link as link.retracted in its own stream', async () => {
      const run = (managed: boolean, remove: (b: BeliefBrain, slug: string) => Promise<unknown>) => collect<string[]>(report => brain(async b => {
        await b.put('people/target-example', beliefPage({ type: 'person', title: 'Target Example' }));
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme sells widgets'], links: ['people/target-example'] }));
        const mark = await b.lastId();
        await remove(b, 'people/target-example');
        report((await b.events(mark)).filter(e => e.subject_kind === 'link').map(e => `${e.slug}:${e.event_type}`));
      }, managed));
      const expire = async (b: BeliefBrain, slug: string) => {
        const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId });
        await deleteOp.handler(b.ctx, { slug, expected_revision: snapshot!.revision, request_id: randomUUID() });
        await purgeDeletedPagesCoordinated(b.engine, 0);
      };
      expect({ purge: await run(true, purgePage), managedRetention: await run(true, expire), unmanagedRetention: await run(false, expire) }).toEqual({
        purge: ['companies/acme-example:link.retracted'], managedRetention: ['companies/acme-example:link.retracted'], unmanagedRetention: ['companies/acme-example:link.retracted'] });
    }, 240_000);

    test('#26: a retention removal does not take the source exclusively; an owner purge does', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const exclusive: string[] = [];
        const proto = Object.getPrototypeOf(b.engine) as { executeRaw: (sql: string, ...rest: unknown[]) => Promise<unknown> };
        const original = proto.executeRaw;
        proto.executeRaw = function (this: unknown, sql: string, ...rest: unknown[]) {
          if (/^SELECT id FROM sources WHERE id=\$1 FOR UPDATE$/.test(sql)) exclusive.push(sql);
          return original.call(this, sql, ...rest);
        };
        try {
          await b.put('notes/old-example', beliefPage({ prose: 'Old.' }));
          await b.put('notes/vault-example', beliefPage({ prose: 'Vault.' }));
          const snapshot = await b.engine.readPageSnapshot('notes/old-example', { sourceId: b.sourceId });
          await deleteOp.handler(b.ctx, { slug: 'notes/old-example', expected_revision: snapshot!.revision, request_id: randomUUID() });
          exclusive.length = 0;
          await purgeDeletedPagesCoordinated(b.engine, 0);
          const retention = exclusive.length;
          exclusive.length = 0;
          await purgePage(b, 'notes/vault-example');
          report({ retention, purge: exclusive.length });
        } finally { proto.executeRaw = original; }
      }));
      expect(r).toEqual({ retention: 0, purge: 1 });
    }, 240_000);
  });
}
