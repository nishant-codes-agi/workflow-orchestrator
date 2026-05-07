import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { buildServer } from '../../src/server.js';
import { HandlerRegistry } from '../../src/engine/handler-registry.js';
import { SchedulerLoop } from '../../src/engine/scheduler-loop.js';
import { WorkerPool } from '../../src/engine/worker-pool.js';
import { TaskCompleter } from '../../src/engine/task-completer.js';
import { Reaper } from '../../src/engine/reaper.js';
import { migrate } from '../../src/db/migrate.js';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://daguser:dagpass@localhost:5432/dagdb';

/**
 * Configuration defaults for integration tests.
 * Worker count defaults to 10 but can be overridden per-test.
 */
function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    databaseUrl: DATABASE_URL,
    workerCount: 10,
    heartbeatIntervalMs: 500,
    reaperPollMs: 2000,
    leaseTimeoutMs: 3000,
    cronTickMs: 10000,
    ...overrides,
  };
}

export interface TestServer {
  server: FastifyInstance;
  pool: pg.Pool;
  schedulerLoop: SchedulerLoop;
  reaper: Reaper;
  config: Config;
  cleanup: () => Promise<void>;
}

/**
 * Starts a fully-wired in-process test server with scheduler, worker pool,
 * and reaper. The caller must call `cleanup()` when done.
 */
export async function startTestServer(
  handlerRegistry: HandlerRegistry,
  configOverrides: Partial<Config> & { schedulerTickMs?: number } = {},
): Promise<TestServer> {
  const config = buildConfig(configOverrides);
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  const migrationsDir = path.resolve(__dirname, '..', '..', 'migrations');
  await migrate(pool, migrationsDir);

  const built = await buildServer(pool, config, handlerRegistry);
  const { server, taskRepo, workflowRepo } = built;
  await server.ready();

  const schedulerLoop = new SchedulerLoop(pool, taskRepo, server.log, configOverrides.schedulerTickMs ?? 50);

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

  // Startup recovery + load ready tasks
  await reaper.reclaimStaleTasks();
  await schedulerLoop.loadReadyTasks();
  schedulerLoop.start();
  reaper.startPolling();

  const cleanup = async () => {
    reaper.stop();
    schedulerLoop.stop();
    await server.close();
    await pool.end();
  };

  return { server, pool, schedulerLoop, reaper, config, cleanup };
}

/**
 * Submit a workflow via the Fastify server's inject method (in-process HTTP).
 * Returns the workflow ID.
 */
export async function submitWorkflow(
  server: FastifyInstance,
  tasks: unknown[],
): Promise<string> {
  const resp = await server.inject({
    method: 'POST',
    url: '/workflows',
    payload: { tasks },
  });
  if (resp.statusCode !== 201) {
    throw new Error(`Submit failed: ${resp.statusCode} ${resp.body}`);
  }
  const body = JSON.parse(resp.body) as { workflowId: string };
  return body.workflowId;
}

/**
 * Poll the workflow's status via the API until it reaches one of the given
 * target statuses. Returns the final status string.
 */
export async function pollStatus(
  server: FastifyInstance,
  workflowId: string,
  targetStatuses: string[],
  timeoutMs = 60000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await server.inject({
      method: 'GET',
      url: `/workflows/${workflowId}`,
    });
    if (resp.statusCode === 200) {
      const body = JSON.parse(resp.body) as { status: string };
      if (targetStatuses.includes(body.status)) return body.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `Workflow ${workflowId} did not reach [${targetStatuses.join(', ')}] within ${timeoutMs}ms`,
  );
}

/**
 * Shorthand: wait for workflow to reach a terminal state (COMPLETED | FAILED | CANCELLED).
 */
export async function waitForWorkflowStatus(
  server: FastifyInstance,
  workflowId: string,
  status: string,
  timeoutMs = 60000,
): Promise<string> {
  return pollStatus(server, workflowId, [status], timeoutMs);
}

/**
 * Wait for workflow terminal state via direct DB polling.
 */
export async function waitForWorkflowTerminalDB(
  pool: pg.Pool,
  workflowId: string,
  timeoutMs = 60000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM workflows WHERE id = $1`,
      [workflowId],
    );
    const status = result.rows[0]?.status;
    if (status && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `Workflow ${workflowId} did not reach terminal state within ${timeoutMs}ms`,
  );
}

/**
 * Clean all test data from the database (respects FK ordering).
 */
export async function cleanDB(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE task_dependencies, tasks, workflows, schedules CASCADE');
}

/**
 * Grab a random available TCP port (bind to 0, read port, close).
 */
export async function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export { DATABASE_URL };
