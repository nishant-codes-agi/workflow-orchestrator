import type pg from 'pg';
import type { Task } from '../interfaces/task.js';

export interface BulkTaskRow {
  logical_id: string;
  workflow_id: string;
  handler_name: string;
  input: unknown;
  status: string;
  priority: number;
  max_attempts: number;
  backoff_base_ms: number;
  backoff_cap_ms: number;
  timeout_ms: number;
  pending_deps: number;
}

export class TaskRepository {
  constructor(private readonly pool: pg.Pool) {}

  async bulkInsertTasks(
    client: pg.PoolClient,
    workflowId: string,
    tasks: BulkTaskRow[],
  ): Promise<Map<string, string>> {
    const logicalToId = new Map<string, string>();

    for (const task of tasks) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO tasks (
          logical_id, workflow_id, handler_name, input, status,
          priority, max_attempts, backoff_base_ms, backoff_cap_ms,
          timeout_ms, pending_deps
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id`,
        [
          task.logical_id,
          workflowId,
          task.handler_name,
          JSON.stringify(task.input),
          task.status,
          task.priority,
          task.max_attempts,
          task.backoff_base_ms,
          task.backoff_cap_ms,
          task.timeout_ms,
          task.pending_deps,
        ],
      );
      logicalToId.set(task.logical_id, result.rows[0]!.id);
    }

    return logicalToId;
  }

  async insertDependencies(
    client: pg.PoolClient,
    deps: Array<{ taskId: string; dependsOnTaskId: string }>,
  ): Promise<void> {
    for (const dep of deps) {
      await client.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)`,
        [dep.taskId, dep.dependsOnTaskId],
      );
    }
  }

  async markReadyTasks(
    client: pg.PoolClient,
    workflowId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE tasks SET status = 'READY', scheduled_at = NOW()
       WHERE pending_deps = 0 AND workflow_id = $1 AND status = 'PENDING'`,
      [workflowId],
    );
  }

  async getTasksByWorkflowId(workflowId: string): Promise<Task[]> {
    const result = await this.pool.query<Task>(
      `SELECT * FROM tasks WHERE workflow_id = $1 ORDER BY submission_order`,
      [workflowId],
    );
    return result.rows;
  }

  async getReadyTasks(): Promise<Task[]> {
    const result = await this.pool.query<Task>(
      `SELECT * FROM tasks WHERE status = 'READY' AND scheduled_at <= NOW()
       ORDER BY priority DESC, scheduled_at, submission_order`,
    );
    return result.rows;
  }

  async getReadyTasksWithSchedule(): Promise<Task[]> {
    const result = await this.pool.query<Task>(
      `SELECT * FROM tasks
       WHERE status = 'PENDING' AND pending_deps = 0 AND scheduled_at <= NOW()
       ORDER BY priority DESC, scheduled_at, submission_order`,
    );
    return result.rows;
  }

  async claimTask(
    pool: pg.Pool,
    taskId: string,
  ): Promise<{ rowCount: number; attempts: number }> {
    const result = await pool.query<{ attempts: number }>(
      `UPDATE tasks SET status = 'RUNNING', attempts = attempts + 1,
       last_heartbeat_at = NOW()
       WHERE id = $1 AND status = 'READY'
       RETURNING attempts`,
      [taskId],
    );
    return {
      rowCount: result.rowCount ?? 0,
      attempts: result.rows[0]?.attempts ?? 0,
    };
  }

  async updateHeartbeat(pool: pg.Pool, taskId: string): Promise<void> {
    await pool.query(
      `UPDATE tasks SET last_heartbeat_at = NOW() WHERE id = $1`,
      [taskId],
    );
  }

  async markCompleted(pool: pg.Pool, taskId: string): Promise<void> {
    await pool.query(
      `UPDATE tasks SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
      [taskId],
    );
  }

  async markFailed(
    pool: pg.Pool,
    taskId: string,
    error: string,
  ): Promise<void> {
    await pool.query(
      `UPDATE tasks SET status = 'FAILED', error = $2, completed_at = NOW() WHERE id = $1`,
      [taskId, error],
    );
  }

  async getChildTaskIds(
    pool: pg.Pool,
    completedTaskId: string,
  ): Promise<string[]> {
    const result = await pool.query<{ task_id: string }>(
      `SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1`,
      [completedTaskId],
    );
    return result.rows.map((r) => r.task_id);
  }

  async decrementPendingDeps(
    pool: pg.Pool,
    taskId: string,
  ): Promise<{
    id: string;
    pending_deps: number;
    priority: number;
    scheduled_at: Date;
    submission_order: bigint;
  } | null> {
    const result = await pool.query<{
      id: string;
      pending_deps: number;
      priority: number;
      scheduled_at: Date;
      submission_order: bigint;
    }>(
      `UPDATE tasks SET pending_deps = pending_deps - 1
       WHERE id = $1 AND status = 'PENDING'
       RETURNING id, pending_deps, priority, scheduled_at, submission_order`,
      [taskId],
    );
    return result.rows[0] ?? null;
  }

  async markTaskReady(pool: pg.Pool, taskId: string): Promise<void> {
    await pool.query(
      `UPDATE tasks SET status = 'READY', scheduled_at = NOW() WHERE id = $1`,
      [taskId],
    );
  }

  async countNonTerminalTasks(
    pool: pg.Pool,
    workflowId: string,
  ): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')) as count
       FROM tasks WHERE workflow_id = $1`,
      [workflowId],
    );
    return parseInt(result.rows[0]!.count, 10);
  }

  async hasFailedTasks(pool: pg.Pool, workflowId: string): Promise<boolean> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tasks
       WHERE workflow_id = $1 AND status = 'FAILED'`,
      [workflowId],
    );
    return parseInt(result.rows[0]!.count, 10) > 0;
  }
}
