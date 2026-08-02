import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

function localContext(): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console as OperationContext['logger'],
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

function dryRunContext(): OperationContext {
  return { ...localContext(), dryRun: true };
}

describe('run_dream local MCP operation', () => {
  test('is a local-only admin mutation and stays off the HTTP MCP surface', () => {
    const op = operationsByName.run_dream;
    expect(op).toBeDefined();
    expect(op.scope).toBe('admin');
    expect(op.mutating).toBe(true);
    expect(op.localOnly).toBe(true);
    expect(operationsByName.run_dream.params.phase.required).toBe(true);
  });

  test('runs one selected DB-only phase in-process on the already-open engine', async () => {
    const report = await operationsByName.run_dream.handler(localContext(), {
      phase: 'orphans',
      dry_run: true,
    }) as {
      status: string;
      phases: Array<{ phase: string; status: string }>;
    };

    expect(report.status).not.toBe('failed');
    expect(report.phases.map((phase) => phase.phase)).toEqual(['orphans']);
  });

  test('rejects unknown phases before invoking the cycle', async () => {
    await expect(
      operationsByName.run_dream.handler(localContext(), { phase: 'not-a-phase' }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('honors the operation-context dry-run guard', async () => {
    const report = await operationsByName.run_dream.handler(dryRunContext(), {
      phase: 'orphans',
    }) as { phases: Array<{ phase: string; status: string }> };

    expect(report.phases.map((phase) => phase.phase)).toEqual(['orphans']);
  });
});
