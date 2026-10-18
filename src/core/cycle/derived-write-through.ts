/**
 * Opt-in markdown write-through for pages the dream cycle generates on an
 * unmanaged brain (#5041): atoms (`extract_atoms`) and concepts
 * (`synthesize_concepts`). Off by default, so the cycle never adds files to a
 * user's repository unasked; managed brains publish these pages through
 * maintenance publication instead and never reach this module.
 *
 * Enabled by `cycle.extract_atoms.write_through` /
 * `cycle.synthesize_concepts.write_through`. Each written page goes through
 * `writePageThrough` (honouring `sync.write_through=off`, source containment
 * and case collisions). A page whose target is ignored by git or sits in a
 * declared `storage.db_only` directory (which sync gitignores) stays
 * database-only. The first run after the key is enabled also writes the
 * generated pages that have no file yet, a bounded batch per run. A page the
 * phase retires has its file removed, so sync cannot bring it back.
 *
 * #6982: a file is replaced or removed only when it holds nothing the
 * database lacks (`replaceableFile`: absent, or equal to the page or one of
 * its recent versions), and the write is bound to the bytes compared. A file
 * holding a hand edit or an unindexed file at the path is left as it is and
 * the page is reported in the hook's `held` list (`file_database_drift`).
 */
import { execFileSync } from '../spawn.ts';
import { relative } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { isDbOnly, loadStorageConfig } from '../storage-config.ts';
import { deletePageThrough, isWriteThroughDisabled, resolvePageWriteTarget, writePageThrough, type PageWriteTarget } from '../write-through.ts';
import { gitChildEnv } from '../git-env.ts';
import { fileDatabaseDriftToken, replaceableFile } from '../facts/file-body-guard.ts';

export const DERIVED_WRITE_THROUGH_KEYS = {
  extract_atoms: 'cycle.extract_atoms.write_through',
  synthesize_concepts: 'cycle.synthesize_concepts.write_through',
} as const;

/** Pages without a file written per run by the enable-time backfill. */
export const DERIVED_BACKFILL_LIMIT = 200;

const ON_VALUES = new Set(['true', '1', 'yes', 'on']);

export async function derivedWriteThroughEnabled(engine: BrainEngine, phase: keyof typeof DERIVED_WRITE_THROUGH_KEYS): Promise<boolean> {
  const raw = await engine.getConfig(DERIVED_WRITE_THROUGH_KEYS[phase]).catch(() => null);
  return raw != null && ON_VALUES.has(raw.trim().toLowerCase());
}

