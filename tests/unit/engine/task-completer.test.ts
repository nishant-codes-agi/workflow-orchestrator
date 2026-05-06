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

describe('TaskCompleter', () => {
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
      getChildTaskIds: vi.fn().mockResolvedValue([]),
      decrementPendingDeps: vi.fn().mockResolvedValue(null),
      markTaskReady: vi.fn().mockResolvedValue(undefined),
      countNonTerminalTasks: vi.fn().mockResolvedValue(0),
      hasFailedTasks: vi.fn().mockResolvedValue(false),
    } as unknown as TaskRepository;

    mockWorkflowRepo = {
      updateStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowRepository;

    completer = new TaskCompleter(
      mockPool,
      mockTaskRepo,
      mockWorkflowRepo,
      heap,
      createMockLogger(),
    );
  });

  it('3-task chain A -> B -> C: completing A makes B READY (pending_deps 1->0)', async () => {
    vi.mocked(mockTaskRepo.getChildTaskIds).mockResolvedValue(['task-B']);
    vi.mocked(mockTaskRepo.decrementPendingDeps).mockResolvedValue({
      id: 'task-B',
      pending_deps: 0,
      priority: 0,
      scheduled_at: new Date(),
      submission_order: 2n,
    });
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(2);

    await completer.persistOutcome(
      { id: 'task-A', workflow_id: 'wf-1', max_attempts: 3, attempts: 1 },
      'completed',
    );

    expect(mockTaskRepo.markCompleted).toHaveBeenCalledWith(mockPool, 'task-A');
    expect(mockTaskRepo.decrementPendingDeps).toHaveBeenCalledWith(mockPool, 'task-B');
    expect(mockTaskRepo.markTaskReady).toHaveBeenCalledWith(mockPool, 'task-B');
    expect(heap.size()).toBe(1);
    expect(heap.peek()!.taskId).toBe('task-B');
  });

  it('diamond: completing B (one of D\'s two parents) decrements D from 2 to 1', async () => {
    vi.mocked(mockTaskRepo.getChildTaskIds).mockResolvedValue(['task-D']);
    vi.mocked(mockTaskRepo.decrementPendingDeps).mockResolvedValue({
      id: 'task-D',
      pending_deps: 1,
      priority: 0,
      scheduled_at: new Date(),
      submission_order: 4n,
    });
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(2);

    await completer.persistOutcome(
      { id: 'task-B', workflow_id: 'wf-1', max_attempts: 3, attempts: 1 },
      'completed',
    );

    expect(mockTaskRepo.decrementPendingDeps).toHaveBeenCalledWith(mockPool, 'task-D');
    expect(mockTaskRepo.markTaskReady).not.toHaveBeenCalled();
    expect(heap.size()).toBe(0);
  });

  it('diamond: completing C decrements D from 1 to 0, D becomes READY', async () => {
    vi.mocked(mockTaskRepo.getChildTaskIds).mockResolvedValue(['task-D']);
    vi.mocked(mockTaskRepo.decrementPendingDeps).mockResolvedValue({
      id: 'task-D',
      pending_deps: 0,
      priority: 0,
      scheduled_at: new Date(),
      submission_order: 4n,
    });
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(1);

    await completer.persistOutcome(
      { id: 'task-C', workflow_id: 'wf-1', max_attempts: 3, attempts: 1 },
      'completed',
    );

    expect(mockTaskRepo.markTaskReady).toHaveBeenCalledWith(mockPool, 'task-D');
    expect(heap.size()).toBe(1);
  });

  it('concurrent parent completion: two UPDATE RETURNING calls on same child, only one sees pending_deps=0', async () => {
    vi.mocked(mockTaskRepo.getChildTaskIds).mockResolvedValue(['task-D']);

    let callCount = 0;
    vi.mocked(mockTaskRepo.decrementPendingDeps).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { id: 'task-D', pending_deps: 1, priority: 0, scheduled_at: new Date(), submission_order: 4n };
      }
      return { id: 'task-D', pending_deps: 0, priority: 0, scheduled_at: new Date(), submission_order: 4n };
    });
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(1);

    await completer.persistOutcome(
      { id: 'task-B', workflow_id: 'wf-1', max_attempts: 3, attempts: 1 },
      'completed',
    );
    await completer.persistOutcome(
      { id: 'task-C', workflow_id: 'wf-1', max_attempts: 3, attempts: 1 },
      'completed',
    );

    const readyCalls = vi.mocked(mockTaskRepo.markTaskReady).mock.calls;
    expect(readyCalls.length).toBe(1);
    expect(heap.size()).toBe(1);
  });

  it('all tasks complete -> workflow status COMPLETED', async () => {
    vi.mocked(mockTaskRepo.getChildTaskIds).mockResolvedValue([]);
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(0);
    vi.mocked(mockTaskRepo.hasFailedTasks).mockResolvedValue(false);

    await completer.persistOutcome(
      { id: 'task-A', workflow_id: 'wf-1', max_attempts: 3, attempts: 1 },
      'completed',
    );

    expect(mockWorkflowRepo.updateStatus).toHaveBeenCalledWith(
      mockPool,
      'wf-1',
      'COMPLETED',
    );
  });

  it('task fails terminally -> workflow status FAILED', async () => {
    vi.mocked(mockTaskRepo.getChildTaskIds).mockResolvedValue([]);
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(0);
    vi.mocked(mockTaskRepo.hasFailedTasks).mockResolvedValue(true);

    await completer.persistOutcome(
      { id: 'task-A', workflow_id: 'wf-1', max_attempts: 1, attempts: 1 },
      'failed',
      'some error',
    );

    expect(mockWorkflowRepo.updateStatus).toHaveBeenCalledWith(
      mockPool,
      'wf-1',
      'FAILED',
    );
  });

  it('task failure with remaining non-terminal tasks: workflow not yet terminal', async () => {
    vi.mocked(mockTaskRepo.getChildTaskIds).mockResolvedValue([]);
    vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(2);

    await completer.persistOutcome(
      { id: 'task-A', workflow_id: 'wf-1', max_attempts: 1, attempts: 1 },
      'failed',
      'error',
    );

    expect(mockWorkflowRepo.updateStatus).not.toHaveBeenCalled();
  });
});
