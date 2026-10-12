/**
 * Owner phrases, read-only: derive the windows and links the pass would store
 * for one source without writing anything, and draw a reproducible labeling
 * sample of those links for the precision check (docs/guides/owner-phrases.md,
 * "Precision sample").
 *
 * `deriveOwnerPhraseLinks` scans every live page in memory with the same
 * scanner, statement grammar, window assembly and resolution as the pass, then
 * drops the pairs the pass would not store (a pair another link already
 * covers) and keeps one link per page pair, exactly as the pass does. It reads
 * pages, links, aliases and config only. Callers that need a guarantee run it
 * inside a read-only transaction (scripts/owner-phrase-sample.ts does).
 *
 * Sampling rule v1, fixed before any sample is drawn: the population is every
 * derived link, one per (document, account page); each is ranked by
 * sha256("owner-phrase-sample-v1", seed, document slug, account slug) and the
 * first n are taken (all of them when fewer than n exist). The same brain and
 * seed always give the same sample. Fewer than SAMPLE_MIN_POPULATION links is a
 * refusal: the precision bar cannot be met or missed on so few.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import { buildGazetteer } from '../../by-mention.ts';
import { linkableTypesFor, loadSourcePack, readMentionPolicy } from '../policy.ts';
import { scanPage } from './scan.ts';
import { buildOwnerPhraseModel, type OwnerPhraseState } from './pass.ts';

export const SAMPLE_RULE = 'owner-phrase-sample-v1';
export const SAMPLE_MIN_POPULATION = 22;
export const SAMPLE_DEFAULT_SIZE = 100;
const SCAN_BATCH = 1000;
const EXCERPT_MAX = 300;

export interface DerivedLink {
  doc: string;
  account: string;
  phrase: string;
  line: number;
  /** Owner and inclusive bounds of each window the phrase resolved through. */
  windows: Array<{ owner: string; from: string | null; to: string | null }>;
  /** Evidence pages of those windows with their lines. */
  evidence: Array<{ slug: string; line: number }>;
}

export interface Derivation { links: DerivedLink[]; windows: number; pages: number; unresolved: number; ambiguous: number }

/** The links the owner-phrase pass would store for `sourceId`, derived without writes. */
export async function deriveOwnerPhraseLinks(engine: BrainEngine, sourceId: string): Promise<Derivation> {
  const policy = await readMentionPolicy(engine);
  const pack = await loadSourcePack(engine, sourceId, { strict: true });
  const gazetteer = await buildGazetteer(engine, { policy, strict: true });
  const states: OwnerPhraseState[] = [];
  let after = 0;
  let pages = 0;
  for (;;) {
    const rows = await engine.executeRaw<{ id: number; slug: string; type: string | null; title: string | null; compiled_truth: string | null;
      timeline: string | null; frontmatter: unknown; effective_date: unknown; effective_date_source: string | null }>(
      `SELECT id, slug, type, title, compiled_truth, timeline, frontmatter, effective_date, effective_date_source FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND id > $2 ORDER BY id LIMIT $3`, [sourceId, after, SCAN_BATCH]);
    if (!rows.length) break;
    after = Number(rows[rows.length - 1]!.id);
    pages += rows.length;
    for (const p of rows) {
      const frontmatter = (typeof p.frontmatter === 'string' ? JSON.parse(p.frontmatter) : p.frontmatter) as Record<string, unknown> | null;
      const scan = scanPage({ ...p, frontmatter });
      if (!scan.cues.length && !scan.hits.length && !scan.descriptors.length) continue;
      states.push({ page_id: Number(p.id), slug: p.slug, page_date: scan.date, readings: scan.readings, agent: scan.agent,
        cues: scan.cues, descriptors: scan.descriptors, hits: scan.hits });
    }
  }
  const model = await buildOwnerPhraseModel(engine, { sourceId, gazetteer, types: linkableTypesFor(pack, policy), pack, policy }, states);
  const fromIds = [...new Set(model.links.map(l => l.from_id))];
  const covered = new Set(fromIds.length ? (await engine.executeRaw<{ f: number; t: string }>(
    `SELECT l.from_page_id AS f, t.slug AS t FROM links l JOIN pages t ON t.id = l.to_page_id
      WHERE l.from_page_id = ANY($1::int[]) AND t.source_id = $2 AND l.link_kind IS DISTINCT FROM 'owner_phrase'`, [fromIds, sourceId]))
    .map(r => `${r.f}\0${r.t}`) : []);
  const slugById = new Map(states.map(s => [s.page_id, s.slug]));
  const seen = new Set<string>();
  const links: DerivedLink[] = [];
  for (const l of model.links) {
    const key = `${l.from_id}\0${l.to_slug}`;
    if (covered.has(key) || seen.has(key)) continue;
    seen.add(key);
    const windows = l.windows.filter(w => w.accounts.includes(l.to_slug) || w.group === l.to_slug);
    const shown = windows.length ? windows : l.windows;
    links.push({
      doc: l.from_slug, account: l.to_slug, phrase: l.context, line: l.line,
      windows: shown.map(w => ({ owner: w.ownerName, from: w.from, to: w.to })),
      evidence: [...new Map(shown.flatMap(w => w.evidence).map(e => [`${e.page_id}:${e.line}`, { slug: slugById.get(e.page_id) ?? e.slug, line: e.line }])).values()],
    });
  }
  links.sort((a, b) => a.doc.localeCompare(b.doc) || a.account.localeCompare(b.account));
  return { links, windows: model.windows.length, pages, unresolved: model.counters.unresolved, ambiguous: model.counters.ambiguous };
}

