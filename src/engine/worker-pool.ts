import type { DbPool } from '../db/pool.js';
import type { Config } from '../config.js';
import type { TaskRepository } from '../repositories/task.repository.js';
import type { HandlerRegistry } from './handler-registry.js';
import type { TaskCompleter } from './task-completer.js';
import type { TaskHeapEntry } from '../data-structures/min-heap.js';
import { BoundedSemaphore } from '../data-structures/bounded-semaphore.js';
import type { FastifyBaseLogger } from 'fastify';

export class WorkerPool {
  private readonly semaphore: BoundedSemaphore;

  constructor(
    private readonly handlerRegistry: HandlerRegistry,
    private readonly taskRepo: TaskRepository,
    private readonly taskCompleter: TaskCompleter,
    private readonly db: DbPool,
    private readonly config: Config,
    private readonly logger: FastifyBaseLogger,
  ) {
    this.semaphore = new BoundedSemaphore(config.workerCount);
  }

  async executeTask(heapEntry: TaskHeapEntry): Promise<void> {
    await this.semaphore.acquire();

    try {
      const cas = await this.taskRepo.claimTask(this.db, heapEntry.taskId);
      if (cas.rowCount === 0) {
        this.logger.warn({ taskId: heapEntry.taskId }, 'CAS guard failed, task already claimed');
        return;
      }

      const taskRows = await this.db.query<{
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
      }>(
        `SELECT id, workflow_id, handler_name, input, timeout_ms, logical_id,
                max_attempts, attempts, backoff_base_ms, backoff_cap_ms, last_sleep_ms
         FROM tasks WHERE id = $1`,
        [heapEntry.taskId],
      );
      const task = taskRows.rows[0];
      if (!task) {
        this.logger.error({ taskId: heapEntry.taskId }, 'Task not found after CAS');
        return;
      }

      const heartbeat = setInterval(() => {
        this.taskRepo
          .updateHeartbeat(this.db, task.id)
          .catch((err: unknown) => this.logger.error({ err, taskId: task.id }, 'Heartbeat update failed'));
      }, this.config.heartbeatIntervalMs);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), task.timeout_ms);

      const idemKey = `${task.workflow_id}:${task.id}`;

      let outcome: 'completed' | 'failed' = 'failed';
      let error: string | undefined;

      try {
        const handler = this.handlerRegistry.get(task.handler_name);
        await Promise.race([
          handler(task.input, {
            signal: ac.signal,
            idempotencyKey: idemKey,
            workflowId: task.workflow_id,
            taskId: task.id,
            attempt: cas.attempts,
          }),
          new Promise<never>((_, reject) => {
            ac.signal.addEventListener('abort', () =>
              reject(new Error('timeout')),
            );
          }),
        ]);
        outcome = 'completed';
      } catch (e) {
        error = String(e);
      } finally {
        clearTimeout(timer);
        clearInterval(heartbeat);
      }

      await this.taskCompleter.persistOutcome(
        {
          id: task.id,
          workflow_id: task.workflow_id,
          max_attempts: task.max_attempts,
          attempts: cas.attempts,
          backoff_base_ms: task.backoff_base_ms,
          backoff_cap_ms: task.backoff_cap_ms,
          last_sleep_ms: task.last_sleep_ms,
        },
        outcome,
        error,
      );
    } finally {
      this.semaphore.release();
    }
  }

  availablePermits(): number {
    return this.semaphore.availablePermits();
  }
}