function gitIgnores(root: string, filePath: string): boolean {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', relative(root, filePath)], { env: gitChildEnv(), stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The checkout file a generated page publishes to, or why it has none this
 * module writes: write-through off (`disabled_by_config`), no resolvable
 * target, or a target ignored by git or inside a declared `storage.db_only`
 * directory (`not_canonical`). `includeDeleted` resolves a retired page's
 * recorded path.
 */
export async function derivedFileTarget(engine: BrainEngine, slug: string, sourceId: string,
  opts: { includeDeleted?: boolean } = {}): Promise<{ ok: true; target: Extract<PageWriteTarget, { ok: true }> } | { ok: false; skipped: string }> {
  if (await isWriteThroughDisabled(engine)) return { ok: false, skipped: 'disabled_by_config' };
  const target = await resolvePageWriteTarget(engine, slug, sourceId, opts);
  if (!target.ok) return { ok: false, skipped: target.skipped };
  let storage = null;
  try { storage = loadStorageConfig(target.writeRoot); } catch { /* unreadable gbrain.yml: sync reports it */ }
  if ((storage && isDbOnly(slug, storage)) || gitIgnores(target.writeRoot, target.filePath)) return { ok: false, skipped: 'not_canonical' };
  return { ok: true, target };
}

/**
 * Write one generated page's markdown file. Never throws; the result says
 * whether a file was written, why not, or the write error. Ignored and db_only
 * targets are skipped on purpose (`skipped: 'not_canonical'`).
 * `expectedFileBytes` binds the write to the file the caller read (and
 * already compared); without it the file must pass `replaceableFile` first,
 * else nothing is written (`skipped: 'file_database_drift'`).
 */
export async function writeDerivedPageThrough(engine: BrainEngine, slug: string, sourceId: string,
  opts: { expectedFileBytes?: string | null } = {}): Promise<{ written: boolean; skipped?: string; error?: string }> {
  const resolved = await derivedFileTarget(engine, slug, sourceId);
  if (!resolved.ok) return { written: false, skipped: resolved.skipped };
  let expectedFileBytes = opts.expectedFileBytes;
  if (expectedFileBytes === undefined) {
    const file = await replaceableFile(engine, sourceId, slug, resolved.target.filePath);
    if (!file.ok) return { written: false, skipped: 'file_database_drift' };
    expectedFileBytes = file.expectedFileBytes;
  }
  const result = await writePageThrough(engine, slug, { sourceId, expectedFileBytes });
  if (result.error) console.error(`[write-through] ${slug}: ${result.error}`);
  return result;
}

/**
 * Remove a retired generated page's file when the retired page (or one of
 * its versions) holds everything in it; the unlink is bound to the bytes
 * compared. Returns `file_database_drift` when the file holds an edit the
 * database lacks.
 */
async function deleteDerivedPageThrough(engine: BrainEngine, slug: string, sourceId: string): Promise<{ removed: boolean; skipped?: string }> {
  const resolved = await derivedFileTarget(engine, slug, sourceId, { includeDeleted: true });
  if (!resolved.ok) return { removed: false, skipped: resolved.skipped };
  const file = await replaceableFile(engine, sourceId, slug, resolved.target.filePath);
  if (!file.ok) return { removed: false, skipped: 'file_database_drift' };
  if (file.expectedFileBytes === null) return { removed: false, skipped: 'file_not_present' };
  return deletePageThrough(engine, slug, { sourceId, target: resolved.target, expectedFileBytes: file.expectedFileBytes });
}

/** `result` with the hook's held pages reported: `details.file_holds`, a `warn` status and a summary note. */
export function reportFileHolds(result: PhaseResult, held: readonly string[] | undefined, noun: string): PhaseResult {
  if (!held?.length) return result;
  return { ...result, status: result.status === 'fail' ? 'fail' : 'warn', details: { ...result.details, file_holds: [...held] },
    summary: `${result.summary} (${held.length} ${noun} file(s) left as they are: file_database_drift)` };
}

/** The phase's write-through hook: `write` publishes pages and removes retired ones' files; `held` reports each page left alone. */
export interface DerivedWriteThrough {
  write(slugs: readonly string[], retired?: readonly string[]): Promise<void>;
  held: string[];
}

/**
 * The phase's write-through hook, or null when it does not apply (key off,
 * managed brain, dry run): writes the given pages and removes the files of
 * the retired ones. Creating it writes the bounded backfill of generated
 * pages of the phase's type in the source that have no file yet.
 */
export async function derivedWriteThrough(
  engine: BrainEngine,
  phase: keyof typeof DERIVED_WRITE_THROUGH_KEYS,
  sourceId: string,
  opts: { managed: boolean; dryRun: boolean },
): Promise<DerivedWriteThrough | null> {
  if (opts.managed || opts.dryRun || !await derivedWriteThroughEnabled(engine, phase)) return null;
  const held: string[] = [];
  const kept = (skipped: string | undefined) => skipped === 'file_database_drift' || skipped === 'file_changed';
  const write = async (slugs: readonly string[], retired: readonly string[] = []) => {
    for (const slug of slugs) {
      if (kept((await writeDerivedPageThrough(engine, slug, sourceId)).skipped)) {
        held.push(fileDatabaseDriftToken(slug, sourceId, 'before', 'the generated page was not written to its file'));
      }
    }
    for (const slug of retired) {
      if (kept((await deleteDerivedPageThrough(engine, slug, sourceId)).skipped)) {
        held.push(fileDatabaseDriftToken(slug, sourceId, 'before', 'the retired page\'s file was not removed'));
      }
    }
  };
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND source_path IS NULL
        AND type = $2 AND ($2 <> 'concept' OR frontmatter->>'synthesized_by' LIKE 'synthesize_concepts%')
        AND COALESCE(frontmatter->>'source_hash', '') NOT LIKE 'pending:%'
      ORDER BY id LIMIT $3`,
    [sourceId, phase === 'extract_atoms' ? 'atom' : 'concept', DERIVED_BACKFILL_LIMIT],
  );
  await write(rows.map(r => r.slug));
  return { write, held };
}
