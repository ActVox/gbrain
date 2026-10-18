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
 */
import { execFileSync } from '../spawn.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { fileDatabaseDriftFix, replaceableFile } from '../facts/file-body-guard.ts';
import { isDbOnly, loadStorageConfig } from '../storage-config.ts';
import { deletePageThrough, isWriteThroughDisabled, resolvePageWriteTarget, writePageThrough } from '../write-through.ts';
import { urlCloneReadOnly } from '../url-clone.ts';
import { gitChildEnv } from '../git-env.ts';

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
 * Write one generated page's markdown file. Never throws; the result says
 * whether a file was written, why not, or the write error. Ignored and db_only
 * targets are skipped on purpose (`skipped: 'not_canonical'`).
 * `expectedFileBytes` binds the write to the file the caller read.
 */
export async function writeDerivedPageThrough(engine: BrainEngine, slug: string, sourceId: string,
  opts: { expectedFileBytes?: string | null } = {}): Promise<{ written: boolean; skipped?: string; error?: string }> {
  const target = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!target.ok) return { written: false, skipped: target.skipped };
  let storage = null;
  try { storage = loadStorageConfig(target.writeRoot); } catch { /* unreadable gbrain.yml: sync reports it */ }
  if ((storage && isDbOnly(slug, storage)) || gitIgnores(target.writeRoot, target.filePath)) return { written: false, skipped: 'not_canonical' };
  const result = await writePageThrough(engine, slug, { sourceId, expectedFileBytes: opts.expectedFileBytes });
  if (result.error) console.error(`[write-through] ${slug}: ${result.error}`);
  return result;
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
): Promise<((slugs: readonly string[], retired?: readonly string[]) => Promise<void>) | null> {
  if (opts.managed || opts.dryRun || !await derivedWriteThroughEnabled(engine, phase)) return null;
  const write = async (slugs: readonly string[], retired: readonly string[] = []) => {
    for (const slug of slugs) await writeDerivedPageThrough(engine, slug, sourceId);
    for (const slug of retired) await deletePageThrough(engine, slug, { sourceId });
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
  return write;
}

/** What a dream reverse-write did with one page's file. `held` is its `file_database_drift` entry. */
export type DreamPageFileWrite = { written: true; path: string } | { written: false; held?: string; skipped?: string; error?: string };

/**
 * #6982: write the file of a page the dream cycle wrote in the database (a synthesis or patterns output, the cycle
 * summary) without replacing an edit only the file holds. Nothing is written with `sync.write_through` off, for a clone
 * gbrain owns, or for a declared `storage.db_only` slug: the database is the copy of record. The file is the page's
 * file of record (`resolvePageWriteTarget`: recorded source_path, own-local_path roots); a source with no usable
 * checkout (no root configured, or the root is missing) keeps the caller's brainDir layout (`<brainDir>/<slug>.md`,
 * foreign sources under `.sources/<id>/`). The file is replaced only when `replaceableFile` finds nothing in it the
 * database lacks, and is re-read right before the atomic write, so an edit that lands in between is kept as well.
 *
 * This is the reverse-write's own direct write, not `writePageThrough`: once a subagent's tool write has gone through
 * the coordinator, the checkout carries an owner marker and `writePageThrough` refuses `writer_coordinator_required`,
 * which would leave the file behind the database for the next coordinated write to refuse as drift.
 */
export async function writeDreamPageFile(engine: BrainEngine, brainDir: string, slug: string, sourceId: string,
  opts: { nativeSourceId: string; markdown: string }): Promise<DreamPageFileWrite> {
  if (await isWriteThroughDisabled(engine)) return { written: false, skipped: 'disabled_by_config' };
  if (await urlCloneReadOnly(engine, sourceId)) return { written: false, skipped: 'url_clone' };
  const target = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!target.ok && target.skipped !== 'no_repo_configured' && target.skipped !== 'repo_not_found') return { written: false, skipped: target.skipped };
  try {
    const storage = loadStorageConfig(target.ok ? target.writeRoot : brainDir);
    if (storage && isDbOnly(slug, storage)) return { written: false, skipped: 'db_only' };
  } catch { /* unreadable gbrain.yml: sync reports it */ }
  const filePath = target.ok ? target.filePath
    : sourceId === opts.nativeSourceId ? join(brainDir, `${slug}.md`) : join(brainDir, '.sources', sourceId, `${slug}.md`);
  const check = await replaceableFile(engine, sourceId, slug, filePath);
  if (!check.ok) return { written: false, held: dreamFileDriftToken(slug, sourceId, 'before') };
  if ((existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null) !== check.expectedFileBytes) {
    return { written: false, held: dreamFileDriftToken(slug, sourceId, 'during') };
  }
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, opts.markdown);
  return { written: true, path: filePath };
}

/** #6982: the hold entry for a dream page whose file holds an edit the database lacks. */
function dreamFileDriftToken(slug: string, sourceId: string, when: 'before' | 'during'): string {
  return `${slug} (file_database_drift: the file ${when === 'before' ? 'holds an edit the database lacks' : 'changed while the dream cycle wrote it'}, `
    + `so the dream output stays in the database only and the file was not replaced. ${fileDatabaseDriftFix(slug, sourceId)})`;
}

/** A dream phase result with its held page files: listed in `details.file_holds`, and an ok phase warns. */
export function withFileHolds(result: PhaseResult, held: readonly string[]): PhaseResult {
  if (held.length === 0) return result;
  return { ...result, status: result.status === 'ok' ? 'warn' : result.status, details: { ...result.details, file_holds: [...new Set([...((result.details.file_holds as string[] | undefined) ?? []), ...held])] },
    summary: `${result.summary}; ${held.length} page file(s) held because they differ from the database (details.file_holds)` };
}
