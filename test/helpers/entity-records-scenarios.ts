/**
 * Entity reference fields and the record view (F1), run on PGLite
 * (test/entity-records.test.ts) and Postgres (test/e2e/entity-records-postgres.test.ts).
 *
 * World: two accounts with identity siblings (a CRM record and an account
 * sheet per account), dated contracts and amendments referencing them, an
 * amendment that amends a contract (a terms-start `since` on the link), a
 * draft amendment with `status`, a whole-record replacement (`supersedes`),
 * and hidden referrers: a private page, a quarantined page, a below-floor page
 * and an amends date whose only evidence is private.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { loadSourcePack } from '../../src/core/mentions/policy.ts';
import { readReferrerGroups, readReferrerPage, readTargetReferences, encodeCursor } from '../../src/core/mentions/referrers.ts';
import { __setReferencesTimingForTests } from '../../src/core/verbs/entity-references.ts';
import { assembleContextPack } from '../../src/core/context/turn-context.ts';

const SRC = 'default';

async function put(engine: BrainEngine, slug: string, type: string, title: string, opts: { date?: string; fm?: Record<string, unknown>; body?: string } = {}) {
  await engine.putPage(slug, { type: type as never, title, compiled_truth: opts.body ?? `${title}.`, timeline: '', frontmatter: opts.fm ?? {} }, { sourceId: SRC });
  if (opts.date) await engine.executeRaw(`UPDATE pages SET effective_date = $2::timestamptz, effective_date_source = 'date' WHERE source_id = $1 AND slug = $3`, [SRC, opts.date, slug]);
}

async function link(engine: BrainEngine, from: string, to: string, type = '', origin: string | null = from) {
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type, link_source, origin_page_id)
     SELECT f.id, t.id, $3, 'markdown', o.id FROM pages f JOIN pages t ON t.slug = $2 AND t.source_id = $4
       LEFT JOIN pages o ON o.slug = $5 AND o.source_id = $4
      WHERE f.slug = $1 AND f.source_id = $4`, [from, to, type, SRC, origin]);
}

async function since(engine: BrainEngine, from: string, to: string, scope: 'all' | 'world', date: string) {
  await engine.executeRaw(
    `INSERT INTO link_relationships (from_page_id, to_page_id, link_type, scope, source_id, semantics, valid_ranges, status_now, first_start, last_start, evidence_hash)
     SELECT f.id, t.id, 'amends', $3, $4, 'event', datemultirange(daterange($5::date, NULL)), 'event', $5::date, $5::date, 'test'
       FROM pages f JOIN pages t ON t.slug = $2 AND t.source_id = $4 WHERE f.slug = $1 AND f.source_id = $4`, [from, to, scope, SRC, date]);
}

export async function resetRecordsWorld(engine: BrainEngine): Promise<void> {
  for (const t of ['link_relationships', 'links', 'page_aliases', 'pages']) await engine.executeRaw(`DELETE FROM ${t}`);
  for (const k of ['entity.names_references', 'entity.record_types', 'entity_identity.union', 'mentions.sibling_merge']) await engine.unsetConfig(k);
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
}

/** Seeds the world; returns nothing (slugs are fixed). */
export async function seedRecordsWorld(engine: BrainEngine): Promise<void> {
  await resetRecordsWorld(engine);
  await put(engine, 'crm/acme-example', 'account', 'CRM record: Acme Example');
  await put(engine, 'accounts/acme-example', 'account', 'Account sheet: Acme Example');
  await put(engine, 'crm/widget-example', 'account', 'CRM record: Widget Example');
  // Records about Acme (type `contract`: stored, not a pack type; `deal` is a pack type with alias `term-sheet`).
  await put(engine, 'contracts/acme-msa', 'contract', 'Acme MSA', { date: '2025-01-10T00:00:00Z' });
  await put(engine, 'contracts/acme-amend-1', 'contract', 'Acme amendment 1', { date: '2025-06-01T00:00:00Z' });
  await put(engine, 'contracts/acme-amend-2-draft', 'contract', 'Acme amendment 2 (draft)', { date: '2025-09-01T00:00:00Z', fm: { status: 'draft' } });
  await put(engine, 'contracts/acme-msa-v2', 'contract', 'Acme MSA v2', { date: '2025-11-01T00:00:00Z' });
  await put(engine, 'deals/acme-term-sheet', 'term-sheet', 'Acme term sheet', { date: '2024-12-01T00:00:00Z' });
  await put(engine, 'notes/acme-call', 'note', 'Call with Acme', { date: '2025-10-01T00:00:00Z' });
  for (const s of ['contracts/acme-msa', 'contracts/acme-amend-1', 'contracts/acme-amend-2-draft', 'contracts/acme-msa-v2', 'deals/acme-term-sheet', 'notes/acme-call']) {
    await link(engine, s, 'crm/acme-example');
  }
  await link(engine, 'contracts/acme-amend-1', 'contracts/acme-msa', 'amends');
  await since(engine, 'contracts/acme-amend-1', 'contracts/acme-msa', 'all', '2025-07-01');
  await since(engine, 'contracts/acme-amend-1', 'contracts/acme-msa', 'world', '2025-07-01');
  await link(engine, 'contracts/acme-amend-2-draft', 'contracts/acme-msa', 'amends');
  await link(engine, 'contracts/acme-msa-v2', 'contracts/acme-msa', 'supersedes');
  // Sibling-only record: a contract that names only the account sheet.
  await put(engine, 'contracts/acme-sheet-order', 'contract', 'Acme order form', { date: '2025-03-01T00:00:00Z' });
  await link(engine, 'contracts/acme-sheet-order', 'accounts/acme-example');
  // Hidden referrers of Acme.
  await put(engine, 'contracts/acme-private', 'contract', 'Acme private side letter', { date: '2025-12-01T00:00:00Z', fm: { visibility: 'private' } });
  await link(engine, 'contracts/acme-private', 'crm/acme-example');
  await put(engine, 'contracts/acme-quarantined', 'contract', 'Acme junk', { date: '2025-12-02T00:00:00Z',
    fm: { quarantine: { reason: 'junk_pattern', detail: 'test', assessed_at: '2026-10-07T00:00:00Z' } } });
  await link(engine, 'contracts/acme-quarantined', 'crm/acme-example');
  await put(engine, 'contracts/acme-low-trust', 'contract', 'Acme scraped copy', { date: '2025-12-03T00:00:00Z' });
  await engine.executeRaw(`UPDATE pages SET trust_tier = 'external_untrusted' WHERE slug = 'contracts/acme-low-trust'`);
  await link(engine, 'contracts/acme-low-trust', 'crm/acme-example');
  // A dated amends statement whose only evidence is private (no world-scope relationship row).
  await put(engine, 'contracts/acme-amend-3', 'contract', 'Acme amendment 3', { date: '2025-10-15T00:00:00Z' });
  await link(engine, 'contracts/acme-amend-3', 'crm/acme-example');
  await link(engine, 'contracts/acme-amend-3', 'contracts/acme-msa', 'amends');
  await since(engine, 'contracts/acme-amend-3', 'contracts/acme-msa', 'all', '2026-01-01');
  // An amends link to a private target is hidden from untrusted callers.
  await link(engine, 'contracts/acme-amend-3', 'contracts/acme-private', 'amends');
  // Widget: seven contracts (more than the per-page cap).
  for (let i = 1; i <= 7; i++) {
    await put(engine, `contracts/widget-${i}`, 'contract', `Widget contract ${i}`, { date: `2025-0${i}-15T00:00:00Z` });
    await link(engine, `contracts/widget-${i}`, 'crm/widget-example');
  }
}

