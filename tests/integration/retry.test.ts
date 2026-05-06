import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../../src/server.js';
import { HandlerRegistry } from '../../src/engine/handler-registry.js';
import { SchedulerLoop } from '../../src/engine/scheduler-loop.js';
import { WorkerPool } from '../../src/engine/worker-pool.js';
import { TaskCompleter } from '../../src/engine/task-completer.js';
import { migrate } from '../../src/db/migrate.js';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://daguser:dagpass@localhost:5432/dagdb';

let pool: pg.Pool;
let server: FastifyInstance;
let dbAvailable = false;
let schedulerLoop: SchedulerLoop;

const config: Config = {
  port: 0,
  databaseUrl: DATABASE_URL,
  workerCount: 10,
  heartbeatIntervalMs: 5000,
  reaperPollMs: 30000,
  leaseTimeoutMs: 15000,
  cronTickMs: 10000,
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    console.warn(
      '⚠  Postgres is not reachable — skipping integration tests.',
    );
    return;
  }

  const migrationsDir = path.resolve(__dirname, '..', '..', 'migrations');
  await migrate(pool, migrationsDir);
});

afterAll(async () => {
  if (schedulerLoop) schedulerLoop.stop();
  if (server) await server.close();
  if (pool) await pool.end();
});

afterEach(async () => {
  if (!dbAvailable) return;
  if (schedulerLoop) schedulerLoop.stop();
  await pool.query('DELETE FROM task_dependencies');
  await pool.query('DELETE FROM tasks');
  await pool.query('DELETE FROM workflows');
});

async function setupEngine(handlerRegistry: HandlerRegistry) {
  const built = await buildServer(pool, config, handlerRegistry);
  server = built.server;
  await server.ready();

  schedulerLoop = new SchedulerLoop(pool, built.taskRepo, server.log, 50);

  const taskCompleter = new TaskCompleter(
    pool,
    built.taskRepo,
    built.workflowRepo,
    schedulerLoop.getHeap(),
    server.log,
  );

  const workerPool = new WorkerPool(
    handlerRegistry,
    built.taskRepo,
    taskCompleter,
    pool,
    config,
    server.log,
  );

  schedulerLoop.setWorkerPool(workerPool);
  await schedulerLoop.loadReadyTasks();
  schedulerLoop.start();

  return built;
}

