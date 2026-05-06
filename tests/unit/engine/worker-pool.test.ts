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

describe('WorkerPool', () => {
  let registry: HandlerRegistry;
  let mockTaskRepo: TaskRepository;
  let mockWorkflowRepo: WorkflowRepository;
  let mockTaskCompleter: TaskCompleter;
  let mockPool: pg.Pool;
  let workerPool: WorkerPool;

  beforeEach(() => {
    registry = new HandlerRegistry();
    registry.register('noop', async () => {});

    mockTaskRepo = {
      claimTask: vi.fn().mockResolvedValue({ rowCount: 1, attempts: 1 }),
      getTasksByWorkflowId: vi.fn().mockResolvedValue([]),
      updateHeartbeat: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      markTaskCancelled: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskRepository;

    mockWorkflowRepo = {
      getStatus: vi.fn().mockResolvedValue('RUNNING'),
    } as unknown as WorkflowRepository;

    mockTaskCompleter = {
      persistOutcome: vi.fn().mockResolvedValue(undefined),
      checkWorkflowTermination: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskCompleter;

    mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: 'task-1',
          workflow_id: 'wf-1',
          handler_name: 'noop',
          input: {},
          timeout_ms: 30000,
          logical_id: 'A',
          max_attempts: 3,
          attempts: 1,
        }],
        rowCount: 1,
      }),
    } as unknown as pg.Pool;

    workerPool = new WorkerPool(
      registry,
      mockTaskRepo,
      mockWorkflowRepo,
      mockTaskCompleter,
      mockPool,
      defaultConfig,
      createMockLogger(),
    );
  });

  it('executes a noop handler and marks task COMPLETED', async () => {
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

  it('CAS guard: if task already claimed, skips execution', async () => {
    vi.mocked(mockTaskRepo.claimTask).mockResolvedValue({ rowCount: 0, attempts: 0 });

    const entry: TaskHeapEntry = {
      taskId: 'task-1',
      priority: 0,
      scheduledAt: Date.now(),
      submissionOrder: 1n,
    };

    await workerPool.executeTask(entry);

    expect(mockTaskCompleter.persistOutcome).not.toHaveBeenCalled();
  });

  it('heartbeat: last_heartbeat_at updates during execution', async () => {
    registry.register('slow-test', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    vi.mocked(mockPool.query).mockResolvedValue({
      rows: [{
        id: 'task-1',
        workflow_id: 'wf-1',
        handler_name: 'slow-test',
        input: {},
        timeout_ms: 30000,
        logical_id: 'A',
        max_attempts: 3,
        attempts: 1,
      }],
      rowCount: 1,
    } as unknown as pg.QueryResult);

    const shortConfig = { ...defaultConfig, heartbeatIntervalMs: 50 };
    const wp = new WorkerPool(
      registry,
      mockTaskRepo,
      mockWorkflowRepo,
      mockTaskCompleter,
      mockPool,
      shortConfig,
      createMockLogger(),
    );

    const entry: TaskHeapEntry = {
      taskId: 'task-1',
      priority: 0,
      scheduledAt: Date.now(),
      submissionOrder: 1n,
    };

    await wp.executeTask(entry);

    expect(mockTaskRepo.updateHeartbeat).toHaveBeenCalled();
  });

  it('handler timeout: slow handler past timeoutMs is rejected, task marked FAILED', async () => {
    registry.register('very-slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });

    vi.mocked(mockPool.query).mockResolvedValue({
      rows: [{
        id: 'task-1',
        workflow_id: 'wf-1',
        handler_name: 'very-slow',
        input: {},
        timeout_ms: 100,
        logical_id: 'A',
        max_attempts: 3,
        attempts: 1,
      }],
      rowCount: 1,
    } as unknown as pg.QueryResult);

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

  it('semaphore limits concurrency', () => {
    expect(workerPool.availablePermits()).toBe(3);
  });

  it('cancelling workflow: task is marked CANCELLED without executing handler', async () => {
    vi.mocked(mockWorkflowRepo.getStatus).mockResolvedValue('CANCELLING');

    const entry: TaskHeapEntry = {
      taskId: 'task-1',
      priority: 0,
      scheduledAt: Date.now(),
      submissionOrder: 1n,
    };

    await workerPool.executeTask(entry);

    expect(mockTaskRepo.markTaskCancelled).toHaveBeenCalledWith(mockPool, 'task-1');
    expect(mockTaskCompleter.persistOutcome).not.toHaveBeenCalled();
    expect(mockTaskCompleter.checkWorkflowTermination).toHaveBeenCalledWith('wf-1');
  });
});
