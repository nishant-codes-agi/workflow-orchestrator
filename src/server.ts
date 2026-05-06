import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { DbPool } from './db/pool.js';
import type { Config } from './config.js';
import { HandlerRegistry } from './engine/handler-registry.js';
import { WorkflowRepository } from './repositories/workflow.repository.js';
import { TaskRepository } from './repositories/task.repository.js';
import { WorkflowService } from './services/workflow.service.js';
import { ScheduleRepository } from './repositories/schedule.repository.js';
import { registerWorkflowRoutes } from './routes/workflow.routes.js';
import { registerScheduleRoutes } from './routes/schedule.routes.js';

export async function buildServer(
  pool: DbPool,
  config: Config,
  handlerRegistry: HandlerRegistry,
) {
  const server = Fastify({
    logger: true,
  });

  await server.register(sensible);

  server.get('/health', async () => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', db: 'connected' };
    } catch {
      throw server.httpErrors.serviceUnavailable('Database connection failed');
    }
  });

  const workflowRepo = new WorkflowRepository(pool);
  const taskRepo = new TaskRepository(pool);
  const workflowService = new WorkflowService(
    pool,
    taskRepo,
    workflowRepo,
    handlerRegistry,
    server.log,
  );

  const scheduleRepo = new ScheduleRepository(pool);

  registerWorkflowRoutes(server, workflowService);
  registerScheduleRoutes(server, scheduleRepo);

  return { server, workflowRepo, taskRepo, workflowService, scheduleRepo };
}
