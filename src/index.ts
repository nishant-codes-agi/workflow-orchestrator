import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildServer } from './server.js';
import { HandlerRegistry } from './engine/handler-registry.js';
import { SchedulerLoop } from './engine/scheduler-loop.js';
import { WorkerPool } from './engine/worker-pool.js';
import { TaskCompleter } from './engine/task-completer.js';
import { Reaper } from './engine/reaper.js';
import { CronScheduler } from './cron/cron-scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  await migrate(pool, migrationsDir);

  const handlerRegistry = new HandlerRegistry();

  handlerRegistry.register('noop', async () => {});
  handlerRegistry.register('echo', async (input) => {
    console.log('echo:', input);
  });
  handlerRegistry.register('fail-once', async (_input, ctx) => {
    if (ctx.attempt === 1) throw new Error('transient failure');
  });
  handlerRegistry.register('slow', async (input, ctx) => {
    const ms = (input as { ms?: number })?.ms ?? 1000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
  });
  handlerRegistry.register('fail-n-times', async (input, ctx) => {
    const n = (input as { failCount?: number })?.failCount ?? 1;
    if (ctx.attempt <= n) throw new Error(`intentional failure on attempt ${ctx.attempt}`);
  });

  const { server, workflowRepo, taskRepo, workflowService, scheduleRepo } = await buildServer(
    pool,
    config,
    handlerRegistry,
  );

  const schedulerLoop = new SchedulerLoop(
    pool,
    taskRepo,
    server.log,
    100,
  );

  const taskCompleter = new TaskCompleter(
    pool,
    taskRepo,
    workflowRepo,
    schedulerLoop.getHeap(),
    server.log,
  );

  const workerPool = new WorkerPool(
    handlerRegistry,
    taskRepo,
    workflowRepo,
    taskCompleter,
    pool,
    config,
    server.log,
  );

  schedulerLoop.setWorkerPool(workerPool);

  const reaper = new Reaper(
    pool,
    config,
    taskRepo,
    workflowRepo,
    schedulerLoop.getHeap(),
    server.log,
  );

  const cronScheduler = new CronScheduler(
    pool,
    scheduleRepo,
    workflowService,
    server.log,
    config.cronTickMs,
  );

  // Startup recovery sequence:
  // 1. Reclaim stale RUNNING tasks
  await reaper.reclaimStaleTasks();
  // 2. Load all READY tasks into heap
  await schedulerLoop.loadReadyTasks();
  // 3. Start scheduler loop
  schedulerLoop.start();
  // 4. Start reaper polling
  reaper.startPolling();
  // 5. Start cron scheduler
  cronScheduler.startPolling();

  await server.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async () => {
    server.log.info('Shutting down...');
    cronScheduler.stop();
    reaper.stop();
    schedulerLoop.stop();
    await server.close();
    await pool.end();
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
