import type { DbPool } from '../db/pool.js';
import type { WorkflowService } from '../services/workflow.service.js';
import type { ScheduleRepository } from '../repositories/schedule.repository.js';
import { parseCronExpression } from './parser.js';
import { nextFire } from './next-fire.js';
import type { FastifyBaseLogger } from 'fastify';

export class CronScheduler {
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DbPool,
    private readonly scheduleRepo: ScheduleRepository,
    private readonly workflowService: WorkflowService,
    private readonly logger: FastifyBaseLogger,
    private readonly tickMs: number,
  ) {}

  async tick(): Promise<void> {
    const due = await this.scheduleRepo.getDueSchedules();

    for (const schedule of due) {
      try {
        const def = JSON.parse(JSON.stringify(schedule.workflow_definition));
        await this.workflowService.submitWorkflow(def);

        const expr = parseCronExpression(schedule.cron_expression);
        const next = nextFire(expr, new Date(), schedule.timezone);

        await this.scheduleRepo.updateAfterFire(schedule.id, next);

        this.logger.info(
          { scheduleId: schedule.id, nextFireAt: next.toISOString() },
          'Cron schedule fired',
        );
      } catch (err) {
        this.logger.error(
          { err, scheduleId: schedule.id },
          'Cron schedule fire failed',
        );
      }
    }
  }

  startPolling(): void {
    this.tickInterval = setInterval(() => {
      this.tick().catch((err: unknown) =>
        this.logger.error({ err }, 'Cron tick failed'),
      );
    }, this.tickMs);
    this.logger.info({ tickMs: this.tickMs }, 'Cron scheduler started');
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      this.logger.info('Cron scheduler stopped');
    }
  }
}
