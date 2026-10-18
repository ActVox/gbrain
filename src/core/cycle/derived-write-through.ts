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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { Page } from '../types.ts';
import { throwIfAborted } from '../abort-check.ts';
import { validateSourceId } from '../utils.ts';
import { fileDatabaseDriftToken, replaceableFile } from '../facts/file-body-guard.ts';
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
 * This is the reverse-write's own direct write (a staged sibling renamed over the file), as before, not
 * `writePageThrough` or `atomicWriteFileSync`: once a subagent's tool write has gone through the coordinator, the
 * checkout carries an owner marker and both refuse `writer_coordinator_required`, which would leave the file behind the
 * database for the next coordinated write to refuse as drift.
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
  const staged = `${filePath}.${process.pid}.tmp`;
  writeFileSync(staged, opts.markdown, 'utf-8');
  renameSync(staged, filePath);
  return { written: true, path: filePath };
}

/** #6982: the hold entry for a dream page whose file holds an edit the database lacks. */
function dreamFileDriftToken(slug: string, sourceId: string, when: 'before' | 'during'): string {
  return fileDatabaseDriftToken(slug, sourceId, when, 'the dream output stays in the database only', 'the dream reverse-write');
}

/** A dream phase result with its held page files: listed in `details.file_holds`, and an ok phase warns. */
export function withFileHolds(result: PhaseResult, held: readonly string[]): PhaseResult {
  if (held.length === 0) return result;
  return { ...result, status: result.status === 'ok' ? 'warn' : result.status, details: { ...result.details, file_holds: [...new Set([...((result.details.file_holds as string[] | undefined) ?? []), ...held])] },
    summary: `${result.summary}; ${held.length} page file(s) held because they differ from the database (details.file_holds)` };
}

/**
 * The dream reverse-write loop (synthesize, patterns, #6982): each ref's page rendered by `render` and written through
 * `writeDreamPageFile`. A page whose file holds an edit the database lacks keeps that file and its `file_database_drift`
 * entry is pushed to `held`; an abort stops before the next file; other per-page failures are logged and skipped.
 * Returns the number of files written.
 */
export async function reverseWriteDreamRefs<R extends { slug: string; source_id: string }>(engine: BrainEngine, brainDir: string, refs: R[],
  opts: { phase: string; nativeSourceId: string; render: (page: Page, tags: string[], ref: R) => string; signal?: AbortSignal; held?: string[] }): Promise<number> {
  let count = 0;
  for (const ref of refs) {
    const { slug, source_id } = ref;
    throwIfAborted(opts.signal, `[dream] ${opts.phase} reverse-write`);
    // v0.32.8 F6: validate source_id is filesystem-safe before any join().
    validateSourceId(source_id);
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    const tags = await engine.getTags(slug, { sourceId: source_id });
    // #4077: re-check after the row reads — an abort that lands during
    // getPage/getTags must not reach this ref's file write.
    throwIfAborted(opts.signal, `[dream] ${opts.phase} reverse-write`);
    try {
      const file = await writeDreamPageFile(engine, brainDir, slug, source_id, { nativeSourceId: opts.nativeSourceId, markdown: opts.render(page, tags, ref) });
      if (file.written) count++;
      else if (file.held) opts.held?.push(file.held);
      else if (file.error) process.stderr.write(`[dream] reverse-write ${slug}@${source_id} failed: ${file.error}\n`);
    } catch (e) {
      // Per-slug failures are non-fatal — phase continues.
      process.stderr.write(`[dream] reverse-write ${slug}@${source_id} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return count;
}
