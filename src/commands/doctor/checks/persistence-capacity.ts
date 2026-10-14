import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { oneYearCapacity } from '../../../core/persistence/limits.ts';
import { CUMULATIVE_RESOURCES, capacityVerify, readCapacityView } from '../../../core/persistence/capacity-view.ts';

/**
 * #5470: warn at 80% of a cumulative managed-write cap (permanent request IDs,
 * receipt bytes) before admission refuses. Transient caps drain on their own.
 * Bounded: one indexed read per counter row (brain plus each principal), through
 * the capacity view the ops tier and `get_brain_health` share (#6696).
 */
export async function checkPersistenceCapacity(engine: BrainEngine): Promise<Check> {
  try {
    const view = await readCapacityView(engine);
    const near = view.rows.filter(row => row.approaching_capacity && CUMULATIVE_RESOURCES.has(row.resource));
    const resources = [];
    const needed = new Map<string, number>();
    for (const row of near) {
      const value = await oneYearCapacity(engine, row.scope, row.resource === 'lifetime_ids' ? 'LifetimeIds' : 'TerminalBytes', row.used, row.limit);
      resources.push({ scope: row.scope, resource: row.resource, used: row.used, limit: row.limit, config_key: row.config_key });
      needed.set(row.config_key, Math.max(needed.get(row.config_key) ?? 0, value));
    }
    // Every principal shares one brain-wide key, so each key gets the largest value any scope needs.
    const commands = [...needed].map(([key, value]) => `gbrain config set ${key} ${value}`);
    const details = { exact: true, inspected: view.counters_read, truncated: false, resources, commands, ...(view.forecast ? { forecast: view.forecast } : {}) };
    if (!resources.length) return { name: 'persistence_capacity', status: 'ok', message: 'Managed write capacity is below 80% of every cumulative limit.', details };
    const [key, value] = [...needed][0]!;
    return { name: 'persistence_capacity', status: 'warn', details,
      fix: { argv: ['gbrain', 'config', 'set', key, String(value)], consent: [], actor: 'host_admin', requires_exclusive: false, verify: capacityVerify(),
        why: 'Raises the limit on the brain host (reversible with gbrain config unset); admission refuses writes at the limit.', docs: 'docs/guides/concurrent-writes.md' },
      message: `${resources.length} managed write limit(s) at or above 80%: ${resources.map(r =>
        `${r.scope} ${r.resource} ${r.used}/${r.limit}`).join('; ')}. Admission refuses at the limit. Run on the brain host: ${commands.join('; ')} ` +
        '(each covers about one more year at the current admission rate). This is a mitigation: permanent request IDs are never evicted.' };
  } catch (error) {
    return { name: 'persistence_capacity', status: 'warn',
      message: `Managed write capacity could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { exact: false, inspected: 0, truncated: true, health: 'unknown' } };
  }
}
