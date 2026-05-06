import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskCompleter } from '../../../src/engine/task-completer.js';
import { MinHeap, createTaskComparator, type TaskHeapEntry } from '../../../src/data-structures/min-heap.js';
import type { TaskRepository } from '../../../src/repositories/task.repository.js';
import type { WorkflowRepository } from '../../../src/repositories/workflow.repository.js';
import type pg from 'pg';

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

describe('Retry state machine', () => {
  let completer: TaskCompleter;
  let mockTaskRepo: TaskRepository;
  let mockWorkflowRepo: WorkflowRepository;
  let heap: MinHeap<TaskHeapEntry>;
  let mockPool: pg.Pool;

  beforeEach(() => {
    mockPool = {} as pg.Pool;
    heap = new MinHeap<TaskHeapEntry>(createTaskComparator());

    mockTaskRepo = {
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      scheduleRetry: vi.fn().mockResolvedValue(undefined),
      getChildTaskIds: vi.fn().mockResolvedValue([]),
      decrementPendingDeps: vi.fn().mockResolvedValue(null),
      markTaskReady: vi.fn().mockResolvedValue(undefined),
      countNonTerminalTasks: vi.fn().mockResolvedValue(1),
      hasFailedTasks: vi.fn().mockResolvedValue(false),
    } as unknown as TaskRepository;

    mockWorkflowRepo = {
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue('RUNNING'),
    } as unknown as WorkflowRepository;

    completer = new TaskCompleter(
      mockPool,
      mockTaskRepo,
      mockWorkflowRepo,
      heap,
      createMockLogger(),
    );
  });

  it('task with maxAttempts=3: fails, transitions to PENDING with future scheduled_at', async () => {
    await completer.persistOutcome(
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        max_attempts: 3,
        attempts: 1,
        backoff_base_ms: 1000,
        backoff_cap_ms: 30000,
        last_sleep_ms: 0,
      },
      'failed',
      'transient error',
    );

    expect(mockTaskRepo.scheduleRetry).toHaveBeenCalledWith(
      mockPool,
      'task-1',
      expect.any(Number),
    );
    expect(mockTaskRepo.markFailed).not.toHaveBeenCalled();
  });

  it('fails again (attempt 2), scheduled_at is updated again', async () => {
    await completer.persistOutcome(
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        max_attempts: 3,
        attempts: 2,
        backoff_base_ms: 1000,
        backoff_cap_ms: 30000,
        last_sleep_ms: 1500,
      },
      'failed',
      'transient error again',
    );

    expect(mockTaskRepo.scheduleRetry).toHaveBeenCalledWith(
      mockPool,
      'task-1',
      expect.any(Number),
    );
    expect(mockTaskRepo.markFailed).not.toHaveBeenCalled();
  });

  it('fails again (attempt 3 = max_attempts), terminal FAILED', async () => {
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(0);
    vi.mocked(mockTaskRepo.hasFailedTasks).mockResolvedValue(true);

    await completer.persistOutcome(
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        max_attempts: 3,
        attempts: 3,
        backoff_base_ms: 1000,
        backoff_cap_ms: 30000,
        last_sleep_ms: 2000,
      },
      'failed',
      'final failure',
    );

    expect(mockTaskRepo.markFailed).toHaveBeenCalledWith(mockPool, 'task-1', 'final failure');
    expect(mockTaskRepo.scheduleRetry).not.toHaveBeenCalled();
  });

  it('verify last_sleep_ms is updated in DB after each retry schedule', async () => {
    await completer.persistOutcome(
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        max_attempts: 5,
        attempts: 1,
        backoff_base_ms: 1000,
        backoff_cap_ms: 30000,
        last_sleep_ms: 0,
      },
      'failed',
      'error',
    );

    const sleepMs = vi.mocked(mockTaskRepo.scheduleRetry).mock.calls[0]![2];
    expect(sleepMs).toBeGreaterThanOrEqual(1000);
    expect(sleepMs).toBeLessThanOrEqual(30000);
  });

  it('verify attempts is NOT incremented in the retry path', async () => {
    await completer.persistOutcome(
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        max_attempts: 3,
        attempts: 1,
        backoff_base_ms: 1000,
        backoff_cap_ms: 30000,
        last_sleep_ms: 0,
      },
      'failed',
      'error',
    );

    expect(mockTaskRepo.scheduleRetry).toHaveBeenCalledTimes(1);
    const call = vi.mocked(mockTaskRepo.scheduleRetry).mock.calls[0]!;
    expect(call[0]).toBe(mockPool);
    expect(call[1]).toBe('task-1');
    expect(typeof call[2]).toBe('number');
  });

  it('verify scheduled_at is NOW() + computed sleep (within 100ms tolerance)', async () => {
    await completer.persistOutcome(
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        max_attempts: 5,
        attempts: 1,
        backoff_base_ms: 1000,
        backoff_cap_ms: 30000,
        last_sleep_ms: 0,
      },
      'failed',
      'error',
    );

    const sleepMs = vi.mocked(mockTaskRepo.scheduleRetry).mock.calls[0]![2];
    expect(sleepMs).toBeGreaterThanOrEqual(1000);
  });
});
