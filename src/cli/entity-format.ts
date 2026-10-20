/**
 * Human rendering of the `entity` verb (`gbrain entity <name>`); `--json`
 * returns the raw envelope instead. Kept out of cli/main.ts (module-size
 * ratchet), like remember-format.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- renders the verb's JSON envelope */
export function formatEntityResult(r: any): string {
  if (!r.found) {
    const coverage = r.coverage && r.coverage.state !== 'complete' ? ` Mention coverage: ${r.coverage.state}, ${r.coverage.pending_pages} page(s) pending.` : '';
    const tm = r.text_mentions;
    const lines = tm?.total
      ? [`No entity page. The name appears in the text of ${tm.total}${tm.capped ? '+' : ''} page(s) (unlinked text matches). (${r.latency_ms}ms)${coverage}`,
        ...tm.pages.map((p: any) => `  ${p.date ?? '          '}  ${p.slug} — ${p.title}`)]
      : [`No entity found. (${r.latency_ms}ms)${coverage}${tm?.unread ? ` Text matches not checked (${tm.unread}); search the name with gbrain search.` : ''}`];
    if (Array.isArray(r.suggestions) && r.suggestions.length) {
      lines.push(r.ambiguous ? 'Several entities match this name; pick one:' : 'Did you mean:');
      for (const s of r.suggestions) lines.push(`  ${s.slug} — ${s.title} [${s.create_safety}]`);
    }
    return lines.join('\n') + '\n';
  }
  const c = r.card;
  const lines = [`${c.entity.title} (${c.entity.slug})${c.entity.type ? ` [${c.entity.type}]` : ''}  (${r.latency_ms}ms)`];
  if (c.match) lines.push(`  matched "${c.match.via}" as a name variant (${c.match.kind}); check the page before relying on it`);
  if (c.summary) lines.push(`  ${c.summary}`);
  if (c.aka?.length) lines.push(`  aka: ${c.aka.join(', ')}`);
  const lt = c.last_touched || {};
  const touched = lt.updated_at || lt.last_retrieved_at || lt.last_timeline_date;
  if (touched) lines.push(`  last touched: ${String(touched).slice(0, 10)}`);
  if (c.open_threads?.length) {
    lines.push('  open threads:');
    for (const t of c.open_threads) lines.push(`    [${t.kind}] ${t.text}${t.date ? ` (${String(t.date).slice(0, 10)})` : ''}`);
  }
  if (c.edges?.length) {
    lines.push('  edges:');
    for (const e of c.edges) lines.push(`    ${e.direction === 'out' ? '→' : '←'} ${e.type} ${e.slug}`);
  }
  lines.push(`  backlinks: ${c.backlink_count} | active facts: ${c.active_fact_count}`);
  if (c.referenced_by_count) lines.push(`  referenced by ${c.referenced_by_count} page(s):`, ...c.referenced_by.map((g: any) => `    ${g.canonical_type} (${g.total}): ${g.rows.map((x: any) => x.slug).join(', ')}${g.next ? ', ...' : ''}`));
  if (c.coverage && c.coverage.state !== 'complete') lines.push(`  mention coverage: ${c.coverage.state}, ${c.coverage.pending_pages} page(s) pending`);
  if (c.text_mentions?.total) {
    lines.push(`  the name appears in the text of ${c.text_mentions.total}${c.text_mentions.capped ? '+' : ''} other page(s) (unlinked text matches, newest first):`);
    for (const p of c.text_mentions.pages) lines.push(`    ${p.date ?? '          '}  ${p.slug} — ${p.title}`);
  }
  if (c.possible_duplicates?.length) {
    lines.push('  possible duplicate pages (title prefix; review, never merged automatically):');
    for (const d of c.possible_duplicates) lines.push(`    ${d.slug} — ${d.title}`);
  }
  if (Array.isArray(r.suggestions) && r.suggestions.length) {
    lines.push('  other matches:');
    for (const s of r.suggestions) lines.push(`    ${s.slug} — ${s.title}`);
  }
  return lines.join('\n') + '\n';
}
