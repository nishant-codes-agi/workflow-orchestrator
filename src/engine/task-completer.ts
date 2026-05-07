import type { DbPool } from '../db/pool.js';
import type { TaskRepository } from '../repositories/task.repository.js';
import type { WorkflowRepository } from '../repositories/workflow.repository.js';
import type { MinHeap, TaskHeapEntry } from '../data-structures/min-heap.js';
import type { FastifyBaseLogger } from 'fastify';
import { computeNextSleep } from './backoff.js';

export class TaskCompleter {
  constructor(
    private readonly db: DbPool,
    private readonly taskRepo: TaskRepository,
    private readonly workflowRepo: WorkflowRepository,
    private readonly heap: MinHeap<TaskHeapEntry>,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async persistOutcome(
    task: {
      id: string;
      workflow_id: string;
      max_attempts: number;
      attempts: number;
      backoff_base_ms?: number;
      backoff_cap_ms?: number;
      last_sleep_ms?: number;
    },
    outcome: 'completed' | 'failed',
    error?: string,
  ): Promise<void> {
    const wfStatus = await this.workflowRepo.getStatus(task.workflow_id);

    if (outcome === 'completed') {
      await this.taskRepo.markCompleted(this.db, task.id);
      this.logger.info({ taskId: task.id }, 'Task completed');

      if (wfStatus === 'CANCELLING') {
        await this.cancelDependents(task.id, task.workflow_id);
      } else {
        await this.readySetChildren(task.id);
      }
    } else if (task.attempts < task.max_attempts && wfStatus !== 'CANCELLING') {
      const sleep = computeNextSleep(
        task.backoff_base_ms ?? 1000,
        task.backoff_cap_ms ?? 30000,
        task.last_sleep_ms ?? 0,
      );
      await this.taskRepo.scheduleRetry(this.db, task.id, sleep);
      this.logger.info(
        {
          taskId: task.id,
          attempts: task.attempts,
          maxAttempts: task.max_attempts,
          nextSleepMs: sleep,
        },
        'Task scheduled for retry',
      );
    } else {
      await this.taskRepo.markFailed(this.db, task.id, error ?? 'unknown');
      this.logger.info({ taskId: task.id, attempts: task.attempts }, 'Task failed terminally');

      if (wfStatus === 'CANCELLING') {
        await this.cancelDependents(task.id, task.workflow_id);
      }
    }

    await this.checkWorkflowCompletion(task.workflow_id);
  }

  private async cancelDependents(taskId: string, workflowId: string): Promise<void> {
    await this.taskRepo.cancelDependentsOfTask(this.db, workflowId, taskId);
    this.logger.info({ taskId, workflowId }, 'Cancelled dependents (workflow CANCELLING)');
  }

  private async readySetChildren(completedTaskId: string): Promise<void> {
    const childIds = await this.taskRepo.getChildTaskIds(this.db, completedTaskId);

    for (const childId of childIds) {
      const result = await this.taskRepo.decrementPendingDeps(this.db, childId);

      if (result && result.pending_deps === 0) {
        await this.taskRepo.markTaskReady(this.db, childId);

        this.heap.insert({
          taskId: result.id,
          priority: result.priority,
          scheduledAt: Date.now(),
          submissionOrder: result.submission_order,
        });

        this.logger.info({ taskId: childId }, 'Child task became READY');
      }
    }
  }

  private async checkWorkflowCompletion(workflowId: string): Promise<void> {
    const nonTerminalCount = await this.taskRepo.countNonTerminalTasks(this.db, workflowId);

    if (nonTerminalCount === 0) {
      const wfStatus = await this.workflowRepo.getStatus(workflowId);
      if (wfStatus === 'CANCELLING') {
        await this.workflowRepo.updateStatus(this.db, workflowId, 'CANCELLED');
        this.logger.info({ workflowId }, 'Workflow cancelled (all tasks drained)');
      } else {
        const hasFailed = await this.taskRepo.hasFailedTasks(this.db, workflowId);
        const finalStatus = hasFailed ? 'FAILED' : 'COMPLETED';
        await this.workflowRepo.updateStatus(this.db, workflowId, finalStatus);
        this.logger.info({ workflowId, status: finalStatus }, 'Workflow reached terminal state');
      }
    }
  }

  async checkWorkflowTermination(workflowId: string): Promise<void> {
    await this.checkWorkflowCompletion(workflowId);
  }
}
