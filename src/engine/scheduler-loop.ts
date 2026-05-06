import type { DbPool } from '../db/pool.js';
import type { TaskRepository } from '../repositories/task.repository.js';
import type { WorkerPool } from './worker-pool.js';
import { MinHeap, createTaskComparator, type TaskHeapEntry } from '../data-structures/min-heap.js';
import type { FastifyBaseLogger } from 'fastify';

export class SchedulerLoop {
  private readonly heap: MinHeap<TaskHeapEntry>;
  private workerPool: WorkerPool | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private readonly heapTaskIds = new Set<string>();

  constructor(
    private readonly db: DbPool,
    private readonly taskRepo: TaskRepository,
    private readonly logger: FastifyBaseLogger,
    private readonly tickMs: number = 100,
  ) {
    this.heap = new MinHeap<TaskHeapEntry>(createTaskComparator());
  }

  setWorkerPool(pool: WorkerPool): void {
    this.workerPool = pool;
  }

  getHeap(): MinHeap<TaskHeapEntry> {
    return this.heap;
  }

  async loadReadyTasks(): Promise<void> {
    const tasks = await this.taskRepo.getReadyTasks();
    for (const task of tasks) {
      if (!this.heapTaskIds.has(task.id)) {
        this.heap.insert({
          taskId: task.id,
          priority: task.priority,
          scheduledAt: new Date(task.scheduled_at).getTime(),
          submissionOrder: task.submission_order,
        });
        this.heapTaskIds.add(task.id);
      }
    }
    if (tasks.length > 0) {
      this.logger.info({ count: tasks.length }, 'Loaded READY tasks into heap');
    }
  }

  async pollPendingRetries(): Promise<void> {
    const tasks = await this.taskRepo.getReadyTasksWithSchedule();
    for (const task of tasks) {
      if (!this.heapTaskIds.has(task.id)) {
        // Transition PENDING → READY so claimTask CAS guard succeeds
        await this.taskRepo.markTaskReady(this.db, task.id);

        this.heap.insert({
          taskId: task.id,
          priority: task.priority,
          scheduledAt: new Date(task.scheduled_at).getTime(),
          submissionOrder: task.submission_order,
        });
        this.heapTaskIds.add(task.id);
      }
    }
  }

  private async tick(): Promise<void> {
    if (!this.workerPool) return;

    // Pick up newly submitted READY tasks
    await this.loadReadyTasks();
    // Pick up retried PENDING tasks whose scheduled_at has arrived
    await this.pollPendingRetries();

    while (this.heap.size() > 0 && this.workerPool.availablePermits() > 0) {
      const entry = this.heap.peek();
      if (!entry) break;

      if (entry.scheduledAt > Date.now()) break;

      this.heap.extractMin();
      this.heapTaskIds.delete(entry.taskId);

      this.workerPool
        .executeTask(entry)
        .catch((err: unknown) =>
          this.logger.error({ err, taskId: entry.taskId }, 'Worker execution failed'),
        );
    }
  }

  start(): void {
    if (!this.workerPool) {
      throw new Error('WorkerPool must be set before starting scheduler');
    }
    this.tickInterval = setInterval(() => {
      this.tick().catch((err: unknown) =>
        this.logger.error({ err }, 'Scheduler tick failed'),
      );
    }, this.tickMs);
    this.logger.info({ tickMs: this.tickMs }, 'Scheduler loop started');
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      this.logger.info('Scheduler loop stopped');
    }
  }
}
