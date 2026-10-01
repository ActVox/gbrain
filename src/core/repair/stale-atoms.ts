/**
 * `gbrain repair stale-atoms` (#5770): registry stub from the fix wave 5 shared
 * commit. The kind is explicit-only (never run by `--all` or a remediation
 * step) and preview-bound through `persistence/preview-approval.ts`. Until its
 * lane replaces this handler, every preview and apply refuses.
 */
import { catalogueError } from '../error-catalogue.ts';
import type { RepairHandler } from './core.ts';

function notBuilt(): never {
  throw catalogueError('repair_kind_unavailable', 'gbrain repair stale-atoms is not implemented in this build.',
    'Upgrade on the brain host, then preview again: gbrain upgrade && gbrain repair stale-atoms');
}

export const staleAtomsRepair: RepairHandler = {
  kind: 'stale-atoms',
  plan: async () => notBuilt(),
  apply: async () => notBuilt(),
};