/** Rule v1: rank by sha256(rule, seed, doc, account), take the first n. */
export function sampleLinks(links: DerivedLink[], seed: string, n: number): DerivedLink[] {
  const rank = (l: DerivedLink) => createHash('sha256').update([SAMPLE_RULE, seed, l.doc, l.account].join('\0')).digest('hex');
  return links.map(l => ({ l, r: rank(l) })).sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0)).slice(0, n).map(x => x.l);
}

/** The line a phrase sits on (line 0 is the title), cut to EXCERPT_MAX characters. */
export function lineExcerpt(page: { title: string | null; compiled_truth: string | null; timeline: string | null }, line: number): string {
  if (line === 0) return (page.title ?? '').slice(0, EXCERPT_MAX);
  const lines = `${page.compiled_truth ?? ''}${page.timeline ? `\n${page.timeline}` : ''}`.split('\n');
  return (lines[line - 1] ?? '').trim().slice(0, EXCERPT_MAX);
}

export const TSV_COLUMNS = ['id', 'doc_slug', 'phrase', 'line_excerpt', 'account', 'window', 'evidence_page', 'label'] as const;
const cell = (v: string) => v.replace(/[\t\r\n]+/g, ' ');

export function toTsv(rows: Array<DerivedLink & { excerpt: string }>): string {
  const body = rows.map((r, i) => [String(i + 1), r.doc, r.phrase, r.excerpt, r.account,
    r.windows.map(w => `${w.owner} ${w.from ?? '?'}..${w.to ?? 'open'}`).join('; '),
    r.evidence.map(e => `${e.slug}#L${e.line}`).join('; '), ''].map(cell).join('\t'));
  return [TSV_COLUMNS.join('\t'), ...body].join('\n') + '\n';
}

/** Wilson score interval lower bound at 95% (z = 1.96). */
export function wilsonLower(correct: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96;
  const p = correct / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
}

/** Counts of a labeled TSV (`label` column: y / n; anything else is unlabeled). */
export function scoreLabels(tsv: string): { labeled: number; correct: number; wrong: number; unlabeled: number; wilson_lower_95: number } {
  const [head, ...rows] = tsv.split('\n').filter(l => l.trim());
  const at = head!.split('\t').indexOf('label');
  if (at < 0) throw new Error('the TSV has no label column');
  let correct = 0; let wrong = 0; let unlabeled = 0;
  for (const r of rows) {
    const v = (r.split('\t')[at] ?? '').trim().toLowerCase();
    if (v === 'y' || v === 'yes' || v === '1') correct++;
    else if (v === 'n' || v === 'no' || v === '0') wrong++;
    else unlabeled++;
  }
  const labeled = correct + wrong;
  return { labeled, correct, wrong, unlabeled, wilson_lower_95: Number(wilsonLower(correct, labeled).toFixed(4)) };
}
