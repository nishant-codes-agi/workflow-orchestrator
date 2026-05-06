import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../../src/server.js';
import { HandlerRegistry } from '../../src/engine/handler-registry.js';
import { SchedulerLoop } from '../../src/engine/scheduler-loop.js';
import { WorkerPool } from '../../src/engine/worker-pool.js';
import { TaskCompleter } from '../../src/engine/task-completer.js';
import { CronScheduler } from '../../src/cron/cron-scheduler.js';
import { migrate } from '../../src/db/migrate.js';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Integration tests for the cron scheduling system.
//
// Tests 2-4 from the acceptance checklist:
// 2. POST a schedule via API with cronExpression '*/1 * * * *', timezone UTC.
//    Confirm nextFireAt in response is ~1 min from now.
// 3. Wait 1-2 minutes, query DB: confirm last_fired_at is populated, next_fire_at advanced.
// 4. Confirm a workflow was auto-created by the cron fire.
//
// Requires a running Postgres instance. Set TEST_DATABASE_URL to override.
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://daguser:dagpass@localhost:5432/dagdb';

let pool: pg.Pool;
let server: FastifyInstance;
let dbAvailable = false;
let schedulerLoop: SchedulerLoop;
let cronScheduler: CronScheduler;

const config: Config = {
  port: 0,
  databaseUrl: DATABASE_URL,
  workerCount: 4,
  heartbeatIntervalMs: 5000,
  reaperPollMs: 30000,
  leaseTimeoutMs: 15000,
  cronTickMs: 5000, // 5s tick for faster testing
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    console.warn(
      '⚠  Postgres is not reachable — skipping cron schedule tests.',
    );
    return;
  }

  const migrationsDir = path.resolve(__dirname, '..', '..', 'migrations');
  await migrate(pool, migrationsDir);
});

afterAll(async () => {
  if (cronScheduler) cronScheduler.stop();
  if (schedulerLoop) schedulerLoop.stop();
  if (server) await server.close();
  if (pool) await pool.end();
});

afterEach(async () => {
  if (!dbAvailable) return;
  if (cronScheduler) cronScheduler.stop();
  if (schedulerLoop) schedulerLoop.stop();
  await pool.query('DELETE FROM task_dependencies');
  await pool.query('DELETE FROM tasks');
  await pool.query('DELETE FROM workflows');
  await pool.query('DELETE FROM schedules');
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
    built.workflowRepo,
    taskCompleter,
    pool,
    config,
    server.log,
  );

  schedulerLoop.setWorkerPool(workerPool);
  await schedulerLoop.loadReadyTasks();
  schedulerLoop.start();

  cronScheduler = new CronScheduler(
    pool,
    built.scheduleRepo,
    built.workflowService,
    server.log,
    config.cronTickMs,
  );

  return built;
}

describe('Cron schedule integration', () => {
  // ---------------------------------------------------------------------------
  // Test 2: POST a schedule with '*/1 * * * *', confirm nextFireAt ~ 1 min away
  // ---------------------------------------------------------------------------
  it('POST /schedules with every-minute cron — nextFireAt is ~1 min from now', async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const handlerRegistry = new HandlerRegistry();
    handlerRegistry.register('noop', async () => {});

    await setupEngine(handlerRegistry);

    const now = Date.now();

    const response = await server.inject({
      method: 'POST',
      url: '/schedules',
      payload: {
        cronExpression: '*/1 * * * *',
        timezone: 'UTC',
        workflowDefinition: {
          tasks: [{ id: 'cron-task', handler: 'noop' }],
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('scheduleId');
    expect(body).toHaveProperty('nextFireAt');

    // nextFireAt should be within ~0-120 seconds from now
    const nextFireAt = new Date(body.nextFireAt).getTime();
    const diffMs = nextFireAt - now;
    expect(diffMs).toBeGreaterThan(0);
    expect(diffMs).toBeLessThanOrEqual(120_000); // at most ~2 minutes ahead
  });

  // ---------------------------------------------------------------------------
  // Tests 3 & 4: Schedule fires → DB updated + workflow auto-created
  // ---------------------------------------------------------------------------
  it('cron tick fires schedule, updates DB, and creates workflow', async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const handlerRegistry = new HandlerRegistry();
    handlerRegistry.register('noop', async () => {});

    const built = await setupEngine(handlerRegistry);

    // Insert a schedule with next_fire_at in the past so the very next tick fires it
    const pastTime = new Date(Date.now() - 60_000); // 1 minute ago
    await pool.query(
      `INSERT INTO schedules (cron_expression, timezone, workflow_definition, next_fire_at, enabled)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [
        '*/1 * * * *',
        'UTC',
        JSON.stringify({ tasks: [{ id: 'auto-task', handler: 'noop' }] }),
        pastTime,
      ],
    );

    // Verify schedule exists and last_fired_at is null before tick
    const beforeResult = await pool.query<{
      id: string;
      last_fired_at: Date | null;
      next_fire_at: Date;
    }>(`SELECT id, last_fired_at, next_fire_at FROM schedules`);
    expect(beforeResult.rows).toHaveLength(1);
    expect(beforeResult.rows[0]!.last_fired_at).toBeNull();

    const originalNextFire = beforeResult.rows[0]!.next_fire_at;

    // Manually trigger a cron tick (instead of waiting for polling interval)
    await cronScheduler.tick();

    // ---- Test 3: Verify last_fired_at is populated and next_fire_at advanced ----
    const afterResult = await pool.query<{
      last_fired_at: Date | null;
      next_fire_at: Date;
    }>(`SELECT last_fired_at, next_fire_at FROM schedules`);
    expect(afterResult.rows).toHaveLength(1);

    const schedule = afterResult.rows[0]!;
    expect(schedule.last_fired_at).not.toBeNull();
    expect(schedule.last_fired_at).toBeInstanceOf(Date);

    // next_fire_at should have advanced beyond the original value
    const newNextFire = new Date(schedule.next_fire_at).getTime();
    const oldNextFire = new Date(originalNextFire).getTime();
    expect(newNextFire).toBeGreaterThan(oldNextFire);

    // ---- Test 4: Confirm a workflow was auto-created by the cron fire ----
    const workflowResult = await pool.query<{
      id: string;
      status: string;
      created_at: Date;
    }>(`SELECT id, status, created_at FROM workflows ORDER BY created_at DESC`);

    expect(workflowResult.rows.length).toBeGreaterThanOrEqual(1);

    const createdWorkflow = workflowResult.rows[0]!;
    expect(createdWorkflow.status).toBe('RUNNING');

    // Verify the workflow has the expected task
    const taskResult = await pool.query<{
      logical_id: string;
      handler_name: string;
    }>(
      `SELECT logical_id, handler_name FROM tasks WHERE workflow_id = $1`,
      [createdWorkflow.id],
    );
    expect(taskResult.rows).toHaveLength(1);
    expect(taskResult.rows[0]!.logical_id).toBe('auto-task');
    expect(taskResult.rows[0]!.handler_name).toBe('noop');
  });
});
