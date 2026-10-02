/**
 * `gbrain extract timeline --source db` (#5904 probe, E28).
 *
 * `timeline_entries` is a guarded table: on a managed brain (every fresh
 * `gbrain init` brain is one) a raw batch insert is refused by
 * `managed_writer_guard`. Managed brains therefore publish each page's
 * timeline through the coordinator: under the page lock, bound to the
 * revision that was read, the rows an earlier version produced and the
 * current text no longer does are retracted and the timeline tuples the
 * canonical body projects with no stored row are inserted. Unmanaged brains
 * keep the batched raw insert.
 *
 * A refused write is reported as what it is: nothing was written and the
 * timeline rows import already stored are untouched. Refusals are counted
 * apart from written rows and make the command exit non-zero.
 */
import type { BrainEngine, TimelineBatchInput } from '../core/engine.ts';
import type { Page, PageType } from '../core/types.ts';
import { parseTimelineEntries, deriveTimelineAnchor } from '../core/link-extraction.ts';
import { retractRemovedTimelineEntries } from '../core/timeline-extract.ts';
import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { withCoordinatedWrite } from '../core/persistence/context.ts';
import { unrecordedCanonicalTimeline } from '../core/persistence/canonical-projections.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { filterRefsSince } from './extract.ts';

const BATCH_SIZE = 100;
export const TIMELINE_REFUSAL_DOCS = 'docs/guides/write-refusals.md#extract-timeline-refused';

export interface TimelineDbResult {
  created: number;
  pages: number;
  /** Pages (managed) or rows (unmanaged batches) whose write was refused. */
  refused: number;
  /** Managed pages edited during the run; they keep their stored rows and are picked up by the next run. */
  skipped: number;
  refusal_codes: string[];
}

export interface TimelineDbOptions {
  dryRun: boolean;
  jsonMode: boolean;
  quiet?: boolean;
  typeFilter?: PageType;
  since?: string;
  sourceIdFilter?: string;
  inferDates?: boolean;
  /** Restrict the walk to these slugs (requires sourceIdFilter). */
  slugs?: readonly string[];
}

/** The refusal reason: the guard's `code: message` prefix, else the error's own code. */
export function refusalCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const prefixed = /^([a-z][a-z0-9_]+):/.exec(message);
  if (prefixed) return prefixed[1];
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]+$/.test(code) ? code : 'storage_error';
}

function reportRefusal(opts: TimelineDbOptions, code: string, where: string, message: string): void {
  if (opts.jsonMode) {
    process.stderr.write(JSON.stringify({ event: 'timeline_refused', code, where, error: message }) + '\n');
  } else {
    console.error(`  refused: ${code}; nothing written; existing timeline rows are untouched (${where})`);
  }
}

function anchorFor(page: Page, slug: string) {
  return deriveTimelineAnchor({ slug, title: page.title, effectiveDate: page.effective_date, effectiveDateSource: page.effective_date_source });
}

async function walkRefs(engine: BrainEngine, opts: TimelineDbOptions) {
  const all = opts.sourceIdFilter
    ? (await engine.listAllPageRefs()).filter(r => r.source_id === opts.sourceIdFilter)
    : await engine.listAllPageRefs();
  const wanted = opts.slugs ? new Set(opts.slugs) : null;
  return filterRefsSince(wanted ? all.filter(r => wanted.has(r.slug)) : all, opts.since);
}

/**
 * Walk the selected pages from the database and add their timeline rows.
 * Managed brains publish per page through the coordinator; unmanaged brains
 * batch raw inserts (`ON CONFLICT DO NOTHING`).
 */
