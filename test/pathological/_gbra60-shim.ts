/**
 * GBRA-60's subset of the pathological harness (GBRA-130, test/pathological/harness.ts on
 * capy/gbra130-item-isolation), under the same names so the row files switch to the harness
 * import mechanically once it lands. Lane B rows only need the engine arms.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { requirePostgresTestDatabase, testBackends, type TestBackend } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

/** The engine arms a pathological case runs on: PGLite, plus Postgres when the lane provides DATABASE_URL. */
export function pathologicalArms(): Array<{ backend: TestBackend; databaseUrl: string | undefined }> {
  return testBackends().map(backend => ({ backend, databaseUrl: backend === 'pglite' ? undefined : requirePostgresTestDatabase() }));
}

/** A fresh, migrated brain for one arm: in-memory PGLite, or an isolated Postgres schema. */
export async function openArm(arm: { backend: TestBackend; databaseUrl: string | undefined }): Promise<{ engine: BrainEngine; close: () => Promise<void> }> {
  if (arm.backend === 'pglite') {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    return { engine, close: () => engine.disconnect() };
  }
  const pg = await isolatedPersistencePostgres(arm.databaseUrl!);
  return { engine: pg.engine, close: pg.close };
}
