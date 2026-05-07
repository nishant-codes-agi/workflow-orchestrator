import type { DbPool } from '../db/pool.js';
import type { Config } from '../config.js';
import type { TaskRepository } from '../repositories/task.repository.js';
import type { WorkflowRepository } from '../repositories/workflow.repository.js';
import type { MinHeap, TaskHeapEntry } from '../data-structures/min-heap.js';
import type { FastifyBaseLogger } from 'fastify';

export class Reaper {
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DbPool,
    private readonly config: Config,
    private readonly taskRepo: TaskRepository,
    private readonly workflowRepo: WorkflowRepository,
    private readonly heap: MinHeap<TaskHeapEntry>,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async reclaimStaleTasks(): Promise<number> {
    const reclaimed = await this.taskRepo.reclaimStaleTasks(this.db, this.config.leaseTimeoutMs);

    for (const task of reclaimed) {
      if (task.status === 'PENDING' && new Date(task.scheduled_at).getTime() <= Date.now()) {
        this.heap.insert({
          taskId: task.id,
          priority: task.priority,
          scheduledAt: new Date(task.scheduled_at).getTime(),
          submissionOrder: task.submission_order,
        });
      }

      if (task.status === 'FAILED') {
        await this.checkWorkflowCompletion(task.workflow_id);
      }
    }

    if (reclaimed.length > 0) {
      this.logger.info({ count: reclaimed.length }, 'Reclaimed stale tasks');
    }

    return reclaimed.length;
  }

  private async checkWorkflowCompletion(workflowId: string): Promise<void> {
    const nonTerminalCount = await this.taskRepo.countNonTerminalTasks(this.db, workflowId);

    if (nonTerminalCount === 0) {
      const hasFailed = await this.taskRepo.hasFailedTasks(this.db, workflowId);
      const finalStatus = hasFailed ? 'FAILED' : 'COMPLETED';
      await this.workflowRepo.updateStatus(this.db, workflowId, finalStatus);
      this.logger.info(
        { workflowId, status: finalStatus },
        'Workflow reached terminal state (reaper)',
      );
    }
  }

  startPolling(): void {
    this.pollInterval = setInterval(() => {
      this.reclaimStaleTasks().catch((err: unknown) =>
        this.logger.error({ err }, 'Reaper poll failed'),
      );
    }, this.config.reaperPollMs);
    this.logger.info({ pollMs: this.config.reaperPollMs }, 'Reaper polling started');
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.logger.info('Reaper polling stopped');
    }
  }
}
