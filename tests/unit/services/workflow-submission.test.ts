import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowService, SubmissionError } from '../../../src/services/workflow.service.js';
import { HandlerRegistry } from '../../../src/engine/handler-registry.js';
import { WorkflowRepository } from '../../../src/repositories/workflow.repository.js';
import { TaskRepository } from '../../../src/repositories/task.repository.js';
import type { WorkflowDefinition } from '../../../src/interfaces/workflow.js';
import type pg from 'pg';

function createMockPool() {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(mockClient),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as pg.Pool;
  return { pool, mockClient };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as import('fastify').FastifyBaseLogger;
}

function buildService(pool: pg.Pool) {
  const registry = new HandlerRegistry();
  registry.register('noop', async () => {});
  registry.register('echo', async () => {});
  registry.register('slow', async () => {});
  registry.register('fail-once', async () => {});

  const taskRepo = new TaskRepository(pool);
  const workflowRepo = new WorkflowRepository(pool);
  const logger = createMockLogger();

  return new WorkflowService(pool, taskRepo, workflowRepo, registry, logger);
}

describe('WorkflowService.submitWorkflow', () => {
  let pool: pg.Pool;
  let mockClient: ReturnType<typeof createMockPool>['mockClient'];
  let service: WorkflowService;

  beforeEach(() => {
    const mocks = createMockPool();
    pool = mocks.pool;
    mockClient = mocks.mockClient;
    service = buildService(pool);

    let idCounter = 0;
    mockClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('RETURNING id')) {
        idCounter++;
        return { rows: [{ id: `uuid-${idCounter}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it('valid 3-task chain A -> B -> C: returns workflowId, A is READY, B and C are PENDING', async () => {
    const definition: WorkflowDefinition = {
      tasks: [
        { id: 'A', handler: 'noop' },
        { id: 'B', handler: 'noop', dependsOn: ['A'] },
        { id: 'C', handler: 'noop', dependsOn: ['B'] },
      ],
    };

    const result = await service.submitWorkflow(definition);
    expect(result.workflowId).toBeDefined();
    expect(typeof result.workflowId).toBe('string');

    const insertCalls = mockClient.query.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO tasks'),
    );
    expect(insertCalls.length).toBe(3);

    const pendingDepsArgs = insertCalls.map((call: unknown[]) => (call[1] as unknown[])?.[10]);
    expect(pendingDepsArgs).toEqual([0, 1, 1]);
  });

  it('diamond DAG A -> B,C -> D: A is READY, D has pending_deps=2', async () => {
    const definition: WorkflowDefinition = {
      tasks: [
        { id: 'A', handler: 'noop' },
        { id: 'B', handler: 'noop', dependsOn: ['A'] },
        { id: 'C', handler: 'noop', dependsOn: ['A'] },
        { id: 'D', handler: 'noop', dependsOn: ['B', 'C'] },
      ],
    };

    const result = await service.submitWorkflow(definition);
    expect(result.workflowId).toBeDefined();

    const insertCalls = mockClient.query.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO tasks'),
    );
    const pendingDepsArgs = insertCalls.map((call: unknown[]) => (call[1] as unknown[])?.[10]);
    expect(pendingDepsArgs[0]).toBe(0); // A
    expect(pendingDepsArgs[1]).toBe(1); // B
    expect(pendingDepsArgs[2]).toBe(1); // C
    expect(pendingDepsArgs[3]).toBe(2); // D
  });

  it('cycle A -> B -> A: returns 422 with cycle path in error message', async () => {
    const definition: WorkflowDefinition = {
      tasks: [
        { id: 'A', handler: 'noop', dependsOn: ['B'] },
        { id: 'B', handler: 'noop', dependsOn: ['A'] },
      ],
    };

    try {
      await service.submitWorkflow(definition);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SubmissionError);
      expect((err as SubmissionError).statusCode).toBe(422);
      expect((err as SubmissionError).message).toContain('Cycle detected');
    }
  });

  it('self-loop A -> A: returns 422', async () => {
    const definition: WorkflowDefinition = {
      tasks: [{ id: 'A', handler: 'noop', dependsOn: ['A'] }],
    };

    try {
      await service.submitWorkflow(definition);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SubmissionError);
      expect((err as SubmissionError).statusCode).toBe(422);
      expect((err as SubmissionError).message).toContain('Cycle detected');
    }
  });

  it('unknown handler: returns 422 with handler name in error', async () => {
    const definition: WorkflowDefinition = {
      tasks: [{ id: 'A', handler: 'nonexistent-handler' }],
    };

    try {
      await service.submitWorkflow(definition);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SubmissionError);
      expect((err as SubmissionError).statusCode).toBe(422);
      expect((err as SubmissionError).message).toContain('nonexistent-handler');
    }
  });

  it('all tasks have no dependencies: all marked READY immediately', async () => {
    const definition: WorkflowDefinition = {
      tasks: [
        { id: 'A', handler: 'noop' },
        { id: 'B', handler: 'echo' },
        { id: 'C', handler: 'slow' },
      ],
    };

    const result = await service.submitWorkflow(definition);
    expect(result.workflowId).toBeDefined();

    const insertCalls = mockClient.query.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO tasks'),
    );
    const pendingDepsArgs = insertCalls.map((call: unknown[]) => (call[1] as unknown[])?.[10]);
    expect(pendingDepsArgs).toEqual([0, 0, 0]);

    const markReadyCalls = mockClient.query.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' && (call[0] as string).includes("SET status = 'READY'"),
    );
    expect(markReadyCalls.length).toBeGreaterThan(0);
  });

  it('empty tasks array: returns 422', async () => {
    const definition: WorkflowDefinition = {
      tasks: [],
    };

    try {
      await service.submitWorkflow(definition);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SubmissionError);
      expect((err as SubmissionError).statusCode).toBe(422);
    }
  });

  it('duplicate task IDs: returns 422', async () => {
    const definition: WorkflowDefinition = {
      tasks: [
        { id: 'A', handler: 'noop' },
        { id: 'A', handler: 'echo' },
      ],
    };

    try {
      await service.submitWorkflow(definition);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SubmissionError);
      expect((err as SubmissionError).statusCode).toBe(422);
      expect((err as SubmissionError).message).toContain('Duplicate task ID');
    }
  });

  it('transaction is committed on success', async () => {
    const definition: WorkflowDefinition = {
      tasks: [{ id: 'A', handler: 'noop' }],
    };

    await service.submitWorkflow(definition);

    const queryCalls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(queryCalls).toContain('BEGIN');
    expect(queryCalls).toContain('COMMIT');
  });

  it('transaction is rolled back on failure', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO workflows')) {
        throw new Error('DB error');
      }
      return { rows: [], rowCount: 0 };
    });

    const definition: WorkflowDefinition = {
      tasks: [{ id: 'A', handler: 'noop' }],
    };

    await expect(service.submitWorkflow(definition)).rejects.toThrow('DB error');

    const queryCalls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(queryCalls).toContain('BEGIN');
    expect(queryCalls).toContain('ROLLBACK');
  });
});
