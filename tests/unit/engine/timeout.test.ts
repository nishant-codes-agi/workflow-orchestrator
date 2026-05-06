import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerPool } from '../../../src/engine/worker-pool.js';
import { HandlerRegistry } from '../../../src/engine/handler-registry.js';
import type { TaskRepository } from '../../../src/repositories/task.repository.js';
import type { WorkflowRepository } from '../../../src/repositories/workflow.repository.js';
import type { TaskCompleter } from '../../../src/engine/task-completer.js';
import type { Config } from '../../../src/config.js';
import type pg from 'pg';
import type { TaskHeapEntry } from '../../../src/data-structures/min-heap.js';

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

const defaultConfig: Config = {
  port: 3000,
  databaseUrl: 'postgres://localhost/test',
  workerCount: 3,
  heartbeatIntervalMs: 5000,
  reaperPollMs: 30000,
  leaseTimeoutMs: 15000,
  cronTickMs: 10000,
};

function mockTaskRow(overrides: Partial<{
  id: string;
  workflow_id: string;
  handler_name: string;
  input: unknown;
  timeout_ms: number;
  logical_id: string;
  max_attempts: number;
  attempts: number;
  backoff_base_ms: number;
  backoff_cap_ms: number;
  last_sleep_ms: number;
}> = {}) {
  return {
    id: 'task-1',
    workflow_id: 'wf-1',
    handler_name: 'noop',
    input: {},
    timeout_ms: 30000,
    logical_id: 'A',
    max_attempts: 3,
    attempts: 1,
    backoff_base_ms: 1000,
    backoff_cap_ms: 30000,
    last_sleep_ms: 0,
    ...overrides,
  };
}

describe('Timeout enforcement', () => {
  let registry: HandlerRegistry;
  let mockTaskRepo: TaskRepository;
  let mockWorkflowRepo: WorkflowRepository;
  let mockTaskCompleter: TaskCompleter;
  let mockPool: pg.Pool;

  beforeEach(() => {
    registry = new HandlerRegistry();
    registry.register('noop', async () => {});

    mockTaskRepo = {
      claimTask: vi.fn().mockResolvedValue({ rowCount: 1, attempts: 1 }),
      getTasksByWorkflowId: vi.fn().mockResolvedValue([]),
      updateHeartbeat: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskRepository;

    mockWorkflowRepo = {
      getStatus: vi.fn().mockResolvedValue('RUNNING'),
    } as unknown as WorkflowRepository;

    mockTaskCompleter = {
      persistOutcome: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskCompleter;
  });

  it('task with timeoutMs=100, handler sleeps 500ms: task fails with timeout error', async () => {
    registry.register('sleepy', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [mockTaskRow({ handler_name: 'sleepy', timeout_ms: 100 })],
        rowCount: 1,
      }),
    } as unknown as pg.Pool;

    const workerPool = new WorkerPool(
      registry,
      mockTaskRepo,
      mockWorkflowRepo,
      mockTaskCompleter,
      mockPool,
      defaultConfig,
      createMockLogger(),
    );

    const entry: TaskHeapEntry = {
      taskId: 'task-1',
      priority: 0,
      scheduledAt: Date.now(),
      submissionOrder: 1n,
    };

    await workerPool.executeTask(entry);

    expect(mockTaskCompleter.persistOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      'failed',
      expect.stringContaining('timeout'),
    );
  });

  it('task with timeoutMs=5000, handler completes in 10ms: task succeeds', async () => {
    registry.register('fast', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [mockTaskRow({ handler_name: 'fast', timeout_ms: 5000 })],
        rowCount: 1,
      }),
    } as unknown as pg.Pool;

    const workerPool = new WorkerPool(
      registry,
      mockTaskRepo,
      mockWorkflowRepo,
      mockTaskCompleter,
      mockPool,
      defaultConfig,
      createMockLogger(),
    );

    const entry: TaskHeapEntry = {
      taskId: 'task-1',
      priority: 0,
      scheduledAt: Date.now(),
      submissionOrder: 1n,
    };

    await workerPool.executeTask(entry);

    expect(mockTaskCompleter.persistOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      'completed',
      undefined,
    );
  });

  it('AbortSignal is set when timeout fires (verify signal.aborted === true)', async () => {
    let capturedSignal: AbortSignal | null = null;
    registry.register('signal-checker', async (_input, ctx) => {
      capturedSignal = ctx.signal;
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [mockTaskRow({ handler_name: 'signal-checker', timeout_ms: 50 })],
        rowCount: 1,
      }),
    } as unknown as pg.Pool;

    const workerPool = new WorkerPool(
      registry,
      mockTaskRepo,
      mockWorkflowRepo,
      mockTaskCompleter,
      mockPool,
      defaultConfig,
      createMockLogger(),
    );

    const entry: TaskHeapEntry = {
      taskId: 'task-1',
      priority: 0,
      scheduledAt: Date.now(),
      submissionOrder: 1n,
    };

    await workerPool.executeTask(entry);

    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(true);
  });
});
