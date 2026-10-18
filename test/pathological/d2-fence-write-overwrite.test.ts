/**
 * D-2 (GBRA-131, #6982): appending facts never mirrors a different checkout body over the database.
 * Protects: database-newer, file-newer and concurrent edits retain exact bytes; the writer returns a DB-only
 * fallback, and writeSingleFact records the unfenced fact. Agreeing copies still append with history.
 * Fails when: the pre-fix whole-file mirror overwrites the DB after publishing the file.
 * Existing coverage checks missing files, not divergent live copies or publication races.
 * Seams: engine proxy injects a real edit before the prepared fence transaction; no production-only hook.
 */
import { describe, expect, test } from 'bun:test';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { pathologicalArms } from './harness.ts';
import { CLAIM, EDIT, SLUG, editWhenPrepared, withFactsBrain } from './facts-overwrite-fixture.ts';

for (const { backend, databaseUrl } of pathologicalArms()) describe(`D-2 fence writes (${backend})`, () => {
  for (const mode of ['database', 'file', 'late-database', 'late-file'] as const) test(`${mode} edit preserves both copies and falls back`, async () => {
    await withFactsBrain(databaseUrl, async b => {
      if (mode === 'database') await b.dbEdit();
      if (mode === 'file') b.fileEdit();
      const before = { file: b.bytes(), body: await b.body() };
      const racing = mode.startsWith('late-') ? editWhenPrepared(b, () => mode === 'late-database' ? b.dbEdit() : b.fileEdit()) : b.engine;
      const result = await b.append(racing);
      expect({ file: b.bytes(), body: await b.body() }).toEqual({
        file: before.file + (mode === 'late-file' ? EDIT : ''), body: before.body + (mode === 'late-database' ? EDIT : ''),
      });
      expect(result).toMatchObject({ inserted: 0, legacyFallback: true, databaseOnlyReason: 'file_database_drift' });
      expect(result.warning).toContain(`${SLUG} (file_database_drift`);
      expect(result.warning).toContain('gbrain sync --source default');
      expect((await writeSingleFact(b.engine, 'default', { fact: CLAIM, entity: SLUG, provenance: 'test', visibility: 'world' })).status).toBe('inserted');
      expect(await b.engine.executeRaw('SELECT fact, row_num FROM facts')).toEqual([{ fact: CLAIM, row_num: null }]);
    });
  }, 180_000);

  test('agreeing copies append and preserve the prior body', async () => {
    await withFactsBrain(databaseUrl, async b => {
      const before = await b.body();
      expect((await b.append()).inserted).toBe(1);
      expect(parseFactsFence(b.bytes()).facts.map(f => f.claim)).toEqual([CLAIM]);
      expect(parseFactsFence(await b.body()).facts.map(f => f.claim)).toEqual([CLAIM]);
      expect(await b.engine.executeRaw('SELECT compiled_truth FROM page_versions WHERE compiled_truth = $1', [before])).toHaveLength(1);
    });
  }, 180_000);
});
