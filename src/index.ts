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
  handlerRegistry.register('slow', async (input) => {
    const ms = (input as { ms?: number })?.ms ?? 1000;
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

  const { server, workflowRepo, taskRepo } = await buildServer(
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
    taskCompleter,
    pool,
    config,
    server.log,
  );

  schedulerLoop.setWorkerPool(workerPool);

  await schedulerLoop.loadReadyTasks();
  schedulerLoop.start();

  await server.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async () => {
    server.log.info('Shutting down...');
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
