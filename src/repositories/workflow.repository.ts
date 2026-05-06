import type pg from 'pg';
import type { Workflow, WorkflowStatus } from '../interfaces/workflow.js';

export class WorkflowRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insertWorkflow(
    client: pg.PoolClient,
    status: WorkflowStatus,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO workflows (status) VALUES ($1) RETURNING id`,
      [status],
    );
    return result.rows[0]!.id;
  }

  async findById(workflowId: string): Promise<Workflow | null> {
    const result = await this.pool.query<Workflow>(
      `SELECT id, status, created_at, updated_at FROM workflows WHERE id = $1`,
      [workflowId],
    );
    return result.rows[0] ?? null;
  }

  async updateStatus(
    client: pg.PoolClient | pg.Pool,
    workflowId: string,
    status: WorkflowStatus,
  ): Promise<void> {
    await client.query(
      `UPDATE workflows SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, workflowId],
    );
  }
}
