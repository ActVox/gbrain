/** ActVox policy for prioritizing canonical operational memory. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { PageRegexBudget } from '../schema-pack/redos-guard.ts';
import { structuralExactLookup, type ExactLookupOpts } from './exact-lookup.ts';
import { pageReadFilter } from './read-policy-sql.ts';

interface OperationalMemoryPolicyConfig {
  intent_patterns?: string[];
  raw_source_patterns?: string[];
  canonical_rules?: Array<{ pattern: string; slugs: string[] }>;
  boost_types?: Record<string, number>;
  boost_prefixes?: Record<string, number>;
  demote_prefixes?: Record<string, number>;
}

const DEFAULT_OPERATIONAL_MEMORY_POLICY: Required<OperationalMemoryPolicyConfig> = {
  intent_patterns: [
    '\\b(what\\s+now|next\\s+action|current\\s+actions?|status|today\\s+rail|command\\s+center|task\\s+trust|operational\\s+state|canonical\\s+pages?|retrieval\\s+policy|memory\\s+operating\\s+contract|eval\\s+suite)\\b',
  ],
  raw_source_patterns: [
    '\\b(raw|transcript|exact\\s+wording|what\\s+did\\s+.*say|meeting\\s+transcript|source\\s+audit|provenance)\\b',
  ],
  canonical_rules: [
    {
      pattern: 'memory|retrieval|canonical|eval\\s+suite|operating\\s+contract|policy',
      slugs: [
        'ops/memory-operating-contract',
        'ops/retrieval-policy',
        'ops/canonical-page-registry',
        'ops/retrieval-eval-suite',
      ],
    },
  ],
  boost_types: {
    'synthesized-action-page': 2.4,
    'task-list': 2.4,
    'health-context': 1.9,
    'retrieval-policy': 2.0,
    'canonical-page-registry': 2.0,
    'retrieval-eval-suite': 2.0,
    'memory-system-contract': 2.0,
    'graph-index': 1.25,
  },
  boost_prefixes: {
    'ops/current': 1.8,
    'ops/tasks': 1.8,
    'health/current-': 1.8,
  },
  demote_prefixes: {
    'meetings/circleback/': 0.35,
    'dream-cycle-summaries/': 0.25,
    'wiki/personal/reflections/': 0.55,
    'wiki/originals/ideas/': 0.55,
  },
};

let operationalMemoryPolicyCache: { key: string; policy: Required<OperationalMemoryPolicyConfig> } | null = null;

function mergeOperationalMemoryPolicy(input?: OperationalMemoryPolicyConfig | null): Required<OperationalMemoryPolicyConfig> {
  if (!input || typeof input !== 'object') return DEFAULT_OPERATIONAL_MEMORY_POLICY;
  return {
    intent_patterns: [
      ...DEFAULT_OPERATIONAL_MEMORY_POLICY.intent_patterns,
      ...(Array.isArray(input.intent_patterns) ? input.intent_patterns : []),
    ],
    raw_source_patterns: [
      ...DEFAULT_OPERATIONAL_MEMORY_POLICY.raw_source_patterns,
      ...(Array.isArray(input.raw_source_patterns) ? input.raw_source_patterns : []),
    ],
    canonical_rules: [
      ...DEFAULT_OPERATIONAL_MEMORY_POLICY.canonical_rules,
      ...(Array.isArray(input.canonical_rules) ? input.canonical_rules : []),
    ],
    boost_types: { ...DEFAULT_OPERATIONAL_MEMORY_POLICY.boost_types, ...(input.boost_types ?? {}) },
    boost_prefixes: { ...DEFAULT_OPERATIONAL_MEMORY_POLICY.boost_prefixes, ...(input.boost_prefixes ?? {}) },
    demote_prefixes: { ...DEFAULT_OPERATIONAL_MEMORY_POLICY.demote_prefixes, ...(input.demote_prefixes ?? {}) },
  };
}

function loadOperationalMemoryPolicy(): Required<OperationalMemoryPolicyConfig> {
  const envJson = process.env.GBRAIN_OPERATIONAL_MEMORY_POLICY_JSON;
  const envPath = process.env.GBRAIN_OPERATIONAL_MEMORY_POLICY;
  const homePath = process.env.GBRAIN_HOME
    ? join(process.env.GBRAIN_HOME, '.gbrain', 'operational-memory-policy.json')
    : '';
  const key = envJson ? `json:${envJson}` : `file:${envPath || homePath}`;
  if (operationalMemoryPolicyCache?.key === key) return operationalMemoryPolicyCache.policy;
  let parsed: OperationalMemoryPolicyConfig | null = null;
  try {
    if (envJson) {
      parsed = JSON.parse(envJson) as OperationalMemoryPolicyConfig;
    } else {
      const path = envPath || homePath;
      if (path && existsSync(path)) {
        parsed = JSON.parse(readFileSync(path, 'utf8')) as OperationalMemoryPolicyConfig;
      }
    }
  } catch {
    parsed = null;
  }
  const policy = mergeOperationalMemoryPolicy(parsed);
  operationalMemoryPolicyCache = { key, policy };
  return policy;
}

function matchesAnyPattern(query: string, patterns: string[]): boolean {
  const budget = new PageRegexBudget();
  return patterns.some((pattern, index) => Boolean(
    budget.runBounded(`operational-memory-${index}`, pattern, query, 'i'),
  ));
}

function isOperationalMemoryQuery(query?: string): boolean {
  if (!query) return false;
  const policy = loadOperationalMemoryPolicy();
  return matchesAnyPattern(query, policy.intent_patterns) && !matchesAnyPattern(query, policy.raw_source_patterns);
}

function canonicalOperationalSlugsForQuery(query?: string): string[] {
  if (!query || !isOperationalMemoryQuery(query)) return [];
  const policy = loadOperationalMemoryPolicy();
  const slugs = new Set<string>();
  const budget = new PageRegexBudget();
  for (const [index, rule] of policy.canonical_rules.entries()) {
    const matched = Boolean(
      budget.runBounded(`operational-canonical-${index}`, rule.pattern, query, 'i'),
    );
    if (matched) {
      for (const slug of rule.slugs) slugs.add(slug);
    }
  }
  return [...slugs];
}

function operationalMemoryFactor(r: SearchResult, query?: string): number {
  if (!isOperationalMemoryQuery(query)) return 1.0;
  const policy = loadOperationalMemoryPolicy();
  let factor = policy.boost_types[r.type] ?? 1.0;
  for (const [prefix, boost] of Object.entries(policy.boost_prefixes)) {
    if (r.slug.startsWith(prefix)) factor *= boost;
  }
  for (const [prefix, demotion] of Object.entries(policy.demote_prefixes)) {
    if (r.slug.startsWith(prefix)) factor *= demotion;
  }
  return factor;
}

export function applyOperationalMemoryPolicy(results: SearchResult[], query?: string): void {
  if (!isOperationalMemoryQuery(query)) return;
  for (const r of results) {
    if (!Number.isFinite(r.score)) continue;
    const factor = operationalMemoryFactor(r, query);
    if (factor !== 1.0) {
      r.score *= factor;
      (r as SearchResult & { operational_memory_factor?: number }).operational_memory_factor = factor;
    }
  }
}

async function admittedCanonicalHits(engine: BrainEngine, slugs: string[], opts: ExactLookupOpts): Promise<SearchResult[]> {
  const hits: SearchResult[] = [];
  for (const slug of slugs) hits.push(...await structuralExactLookup(engine, slug, opts));
  if (hits.length === 0) return [];
  const params: unknown[] = [hits.map(hit => hit.page_id)];
  const readFilter = pageReadFilter('p', opts, params, true);
  try {
    // Direct identity lookup permits reviewing archived/quarantined pages.
    // Policy injection is search discovery, so it needs search's live-page gate.
    const admitted = await engine.executeRaw<{ id: number }>(
      `SELECT p.id FROM pages p WHERE p.id = ANY($1::bigint[]) AND ${readFilter}`,
      params,
    );
    const ids = new Set(admitted.map(row => Number(row.id)));
    return hits.filter(hit => ids.has(hit.page_id));
  } catch {
    // Failure to verify eligibility must never inject a hidden page.
    return [];
  }
}

export async function injectCanonicalOperationalResults(
  engine: BrainEngine, results: SearchResult[], query: string | undefined,
  opts: ExactLookupOpts = {},
): Promise<SearchResult[]> {
  if (!isOperationalMemoryQuery(query)) return results;
  const slugs = canonicalOperationalSlugsForQuery(query);
  const out = [...results];
  // The incoming order already includes the reranker and identity/relational
  // pins. RRF scores are a different signal and cannot reconstruct that order.
  const policyRanks = new Map(out.map((row, index) => [row, index + 1]));
  const existing = new Map(out.map(r => [`${r.source_id ?? 'default'}::${r.slug}`, r]));
  const topScore = out.reduce((m, r) => Number.isFinite(r.score) && r.score > m ? r.score : m, 0.1);
  let rank = 0;
  // Source/private/type/prefix and supersession gates precede live search admission.
  for (const hit of await admittedCanonicalHits(engine, slugs, opts)) {
    const key = `${hit.source_id ?? 'default'}::${hit.slug}`;
    const promotion = 1.2 - Math.min(rank++, 10) * 0.01;
    const score = topScore * promotion;
    const already = existing.get(key);
    if (already) {
      already.score = Math.max(already.score, score);
      policyRanks.set(already, Math.min(policyRanks.get(already)!, 1 / promotion));
      continue;
    }
    // A policy-selected page is not an exact match to the user's query.
    const { alias_hit, exact_lookup, ...candidate } = hit;
    const row = { ...candidate, score, base_score: score };
    out.push(row);
    policyRanks.set(row, 1 / promotion);
    existing.set(key, row);
  }
  applyOperationalMemoryPolicy(out, query);
  const incomingOrder = new Map(out.map((row, index) => [row, index]));
  const pinned = (row: SearchResult) => row.alias_hit === true || row.exact_lookup !== undefined || row.relational_pinned === true;
  const adjustedRank = (row: SearchResult) => {
    const factor = (row as SearchResult & { operational_memory_factor?: number }).operational_memory_factor ?? 1;
    return policyRanks.get(row)! / (Number.isFinite(factor) && factor > 0 ? factor : 1);
  };
  out.sort((a, b) => {
    const aPinned = pinned(a), bPinned = pinned(b);
    if (aPinned || bPinned) return Number(bPinned) - Number(aPinned) || incomingOrder.get(a)! - incomingOrder.get(b)!;
    // Weight the current rank, so unchanged rows retain upstream order while
    // explicit operational boosts/demotions can move their selected rows.
    return adjustedRank(a) - adjustedRank(b);
  });
  return out;
}
