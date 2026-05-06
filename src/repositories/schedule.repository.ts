import type pg from 'pg';
import type { Schedule } from '../interfaces/schedule.js';

export class ScheduleRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insertSchedule(
    cronExpression: string,
    timezone: string,
    workflowDefinition: unknown,
    nextFireAt: Date,
  ): Promise<{ id: string; nextFireAt: Date }> {
    const result = await this.pool.query<{ id: string; next_fire_at: Date }>(
      `INSERT INTO schedules (cron_expression, timezone, workflow_definition, next_fire_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, next_fire_at`,
      [cronExpression, timezone, JSON.stringify(workflowDefinition), nextFireAt],
    );
    const row = result.rows[0]!;
    return { id: row.id, nextFireAt: row.next_fire_at };
  }

  async getDueSchedules(): Promise<Schedule[]> {
    const result = await this.pool.query<Schedule>(
      `SELECT * FROM schedules WHERE enabled = TRUE AND next_fire_at <= NOW()`,
    );
    return result.rows;
  }

  async updateAfterFire(
    scheduleId: string,
    nextFireAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE schedules SET next_fire_at = $1, last_fired_at = NOW() WHERE id = $2`,
      [nextFireAt, scheduleId],
    );
  }
}