export async function extractTimelineFromDB(engine: BrainEngine, opts: TimelineDbOptions): Promise<TimelineDbResult> {
  const refs = await walkRefs(engine, opts);
  const result: TimelineDbResult = { created: 0, pages: 0, refused: 0, skipped: 0, refusal_codes: [] };
  const codes = new Set<string>();
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.timeline_db', refs.length);
  const managed = !opts.dryRun && await managedPersistenceEnabled(engine);
  const dryRunSeen = opts.dryRun ? new Set<string>() : null;
  const batch: TimelineBatchInput[] = [];

  async function flush() {
    if (batch.length === 0) return;
    const snapshot = batch.slice();
    batch.length = 0;
    try {
      result.created += await engine.addTimelineEntriesBatch(snapshot, { auditSite: 'extract.timeline_db' });
    } catch (e) {
      const code = refusalCode(e);
      codes.add(code);
      result.refused += snapshot.length;
      reportRefusal(opts, code, `batch of ${snapshot.length} rows`, e instanceof Error ? e.message : String(e));
    }
  }

  for (const { slug, source_id } of refs) {
    if (managed) {
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: source_id });
      if (!snapshot || (opts.typeFilter && snapshot.page.type !== opts.typeFilter)) continue;
      try {
        const added = await engine.transaction(tx => withCoordinatedWrite(tx, [source_id], async () => {
          await tx.lockPageKeys([{ sourceId: source_id, slug }]);
          const current = await tx.readPageSnapshot(slug, { sourceId: source_id });
          if (current?.revision !== snapshot.revision) return null;
          const fullContent = current.page.compiled_truth + '\n' + current.page.timeline;
          await retractRemovedTimelineEntries(tx, slug, source_id, fullContent);
          let entries: Array<{ date: string; source?: string; summary: string; detail?: string }> = await unrecordedCanonicalTimeline(tx, current.page.id, current.page, slug);
          if (entries.length === 0 && opts.inferDates && parseTimelineEntries(fullContent).length === 0) {
            const anchor = anchorFor(current.page, slug);
            if (anchor) entries = [anchor];
          }
          if (entries.length === 0) return 0;
          return tx.addTimelineEntriesBatch(entries.map(entry => ({ slug, date: entry.date, source: entry.source,
            summary: entry.summary, detail: entry.detail || '', source_id })), { auditSite: 'extract.timeline_db' });
        }));
        if (added === null) result.skipped++;
        else { result.created += added; result.pages++; }
      } catch (e) {
        const code = refusalCode(e);
        codes.add(code);
        result.refused++;
        reportRefusal(opts, code, `${source_id}:${slug}`, e instanceof Error ? e.message : String(e));
      }
      progress.tick(1);
      continue;
    }

    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    if (opts.typeFilter && page.type !== opts.typeFilter) continue;
    const fullContent = page.compiled_truth + '\n' + page.timeline;
    if (!opts.dryRun) await retractRemovedTimelineEntries(engine, slug, source_id, fullContent);
    let entries = parseTimelineEntries(fullContent);
    // --infer-dates: pages with no in-body timeline line but a trustworthy
    // content date (frontmatter / filename) get one anchor entry at that date.
    if (entries.length === 0 && opts.inferDates) {
      const anchor = anchorFor(page, slug);
      if (anchor) entries = [anchor];
    }
    for (const entry of entries) {
      if (dryRunSeen) {
        const key = `${source_id}::${slug}::${entry.date}::${entry.summary}`;
        if (dryRunSeen.has(key)) continue;
        dryRunSeen.add(key);
        if (opts.jsonMode) {
          process.stdout.write(JSON.stringify({
            action: 'add_timeline', slug, source_id, date: entry.date,
            summary: entry.summary, ...(entry.detail ? { detail: entry.detail } : {}),
          }) + '\n');
        } else if (!opts.quiet) {
          console.log(`  ${slug}: ${entry.date} — ${entry.summary}`);
        }
        result.created++;
      } else {
        batch.push({ slug, date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail || '', source_id });
        if (batch.length >= BATCH_SIZE) await flush();
      }
    }
    result.pages++;
    progress.tick(1);
  }
  await flush();
  progress.finish();
  result.refusal_codes = [...codes];

  if (!opts.jsonMode && !opts.quiet) {
    const label = opts.dryRun ? '(dry run) would create' : 'created';
    console.log(`Timeline: ${label} ${result.created} entries from ${result.pages} pages (db source)` +
      (result.skipped ? `; ${result.skipped} page(s) changed during the run were left for the next run` : ''));
  }
  if (result.refused > 0) {
    const unit = managed ? 'page(s)' : 'row(s)';
    console.error(
      `[extract timeline] refused: ${result.refusal_codes.join(', ')}; ${result.refused} ${unit} not written, ${result.created} written. ` +
      `Existing timeline rows are untouched (import already stored the rows of each page it wrote). ` +
      `Recovery: gbrain extract --stale${opts.sourceIdFilter ? ` --source-id ${opts.sourceIdFilter}` : ''}. Docs: ${TIMELINE_REFUSAL_DOCS}`,
    );
  }
  return result;
}