export async function call(engine: BrainEngine, tool: string, args: Record<string, unknown>, remote = true) {
  const r = await dispatchToolCall(engine, tool, args, { remote, sourceId: SRC } as never);
  const body = JSON.parse(r.content[0]!.text!) as Record<string, any>;
  const notices = r.content.slice(1).map(c => ({ code: /\[gbrain notice ([a-z_]+)/.exec(c.text ?? '')?.[1] ?? '', text: c.text ?? '' }));
  return { isError: r.isError === true, body, notices };
}

const slugsOf = (g: { rows: Array<{ slug: string }> }) => g.rows.map(r => r.slug);
const ROW_KEYS = new Set(['slug', 'title', 'date', 'date_source', 'page_status', 'amends', 'supersedes']);

/** Default config: every found names row and sibling carries the count and a card `next`; no records. */
export async function namesRowDefaults(engine: BrainEngine): Promise<void> {
  await seedRecordsWorld(engine);
  const { body } = await call(engine, 'entity', { names: ['CRM record: Acme Example', 'CRM record: Widget Example', 'Nobody Example'] });
  const [acme, widget, nobody] = body.results;
  const card = (await call(engine, 'entity', { name: 'crm/acme-example' })).body.card;
  expect(acme.referenced_by_count).toBe(card.referenced_by_count);
  expect(acme.referenced_by_count).toBe(8);
  expect(acme.next).toEqual({ tool: 'entity', arguments: { name: 'crm/acme-example' } });
  expect(widget.referenced_by_count).toBe(7);
  expect(acme.records).toBeUndefined();
  expect(nobody).toEqual({ name: 'Nobody Example', found: false });
  expect(card.records).toBeUndefined();
  await engine.setConfig('entity.names_references', 'false');
  const off = (await call(engine, 'entity', { names: ['CRM record: Acme Example'] })).body.results[0];
  expect(off.referenced_by_count).toBeUndefined();
  expect(off.next).toBeUndefined();
}

/** Enrolled types: grouped, newest page date first, the exact sparse row, metadata, caps and exact-remainder continuations. */
export async function recordsOnNamesRows(engine: BrainEngine): Promise<void> {
  await seedRecordsWorld(engine);
  await engine.setConfig('entity.record_types', 'contract,term-sheet');
  const local = (await call(engine, 'entity', { names: ['CRM record: Acme Example', 'CRM record: Widget Example'] }, false)).body.results;
  const [acme, widget] = (await call(engine, 'entity', { names: ['CRM record: Acme Example', 'CRM record: Widget Example'] })).body.results;
  expect(acme.records.map((g: { canonical_type: string }) => g.canonical_type)).toEqual(['contract', 'deal']);
  const contracts = acme.records[0];
  // The entity verb applies no trust floor (like referenced_by): the low-trust copy is listed, labeled by nothing but its date.
  expect(contracts.total).toBe(6);
  expect(slugsOf(contracts)).toEqual(['contracts/acme-low-trust', 'contracts/acme-msa-v2', 'contracts/acme-amend-3', 'contracts/acme-amend-2-draft', 'contracts/acme-amend-1']);
  expect(contracts).toMatchObject({ capped: 'per_page' });
  expect((await call(engine, 'get_backlinks', contracts.next.arguments)).body.rows.map((r: { slug: string }) => r.slug)).toEqual(['contracts/acme-msa']);
  for (const row of contracts.rows) for (const k of Object.keys(row)) expect(ROW_KEYS.has(k)).toBe(true);
  const bySlug = Object.fromEntries(contracts.rows.map((r: { slug: string }) => [r.slug, r]));
  expect(bySlug['contracts/acme-amend-1']).toEqual({ slug: 'contracts/acme-amend-1', title: 'Acme amendment 1', date: '2025-06-01T00:00:00.000000Z', date_source: 'date',
    amends: [{ slug: 'contracts/acme-msa', since: '2025-07-01' }] });
  expect(bySlug['contracts/acme-amend-2-draft']).toMatchObject({ page_status: 'draft', amends: [{ slug: 'contracts/acme-msa' }] });
  expect(bySlug['contracts/acme-amend-2-draft'].amends[0].since).toBeUndefined();
  expect(bySlug['contracts/acme-msa-v2'].supersedes).toEqual([{ slug: 'contracts/acme-msa' }]);
  // Hidden: the private date and the private target never reach a remote caller; a local caller sees both.
  expect(bySlug['contracts/acme-amend-3'].amends).toEqual([{ slug: 'contracts/acme-msa' }]);
  const localAmend3 = local[0].records[0].rows.find((r: { slug: string }) => r.slug === 'contracts/acme-amend-3');
  expect(localAmend3.amends).toEqual([{ slug: 'contracts/acme-msa', since: '2026-01-01' }, { slug: 'contracts/acme-private' }]);
  // The stored alias resolves to the pack type; the group is named by the pack type.
  expect(acme.records[1]).toMatchObject({ canonical_type: 'deal', total: 1 });
  // Sibling records side by side, never merged.
  const sheet = acme.siblings.find((s: { slug: string }) => s.slug === 'accounts/acme-example');
  expect(sheet.records).toEqual([expect.objectContaining({ canonical_type: 'contract', total: 1, rows: [expect.objectContaining({ slug: 'contracts/acme-sheet-order' })] })]);
  expect(sheet.next).toEqual({ tool: 'entity', arguments: { name: 'accounts/acme-example' } });
  // Per-page cap: 5 of 7, with the total, the reason and a next that returns exactly the remaining 2 with the same metadata projection.
  const w = widget.records[0];
  expect(w).toMatchObject({ canonical_type: 'contract', total: 7, capped: 'per_page' });
  expect(w.rows).toHaveLength(5);
  expect(w.next.tool).toBe('get_backlinks');
  const rest = (await call(engine, 'get_backlinks', w.next.arguments)).body;
  expect(rest.rows.map((r: { slug: string }) => r.slug)).toEqual(['contracts/widget-2', 'contracts/widget-1']);
  expect(rest.total).toBe(7);
  // Local callers also see the private referrer; quarantined referrers are never listed.
  expect(local[0].records[0].total).toBe(7);
}

/** The batched read equals the single-target read (rows, order, totals, cursors) for every target, type and caller. */
export async function batchedMatchesSingle(engine: BrainEngine): Promise<void> {
  await seedRecordsWorld(engine);
  const pack = await loadSourcePack(engine, SRC);
  const targets = ['crm/acme-example', 'accounts/acme-example', 'crm/widget-example', 'crm/acme-example'].map(slug => ({ slug, sourceId: SRC }));
  for (const excludePrivate of [true, false]) {
    for (const eligibility of [undefined, { floor: 'unknown' as const }]) {
      const scope = { referrerSources: [SRC], excludePrivate, pack, keepVisibility: excludePrivate ? ['world' as const] : ['private' as const, 'world' as const], eligibility };
      const batched = await readTargetReferences(engine, scope, targets, { recordTypes: ['contract', 'deal', 'note'], perCall: 1000 });
      expect(batched[3]).toEqual(batched[0]!);
      for (const [i, t] of targets.entries()) {
        const groups = await readReferrerGroups(engine, { ...scope, slug: t.slug, sourceId: SRC });
        expect(batched[i]!.referenced_by_count).toBe(groups.total);
        for (const g of batched[i]!.records!) {
          const single = await readReferrerPage(engine, { ...scope, slug: t.slug, sourceId: SRC }, { type: g.canonical_type, limit: g.rows.length || 1 });
          expect(g.total).toBe(single.total);
          if (!g.rows.length) continue;
          expect(slugsOf(g)).toEqual(single.rows.map(r => r.slug));
          expect(g.rows.map(r => r.date)).toEqual(single.rows.map(r => r.date));
          expect(g.cursor).toBe(encodeCursor(single.rows[single.rows.length - 1]!));
        }
      }
      // Hidden referrers: private only for trusted callers, quarantined never, below-floor never under a floor.
      const all = batched[0]!.records!.flatMap(slugsOf);
      expect(all.includes('contracts/acme-private')).toBe(!excludePrivate);
      expect(all.includes('contracts/acme-quarantined')).toBe(false);
      expect(all.includes('contracts/acme-low-trust')).toBe(eligibility === undefined);
    }
  }
}

/** The call cap: rows allotted in input order, every name keeps its total and next, a repeated page takes no more. */
export async function callCapInInputOrder(engine: BrainEngine): Promise<void> {
  await seedRecordsWorld(engine);
  for (let a = 1; a <= 5; a++) {
    await put(engine, `crm/bulk-${a}`, 'account', `CRM record: Bulk ${a}`);
    for (let i = 1; i <= 6; i++) {
      await put(engine, `contracts/bulk-${a}-${i}`, 'contract', `Bulk ${a} contract ${i}`, { date: `2025-0${i}-0${a}T00:00:00Z` });
      await link(engine, `contracts/bulk-${a}-${i}`, `crm/bulk-${a}`);
    }
  }
  await engine.setConfig('entity.record_types', 'contract');
  // The second name resolves to the same page as the first (by title): it repeats that page's records and takes no more of the cap.
  const names = ['crm/bulk-1', 'CRM record: Bulk 1', 'crm/bulk-2', 'crm/bulk-3', 'crm/bulk-4', 'crm/bulk-5'];
  const { body } = await call(engine, 'entity', { names });
  const rows = body.results;
  expect(rows).toHaveLength(6);
  expect(rows[1]).toMatchObject({ found: true, slug: 'crm/bulk-1' });
  expect(rows[1].records).toEqual(rows[0].records);
  expect(rows.map((r: { records: Array<{ rows: unknown[] }> }) => r.records[0]!.rows.length)).toEqual([5, 5, 5, 5, 5, 4]);
  expect(rows.map((r: { records: Array<{ total: number }> }) => r.records[0]!.total)).toEqual([6, 6, 6, 6, 6, 6]);
  expect(rows[5].records[0]).toMatchObject({ capped: 'per_call' });
  expect(rows[0].records[0]).toMatchObject({ capped: 'per_page' });
  const sixth = await call(engine, 'entity', { names: ['crm/bulk-1', 'crm/bulk-2', 'crm/bulk-3', 'crm/bulk-4', 'crm/bulk-5', 'crm/widget-example'] });
  const zero = sixth.body.results[5].records[0];
  expect(zero).toMatchObject({ canonical_type: 'contract', total: 7, rows: [], capped: 'per_call' });
  expect(zero.next.arguments.cursor).toBeUndefined();
  expect((await call(engine, 'get_backlinks', zero.next.arguments)).body.rows).toHaveLength(7);
}

/** A forced-slow read gives the unavailable marker and one degraded notice on names rows, the card and context_pack. */
export async function deadlineGivesUnavailable(engine: BrainEngine): Promise<void> {
  await seedRecordsWorld(engine);
  await engine.setConfig('entity.record_types', 'contract');
  const restore = __setReferencesTimingForTests({ deadlineMs: 30, delayMs: 300 });
  try {
    const names = await call(engine, 'entity', { names: ['crm/acme-example'] });
    expect(names.body.results[0]).toMatchObject({ found: true, references_unavailable: 'deadline' });
    expect(names.body.results[0].records).toBeUndefined();
    expect(names.body.results[0].referenced_by_count).toBeUndefined();
    expect(names.body.results[0].siblings[0]).toMatchObject({ references_unavailable: 'deadline' });
    expect(names.notices.map(n => n.code)).toContain('references_unavailable');
    const card = await call(engine, 'entity', { name: 'crm/acme-example' });
    expect(card.body.card).toMatchObject({ references_unavailable: 'deadline', referenced_by_count: 8 });
    expect(card.notices.map(n => n.code)).toContain('references_unavailable');
    const pack = await call(engine, 'context_pack', { entities: 'crm/acme-example' });
    expect(pack.body.cards[0]).toMatchObject({ references_unavailable: 'deadline' });
    expect(pack.body.text).toContain('records unavailable (deadline); unread, not empty');
    expect(pack.notices.map(n => n.code)).toContain('references_unavailable');
  } finally {
    restore();
  }
}

/** context_pack: records only when enrolled, structured and packed text, hidden referrers excluded; the push assembler never reads them. */
export async function contextPackRecords(engine: BrainEngine): Promise<void> {
  await seedRecordsWorld(engine);
  const before = (await call(engine, 'context_pack', { entities: 'crm/acme-example' })).body;
  expect(before.cards[0].records).toBeUndefined();
  expect(before.cards[0].referenced_by_count).toBeUndefined();
  await engine.setConfig('entity.record_types', 'contract');
  const { body } = await call(engine, 'context_pack', { entities: 'crm/acme-example', min_trust: 'unknown' });
  const card = body.cards[0];
  expect(card.referenced_by_count).toBe(7);
  expect(slugsOf(card.records[0])).toEqual(['contracts/acme-msa-v2', 'contracts/acme-amend-3', 'contracts/acme-amend-2-draft', 'contracts/acme-amend-1', 'contracts/acme-msa']);
  expect(card.sibling_records).toEqual([expect.objectContaining({ slug: 'accounts/acme-example', referenced_by_count: 1 })]);
  expect(body.text).toContain('## Records that reference these entities (page date = when the page was written');
  expect(body.text).toContain('- crm/acme-example: contract contracts/acme-amend-1 "Acme amendment 1" — page date 2025-06-01 (date); amends contracts/acme-msa (terms start 2025-07-01)');
  expect(body.text).toContain('status: draft');
  expect(body.text).toContain('- accounts/acme-example: contract contracts/acme-sheet-order');
  const recordsText = body.text.slice(body.text.indexOf('## Records'));
  for (const hidden of ['acme-private', 'acme-quarantined', 'acme-low-trust', '2026-01-01']) {
    expect(JSON.stringify([card.records, card.sibling_records])).not.toContain(hidden);
    expect(recordsText).not.toContain(hidden);
  }
  const push = await assembleContextPack(engine, { sourceId: SRC, entities: ['crm/acme-example'], maxEntities: 8 });
  expect(push.text).not.toContain('## Records');
  expect(JSON.stringify(push.cards)).not.toContain('"records"');
}

/** The full card keeps referenced_by and gains the record view; an undeclared enrolled type says so. */
export async function fullCardRecords(engine: BrainEngine): Promise<void> {
  await seedRecordsWorld(engine);
  await engine.setConfig('entity.record_types', 'contract,nonexistent-type');
  const { body, notices } = await call(engine, 'entity', { name: 'crm/acme-example' });
  expect(body.card.referenced_by_count).toBe(8);
  expect(body.card.referenced_by.map((g: { canonical_type: string }) => g.canonical_type).sort()).toEqual(['contract', 'deal', 'note']);
  expect(body.card.records[0]).toMatchObject({ canonical_type: 'contract', total: 6 });
  expect(body.card.identity_siblings.pages[0]).toMatchObject({ slug: 'accounts/acme-example', records: [expect.objectContaining({ total: 1 })] });
  expect(notices.map(n => n.code)).toContain('record_types_undeclared');
}

/** A failing referrer read marks the full card (and names rows) unavailable with one degraded notice, instead of a silent omission. */
export async function readFailureGivesUnavailable(engine: BrainEngine): Promise<void> {
  await seedRecordsWorld(engine);
  await engine.setConfig('entity.record_types', 'contract');
  const broken = Object.create(engine) as BrainEngine;
  broken.executeRaw = ((sql: string, params?: unknown[]) => sql.includes('refs AS MATERIALIZED')
    ? Promise.reject(new Error('synthetic referrer failure')) : engine.executeRaw(sql, params as never)) as never;
  const card = await call(broken, 'entity', { name: 'crm/acme-example' });
  expect(card.body.card.references_unavailable).toBe('read_failed');
  expect(card.body.card.referenced_by).toBeUndefined();
  expect(card.body.card.records).toBeUndefined();
  expect(card.notices.filter(n => n.code === 'references_unavailable')).toHaveLength(1);
  const names = await call(broken, 'entity', { names: ['crm/acme-example'] });
  expect(names.body.results[0]).toMatchObject({ found: true, references_unavailable: 'read_failed' });
  expect(names.notices.map(n => n.code)).toContain('references_unavailable');
}

/** Zero records under enrollment is an empty list (not the unavailable marker); the firing counter separates the three. */
export async function zeroRecordsAndFiring(engine: BrainEngine): Promise<void> {
  const { recordsFiring } = await import('../../src/core/verbs/usage-log.ts');
  await seedRecordsWorld(engine);
  await engine.setConfig('entity.record_types', 'contract');
  await put(engine, 'crm/empty-example', 'account', 'CRM record: Empty Example');
  const { body } = await call(engine, 'entity', { names: ['crm/empty-example', 'crm/widget-example'] });
  expect(body.results[0]).toMatchObject({ referenced_by_count: 0, records: [] });
  expect(recordsFiring(body)).toEqual({ listed: 1, zero: 1, unavailable: 0 });
  await engine.unsetConfig('entity.record_types');
  expect(recordsFiring((await call(engine, 'entity', { names: ['crm/widget-example'] })).body)).toBeNull();
}

/** Every optional record field validates against the frozen v1 response schemas (card and context_pack), one fixture each. */
export async function recordFieldsSchemaValid(engine: BrainEngine): Promise<void> {
  const { validateAgainstSchema } = await import('../../src/core/verbs/conformance.ts');
  const { RESPONSE_SCHEMAS } = await import('../../src/core/verbs.ts');
  await seedRecordsWorld(engine);
  await engine.setConfig('entity.record_types', 'contract');
  const card = (await call(engine, 'entity', { name: 'crm/acme-example' }, false)).body;
  const rows = card.card.records[0].rows as Array<Record<string, unknown>>;
  for (const field of ['page_status', 'amends', 'supersedes']) expect(rows.some(r => field in r)).toBe(true);
  expect(rows.some(r => (r.amends as Array<{ since?: string }> | undefined)?.some(a => a.since))).toBe(true);
  expect(card.card.records[0].next).toBeDefined();
  expect(validateAgainstSchema(card, RESPONSE_SCHEMAS.entity)).toEqual([]);
  const pack = (await call(engine, 'context_pack', { entities: 'crm/acme-example' })).body;
  expect(pack.cards[0].sibling_records).toBeDefined();
  expect(validateAgainstSchema(pack, RESPONSE_SCHEMAS.context_pack)).toEqual([]);
  const restore = __setReferencesTimingForTests({ deadlineMs: 30, delayMs: 300 });
  try {
    expect(validateAgainstSchema((await call(engine, 'entity', { name: 'crm/acme-example' })).body, RESPONSE_SCHEMAS.entity)).toEqual([]);
    expect(validateAgainstSchema((await call(engine, 'context_pack', { entities: 'crm/acme-example' })).body, RESPONSE_SCHEMAS.context_pack)).toEqual([]);
  } finally { restore(); }
}

/** Records pack last: newer mentions still pack under 1,500 and 2,000 token budgets with records present, and the text honors the budget. */
export async function recordsPackLast(engine: BrainEngine): Promise<void> {
  await seedRecordsWorld(engine);
  // The entity page is dated before most referrers, so they are its newer mentions too.
  await engine.executeRaw(`UPDATE pages SET effective_date = '2025-05-01T00:00:00Z', effective_date_source = 'date' WHERE slug = 'crm/acme-example'`);
  const without = await call(engine, 'context_pack', { entities: 'crm/acme-example', budget_tokens: 1500 });
  expect(without.body.cards[0].newer_mentions).toBeDefined();
  await engine.setConfig('entity.record_types', 'contract');
  for (const budget of [1500, 2000]) {
    const { body } = await call(engine, 'context_pack', { entities: 'crm/acme-example', budget_tokens: budget });
    expect(body.budget_used).toBeLessThanOrEqual(budget);
    expect(body.cards[0].newer_mentions).toEqual(without.body.cards[0].newer_mentions);
    const mentionsAt = body.text.indexOf('## Newer pages');
    const recordsAt = body.text.indexOf('## Records');
    expect(mentionsAt).toBeGreaterThan(0);
    expect(recordsAt).toBeGreaterThan(mentionsAt);
    expect(body.cards[0].referenced_by_count).toBe(8);
  }
  const tiny = (await call(engine, 'context_pack', { entities: 'crm/acme-example', budget_tokens: 120 })).body;
  if (tiny.cards.length) {
    expect(tiny.cards[0].records).toBeUndefined();
    expect(tiny.cards[0].referenced_by_count).toBeDefined();
  }
}
