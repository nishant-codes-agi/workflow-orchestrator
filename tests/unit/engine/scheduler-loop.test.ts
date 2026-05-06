import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulerLoop } from '../../../src/engine/scheduler-loop.js';
import type { TaskRepository } from '../../../src/repositories/task.repository.js';
import type { WorkerPool } from '../../../src/engine/worker-pool.js';
import type pg from 'pg';
import type { Task } from '../../../src/interfaces/task.js';

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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    logical_id: 'A',
    workflow_id: 'wf-1',
    handler_name: 'noop',
    input: {},
    status: 'READY',
    priority: 0,
    scheduled_at: new Date(),
    submission_order: 1n,
    attempts: 0,
    max_attempts: 3,
    backoff_base_ms: 1000,
    backoff_cap_ms: 30000,
    last_sleep_ms: 0,
    timeout_ms: 30000,
    pending_deps: 0,
    last_heartbeat_at: null,
    error: null,
    completed_at: null,
    ...overrides,
  };
}

describe('SchedulerLoop', () => {
  let scheduler: SchedulerLoop;
  let mockTaskRepo: TaskRepository;
  let mockPool: pg.Pool;
  let mockWorkerPool: WorkerPool;

  beforeEach(() => {
    mockPool = {} as pg.Pool;
    mockTaskRepo = {
      getReadyTasks: vi.fn().mockResolvedValue([]),
      getReadyTasksWithSchedule: vi.fn().mockResolvedValue([]),
      markTaskReady: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskRepository;
    mockWorkerPool = {
      executeTask: vi.fn().mockResolvedValue(undefined),
      availablePermits: vi.fn().mockReturnValue(10),
    } as unknown as WorkerPool;

    scheduler = new SchedulerLoop(mockPool, mockTaskRepo, createMockLogger(), 100);
    scheduler.setWorkerPool(mockWorkerPool);
  });

  it('loads READY tasks from DB into heap on startup', async () => {
    const tasks = [
      makeTask({ id: 'task-1', priority: 5, submission_order: 1n }),
      makeTask({ id: 'task-2', priority: 10, submission_order: 2n }),
    ];
    vi.mocked(mockTaskRepo.getReadyTasks).mockResolvedValue(tasks);

    await scheduler.loadReadyTasks();

    const heap = scheduler.getHeap();
    expect(heap.size()).toBe(2);

    const first = heap.extractMin()!;
    expect(first.taskId).toBe('task-2');
  });

  it('dispatches tasks from heap to worker pool', async () => {
    const tasks = [
      makeTask({
        id: 'task-1',
        priority: 0,
        submission_order: 1n,
        scheduled_at: new Date(Date.now() - 1000),
      }),
    ];
    vi.mocked(mockTaskRepo.getReadyTasks).mockResolvedValue(tasks);
    vi.mocked(mockTaskRepo.getReadyTasksWithSchedule).mockResolvedValue([]);

    await scheduler.loadReadyTasks();
    scheduler.start();

    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    expect(mockWorkerPool.executeTask).toHaveBeenCalled();
  });

  it('does not dispatch if semaphore is full', async () => {
    vi.mocked(mockWorkerPool.availablePermits).mockReturnValue(0);

    const tasks = [
      makeTask({
        id: 'task-1',
        scheduled_at: new Date(Date.now() - 1000),
      }),
    ];
    vi.mocked(mockTaskRepo.getReadyTasks).mockResolvedValue(tasks);
    vi.mocked(mockTaskRepo.getReadyTasksWithSchedule).mockResolvedValue([]);

    await scheduler.loadReadyTasks();
    scheduler.start();

    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    expect(mockWorkerPool.executeTask).not.toHaveBeenCalled();
  });

  it('does not dispatch tasks scheduled in the future', async () => {
    const tasks = [
      makeTask({
        id: 'task-1',
        scheduled_at: new Date(Date.now() + 60000),
      }),
    ];
    vi.mocked(mockTaskRepo.getReadyTasks).mockResolvedValue(tasks);
    vi.mocked(mockTaskRepo.getReadyTasksWithSchedule).mockResolvedValue([]);

    await scheduler.loadReadyTasks();
    scheduler.start();

    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    expect(mockWorkerPool.executeTask).not.toHaveBeenCalled();
  });
});
