/**
 * Owner-phrase links never take part in ranking. Readers that exclude
 * `link_source='mentions'` already skip them; the ranking readers that count
 * every link (adjacency boosts, entity anchoring, generated-page demotion)
 * add this predicate, so a brain's final scores are the same with
 * `mentions.owner_phrases` on or off. Plain mention behavior is unchanged.
 */
export function rankingLinkSql(linkAlias: string): string {
  return `${linkAlias}.link_kind IS DISTINCT FROM 'owner_phrase'`;
}