async function waitForWorkflowTerminal(workflowId: string, timeoutMs = 30000): Promise<string> {
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Workflow ${workflowId} did not reach terminal state within ${timeoutMs}ms`);
}

describe('Retry integration', () => {
  it('submit workflow with fail-n-times handler (fails first N-1 times, succeeds on Nth): workflow COMPLETED', async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const handlerRegistry = new HandlerRegistry();
    handlerRegistry.register('noop', async () => {});
    handlerRegistry.register('fail-n-times', async (input, ctx) => {
      const n = (input as { failCount?: number })?.failCount ?? 1;
      if (ctx.attempt <= n) throw new Error(`intentional failure on attempt ${ctx.attempt}`);
    });

    await setupEngine(handlerRegistry);

    const response = await server.inject({
      method: 'POST',
      url: '/workflows',
      payload: {
        tasks: [
          {
            id: 'A',
            handler: 'fail-n-times',
            input: { failCount: 2 },
            retryPolicy: { maxAttempts: 5, backoffBase: 100, backoffCap: 500 },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const { workflowId } = JSON.parse(response.body);

    const finalStatus = await waitForWorkflowTerminal(workflowId);
    expect(finalStatus).toBe('COMPLETED');

    const taskResult = await pool.query<{ attempts: number; status: string }>(
      `SELECT attempts, status FROM tasks WHERE workflow_id = $1`,
      [workflowId],
    );
    expect(taskResult.rows[0]!.status).toBe('COMPLETED');
    expect(taskResult.rows[0]!.attempts).toBe(3);
  });

  it('submit with maxAttempts=1 and failing handler: task goes directly to FAILED', async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const handlerRegistry = new HandlerRegistry();
    handlerRegistry.register('noop', async () => {});
    handlerRegistry.register('always-fail', async () => {
      throw new Error('always fails');
    });

    await setupEngine(handlerRegistry);

    const response = await server.inject({
      method: 'POST',
      url: '/workflows',
      payload: {
        tasks: [
          {
            id: 'A',
            handler: 'always-fail',
            retryPolicy: { maxAttempts: 1, backoffBase: 100, backoffCap: 500 },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const { workflowId } = JSON.parse(response.body);

    const finalStatus = await waitForWorkflowTerminal(workflowId);
    expect(finalStatus).toBe('FAILED');

    const taskResult = await pool.query<{ attempts: number; status: string }>(
      `SELECT attempts, status FROM tasks WHERE workflow_id = $1`,
      [workflowId],
    );
    expect(taskResult.rows[0]!.status).toBe('FAILED');
    expect(taskResult.rows[0]!.attempts).toBe(1);
  });

  it('confirm backoff values in DB: attempts, last_sleep_ms, scheduled_at', async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const handlerRegistry = new HandlerRegistry();
    handlerRegistry.register('noop', async () => {});
    handlerRegistry.register('fail-n-times', async (input, ctx) => {
      const n = (input as { failCount?: number })?.failCount ?? 1;
      if (ctx.attempt <= n) throw new Error(`intentional failure on attempt ${ctx.attempt}`);
    });

    await setupEngine(handlerRegistry);

    const response = await server.inject({
      method: 'POST',
      url: '/workflows',
      payload: {
        tasks: [
          {
            id: 'A',
            handler: 'fail-n-times',
            input: { failCount: 1 },
            retryPolicy: { maxAttempts: 3, backoffBase: 100, backoffCap: 5000 },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const { workflowId } = JSON.parse(response.body);

    const finalStatus = await waitForWorkflowTerminal(workflowId);
    expect(finalStatus).toBe('COMPLETED');

    // Query DB for backoff-related columns
    const taskResult = await pool.query<{
      attempts: number;
      last_sleep_ms: number;
      scheduled_at: Date;
      status: string;
    }>(
      `SELECT attempts, last_sleep_ms, scheduled_at FROM tasks WHERE workflow_id = $1`,
      [workflowId],
    );

    const task = taskResult.rows[0]!;

    // Task failed once and succeeded on attempt 2
    expect(task.attempts).toBe(2);

    // After the first failure, backoff should have been applied
    // last_sleep_ms should be >= backoffBase (100) and <= backoffCap (5000)
    expect(task.last_sleep_ms).toBeGreaterThanOrEqual(100);
    expect(task.last_sleep_ms).toBeLessThanOrEqual(5000);

    // scheduled_at should be a valid timestamp
    expect(task.scheduled_at).toBeInstanceOf(Date);
  });

  it('submit with timeoutMs=100 and slow handler (5s): workflow fails due to timeout', async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const handlerRegistry = new HandlerRegistry();
    handlerRegistry.register('noop', async () => {});
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

    await setupEngine(handlerRegistry);

    const response = await server.inject({
      method: 'POST',
      url: '/workflows',
      payload: {
        tasks: [
          {
            id: 'A',
            handler: 'slow',
            input: { ms: 5000 },
            timeoutMs: 100,
            retryPolicy: { maxAttempts: 1, backoffBase: 100, backoffCap: 500 },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const { workflowId } = JSON.parse(response.body);

    const finalStatus = await waitForWorkflowTerminal(workflowId);
    expect(finalStatus).toBe('FAILED');

    const taskResult = await pool.query<{ status: string; error: string | null; attempts: number }>(
      `SELECT status, error, attempts FROM tasks WHERE workflow_id = $1`,
      [workflowId],
    );

    const task = taskResult.rows[0]!;
    expect(task.status).toBe('FAILED');
    expect(task.attempts).toBe(1);
    // The error should indicate a timeout occurred
    expect(task.error).toBeDefined();
    expect(task.error!.toLowerCase()).toMatch(/timeout|abort/);
  });
});
