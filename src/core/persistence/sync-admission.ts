/**
 * #6712 PR 4b (design v3.2 §8): `sync.admission`, the brain-wide switch that pauses what a managed pass admits.
 *
 * - `normal` (the default): the pass admits everything it classifies.
 * - `imports_only`: no deletes and no keep_db writes; those paths settle as `paused_deletes` / `paused_keep_db`.
 * - `classify_only`: the pass reads and classifies, writes telemetry only, and stamps nothing (stop `admission_paused`).
 *
 * The value is read at pin, inside every group's admission transaction, and by the destructive kinds at publication, so
 * a change takes effect at the next group. An unrecognized stored value reads as `classify_only` (fail closed).
 */
import type { BrainEngine } from '../engine.ts';

export const SYNC_ADMISSION_KEY = 'sync.admission';
export const SYNC_ADMISSION_VALUES = ['normal', 'imports_only', 'classify_only'] as const;
export type SyncAdmission = typeof SYNC_ADMISSION_VALUES[number];

export function parseSyncAdmission(value: string | null | undefined): SyncAdmission {
  const trimmed = value?.trim();
  if (!trimmed) return 'normal';
  return (SYNC_ADMISSION_VALUES as readonly string[]).includes(trimmed) ? trimmed as SyncAdmission : 'classify_only';
}

/** The value in effect, read in the caller's transaction (`tx`) when given, so admission and publication see one value. */
export async function readSyncAdmission(engine: Pick<BrainEngine, 'executeRaw'>): Promise<SyncAdmission> {
  const [row] = await engine.executeRaw<{ value: string | null }>('SELECT value FROM config WHERE key=$1', [SYNC_ADMISSION_KEY]);
  return parseSyncAdmission(row?.value ?? null);
}

/** Whether a kind of write may be admitted (or published) under `admission`. */
export function admissionAllows(admission: SyncAdmission, kind: 'import' | 'destructive'): boolean {
  if (admission === 'normal') return true;
  return admission === 'imports_only' && kind === 'import';
}
