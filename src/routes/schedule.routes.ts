import type { FastifyInstance } from 'fastify';
import { parseCronExpression } from '../cron/parser.js';
import { nextFire } from '../cron/next-fire.js';
import type { ScheduleRepository } from '../repositories/schedule.repository.js';

const createScheduleSchema = {
  body: {
    type: 'object' as const,
    required: ['cronExpression', 'workflowDefinition'],
    properties: {
      cronExpression: { type: 'string' as const },
      timezone: { type: 'string' as const },
      workflowDefinition: { type: 'object' as const },
    },
  },
};

interface CreateScheduleBody {
  cronExpression: string;
  timezone?: string;
  workflowDefinition: { tasks: unknown[] };
}

export function registerScheduleRoutes(
  server: FastifyInstance,
  scheduleRepo: ScheduleRepository,
): void {
  server.post(
    '/schedules',
    { schema: createScheduleSchema },
    async (request, reply) => {
      const body = request.body as CreateScheduleBody;
      const timezone = body.timezone ?? 'UTC';

      let expr;
      try {
        expr = parseCronExpression(body.cronExpression);
      } catch (err) {
        return reply.status(422).send({
          error: `Invalid cron expression: ${(err as Error).message}`,
        });
      }

      let nextFireAt;
      try {
        nextFireAt = nextFire(expr, new Date(), timezone);
      } catch (err) {
        return reply.status(422).send({
          error: `Cannot compute next fire time: ${(err as Error).message}`,
        });
      }

      const result = await scheduleRepo.insertSchedule(
        body.cronExpression,
        timezone,
        body.workflowDefinition,
        nextFireAt,
      );

      return reply.status(201).send({
        scheduleId: result.id,
        nextFireAt: result.nextFireAt,
      });
    },
  );
}
