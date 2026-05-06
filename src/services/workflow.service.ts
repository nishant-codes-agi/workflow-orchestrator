import type { DbPool } from '../db/pool.js';
import type { TaskDefinition } from '../interfaces/task.js';
import type { WorkflowDefinition } from '../interfaces/workflow.js';
import { detectCycle } from '../data-structures/cycle-detector.js';
import { HandlerRegistry } from '../engine/handler-registry.js';
import { WorkflowRepository } from '../repositories/workflow.repository.js';
import { TaskRepository, type BulkTaskRow } from '../repositories/task.repository.js';
import type { FastifyBaseLogger } from 'fastify';

export class WorkflowService {
  constructor(
    private readonly db: DbPool,
    private readonly taskRepo: TaskRepository,
    private readonly workflowRepo: WorkflowRepository,
    private readonly handlerRegistry: HandlerRegistry,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async submitWorkflow(
    definition: WorkflowDefinition,
  ): Promise<{ workflowId: string }> {
    const { tasks } = definition;

    if (!tasks || tasks.length === 0) {
      throw new SubmissionError('Workflow must contain at least one task', 422);
    }

    const seenIds = new Set<string>();
    for (const task of tasks) {
      if (seenIds.has(task.id)) {
        throw new SubmissionError(`Duplicate task ID: ${task.id}`, 422);
      }
      seenIds.add(task.id);
    }

    for (const task of tasks) {
      if (!this.handlerRegistry.has(task.handler)) {
        throw new SubmissionError(
          `Unknown handler: ${task.handler}`,
          422,
        );
      }
    }

    const adjacency = new Map<string, string[]>();
    for (const task of tasks) {
      adjacency.set(task.id, task.dependsOn ?? []);
    }

    const cycle = detectCycle(adjacency);
    if (cycle) {
      throw new SubmissionError(
        `Cycle detected: ${cycle.join(' -> ')}`,
        422,
      );
    }

    const pendingDepsMap = new Map<string, number>();
    for (const task of tasks) {
      pendingDepsMap.set(task.id, (task.dependsOn ?? []).length);
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const workflowId = await this.workflowRepo.insertWorkflow(
        client,
        'RUNNING',
      );

      const bulkRows: BulkTaskRow[] = tasks.map((t: TaskDefinition) => ({
        logical_id: t.id,
        workflow_id: workflowId,
        handler_name: t.handler,
        input: t.input ?? {},
        status: 'PENDING',
        priority: t.priority ?? 0,
        max_attempts: t.retryPolicy?.maxAttempts ?? 3,
        backoff_base_ms: t.retryPolicy?.backoffBase ?? 1000,
        backoff_cap_ms: t.retryPolicy?.backoffCap ?? 30000,
        timeout_ms: t.timeoutMs ?? 30000,
        pending_deps: pendingDepsMap.get(t.id) ?? 0,
      }));

      const logicalToId = await this.taskRepo.bulkInsertTasks(
        client,
        workflowId,
        bulkRows,
      );

      const deps: Array<{ taskId: string; dependsOnTaskId: string }> = [];
      for (const task of tasks) {
        for (const depLogicalId of task.dependsOn ?? []) {
          const taskId = logicalToId.get(task.id)!;
          const dependsOnTaskId = logicalToId.get(depLogicalId)!;
          deps.push({ taskId, dependsOnTaskId });
        }
      }

      if (deps.length > 0) {
        await this.taskRepo.insertDependencies(client, deps);
      }

      await this.taskRepo.markReadyTasks(client, workflowId);

      await client.query('COMMIT');

      this.logger.info({ workflowId }, 'Workflow submitted');
      return { workflowId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export class SubmissionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'SubmissionError';
  }
}
