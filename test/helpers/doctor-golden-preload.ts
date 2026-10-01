/**
 * CLI-child-only fixture: pin the source checkout used by eval_drift while
 * retaining its real Git probe. cwd isolation is insufficient because that
 * check deliberately resolves the checkout from its own module location.
 * Production root resolution and dirty-tree behavior have dedicated tests.
 */
import './no-network-preload.ts';
import { mock } from 'bun:test';

const sourceRoot = process.env.GBRAIN_TEST_DOCTOR_SOURCE_ROOT;
if (!sourceRoot) throw new Error('doctor golden requires its isolated source fixture');
const real = await import('../../src/core/eval/drift-watch.ts');
mock.module('../../src/core/eval/drift-watch.ts', () => ({
  ...real,
  resolveGbrainSourceRoot: () => sourceRoot,
}));
