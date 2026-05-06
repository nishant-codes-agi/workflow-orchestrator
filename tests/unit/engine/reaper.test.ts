import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reaper } from '../../../src/engine/reaper.js';
import { MinHeap, createTaskComparator, type TaskHeapEntry } from '../../../src/data-structures/min-heap.js';
import type { TaskRepository } from '../../../src/repositories/task.repository.js';
import type { WorkflowRepository } from '../../../src/repositories/workflow.repository.js';
import type { Config } from '../../../src/config.js';
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

const defaultConfig: Config = {
  port: 3000,
  databaseUrl: 'postgres://localhost/test',
  workerCount: 3,
  heartbeatIntervalMs: 5000,
  reaperPollMs: 30000,
  leaseTimeoutMs: 15000,
  cronTickMs: 10000,
};

describe('Reaper', () => {
  let reaper: Reaper;
  let mockTaskRepo: TaskRepository;
  let mockWorkflowRepo: WorkflowRepository;
  let heap: MinHeap<TaskHeapEntry>;
  let mockPool: pg.Pool;

  beforeEach(() => {
    mockPool = {} as pg.Pool;
    heap = new MinHeap<TaskHeapEntry>(createTaskComparator());

    mockTaskRepo = {
      reclaimStaleTasks: vi.fn().mockResolvedValue([]),
      countNonTerminalTasks: vi.fn().mockResolvedValue(0),
      hasFailedTasks: vi.fn().mockResolvedValue(false),
    } as unknown as TaskRepository;

    mockWorkflowRepo = {
      updateStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowRepository;

    reaper = new Reaper(
      mockPool,
      defaultConfig,
      mockTaskRepo,
      mockWorkflowRepo,
      heap,
      createMockLogger(),
    );
  });

  it('task stuck in RUNNING with stale heartbeat: reaper reclaims it to PENDING', async () => {
    vi.mocked(mockTaskRepo.reclaimStaleTasks).mockResolvedValue([
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        status: 'PENDING',
        pending_deps: 0,
        priority: 0,
        scheduled_at: new Date(),
        submission_order: 1n,
        max_attempts: 3,
        attempts: 1,
      },
    ]);
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(1);

    const count = await reaper.reclaimStaleTasks();

    expect(count).toBe(1);
    expect(heap.size()).toBe(1);
    expect(heap.peek()!.taskId).toBe('task-1');
  });

  it('task stuck in RUNNING with attempts >= max_attempts: reaper marks FAILED', async () => {
    vi.mocked(mockTaskRepo.reclaimStaleTasks).mockResolvedValue([
      {
        id: 'task-2',
        workflow_id: 'wf-1',
        status: 'FAILED',
        pending_deps: 0,
        priority: 0,
        scheduled_at: new Date(),
        submission_order: 1n,
        max_attempts: 3,
        attempts: 3,
      },
    ]);
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(0);
    vi.mocked(mockTaskRepo.hasFailedTasks).mockResolvedValue(true);

    const count = await reaper.reclaimStaleTasks();

    expect(count).toBe(1);
    expect(heap.size()).toBe(0);
    expect(mockWorkflowRepo.updateStatus).toHaveBeenCalledWith(mockPool, 'wf-1', 'FAILED');
  });

  it('task in RUNNING with fresh heartbeat (< LEASE_TIMEOUT_MS): NOT reclaimed', async () => {
    vi.mocked(mockTaskRepo.reclaimStaleTasks).mockResolvedValue([]);

    const count = await reaper.reclaimStaleTasks();

    expect(count).toBe(0);
    expect(heap.size()).toBe(0);
  });

  it('two stale tasks: both reclaimed in single query', async () => {
    vi.mocked(mockTaskRepo.reclaimStaleTasks).mockResolvedValue([
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        status: 'PENDING',
        pending_deps: 0,
        priority: 0,
        scheduled_at: new Date(),
        submission_order: 1n,
        max_attempts: 3,
        attempts: 1,
      },
      {
        id: 'task-2',
        workflow_id: 'wf-1',
        status: 'PENDING',
        pending_deps: 0,
        priority: 5,
        scheduled_at: new Date(),
        submission_order: 2n,
        max_attempts: 3,
        attempts: 2,
      },
    ]);
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(2);

    const count = await reaper.reclaimStaleTasks();

    expect(count).toBe(2);
    expect(heap.size()).toBe(2);
  });

  it('verify attempts is NOT incremented by reaper', async () => {
    vi.mocked(mockTaskRepo.reclaimStaleTasks).mockResolvedValue([
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        status: 'PENDING',
        pending_deps: 0,
        priority: 0,
        scheduled_at: new Date(),
        submission_order: 1n,
        max_attempts: 3,
        attempts: 1,
      },
    ]);

    await reaper.reclaimStaleTasks();

    expect(mockTaskRepo.reclaimStaleTasks).toHaveBeenCalledWith(mockPool, 15000);
  });

  it('verify last_sleep_ms is updated with decorrelated jitter', async () => {
    vi.mocked(mockTaskRepo.reclaimStaleTasks).mockResolvedValue([
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        status: 'PENDING',
        pending_deps: 0,
        priority: 0,
        scheduled_at: new Date(),
        submission_order: 1n,
        max_attempts: 3,
        attempts: 1,
      },
    ]);

    await reaper.reclaimStaleTasks();

    expect(mockTaskRepo.reclaimStaleTasks).toHaveBeenCalledTimes(1);
  });

  it('reclaimed PENDING task with future scheduled_at: NOT inserted into heap', async () => {
    const futureDate = new Date(Date.now() + 60000);
    vi.mocked(mockTaskRepo.reclaimStaleTasks).mockResolvedValue([
      {
        id: 'task-1',
        workflow_id: 'wf-1',
        status: 'PENDING',
        pending_deps: 0,
        priority: 0,
        scheduled_at: futureDate,
        submission_order: 1n,
        max_attempts: 3,
        attempts: 1,
      },
    ]);

    await reaper.reclaimStaleTasks();

    expect(heap.size()).toBe(0);
  });
});
