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

// Integration tests for workflow cancellation.
//
// Tests 5-7 from the acceptance checklist:
// 5. Submit a 10-task slow workflow (1s each). Immediately cancel.
//    Confirm running tasks finish, rest CANCELLED.
// 6. GET /workflows/:id after cancel — confirm workflow status and task statuses.
// 7. Try cancelling the same workflow again — confirm 200 idempotent no-op.
//
// Requires a running Postgres instance. Set TEST_DATABASE_URL to override.
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
      '⚠  Postgres is not reachable — skipping cancel workflow tests.',
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
    built.workflowRepo,
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

async function waitForWorkflowStatus(
  workflowId: string,
  statuses: string[],
  timeoutMs = 30000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM workflows WHERE id = $1`,
      [workflowId],
    );
    const status = result.rows[0]?.status;
    if (status && statuses.includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Workflow ${workflowId} did not reach any of [${statuses.join(', ')}] within ${timeoutMs}ms`,
  );
}

async function waitForAnyTaskRunning(
  workflowId: string,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tasks WHERE workflow_id = $1 AND status = 'RUNNING'`,
      [workflowId],
    );
    if (parseInt(result.rows[0]!.count, 10) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `No tasks reached RUNNING state within ${timeoutMs}ms`,
  );
}

describe('Cancel workflow integration', () => {
  // ---------------------------------------------------------------------------
  // Tests 5, 6, 7: Submit 10-task chained slow workflow, cancel mid-execution,
  //                verify running tasks finish, rest CANCELLED. Then verify
  //                GET status and idempotent re-cancel.
  // ---------------------------------------------------------------------------
  it('submit 10-task slow workflow, cancel, running tasks finish, rest CANCELLED', async (ctx) => {
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

    // Submit 10 chained slow tasks (1s each). Tasks form a dependency chain:
    // task-0 → task-1 → ... → task-9
    // Only one task is READY at a time, giving us a wide cancellation window.
    // After task-0 completes (~1s), task-1 becomes READY, etc.
    // We cancel after task-0 starts running, so tasks 1-9 stay PENDING.
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `slow-${i}`,
      handler: 'slow',
      input: { ms: 1000 },
      dependsOn: i > 0 ? [`slow-${i - 1}`] : [],
      retryPolicy: { maxAttempts: 1, backoffBase: 100, backoffCap: 500 },
    }));

    const submitResponse = await server.inject({
      method: 'POST',
      url: '/workflows',
      payload: { tasks },
    });
    expect(submitResponse.statusCode).toBe(201);
    const { workflowId } = JSON.parse(submitResponse.body);

    // Wait until task-0 is RUNNING
    await waitForAnyTaskRunning(workflowId);

    // ---- Test 5: Cancel the workflow immediately ----
    const cancelResponse = await server.inject({
      method: 'POST',
      url: `/workflows/${workflowId}/cancel`,
    });

    expect(cancelResponse.statusCode).toBe(200);
    const cancelBody = JSON.parse(cancelResponse.body);
    expect(cancelBody.workflowId).toBe(workflowId);
    // Status should be CANCELLING (task-0 is still RUNNING)
    expect(['CANCELLING', 'CANCELLED']).toContain(cancelBody.status);

    // Wait for the workflow to reach terminal CANCELLED state
    // (task-0 needs to finish first, then checkWorkflowTermination transitions)
    const terminalStatus = await waitForWorkflowStatus(
      workflowId,
      ['CANCELLED'],
      30000,
    );
    expect(terminalStatus).toBe('CANCELLED');

    // Verify task statuses from DB
    const taskResult = await pool.query<{
      logical_id: string;
      status: string;
    }>(
      `SELECT logical_id, status FROM tasks WHERE workflow_id = $1 ORDER BY submission_order`,
      [workflowId],
    );

    expect(taskResult.rows).toHaveLength(10);

    // All tasks should be in a terminal state (no stuck RUNNING or PENDING tasks)
    for (const task of taskResult.rows) {
      expect(['COMPLETED', 'CANCELLED']).toContain(task.status);
    }

    // task-0 (the one that was running) should have completed
    expect(taskResult.rows[0]!.status).toBe('COMPLETED');

    // At least some of the later tasks should be CANCELLED (they were PENDING)
    const cancelledCount = taskResult.rows.filter(
      (t) => t.status === 'CANCELLED',
    ).length;
    expect(cancelledCount).toBeGreaterThan(0);

    // Running tasks should have completed (not stuck in RUNNING)
    const runningCount = taskResult.rows.filter(
      (t) => t.status === 'RUNNING',
    ).length;
    expect(runningCount).toBe(0);

    // ---- Test 6: GET /workflows/:id after cancel ----
    const getResponse = await server.inject({
      method: 'GET',
      url: `/workflows/${workflowId}`,
    });

    expect(getResponse.statusCode).toBe(200);
    const workflow = JSON.parse(getResponse.body);
    expect(workflow.id).toBe(workflowId);
    expect(workflow.status).toBe('CANCELLED');

    // Verify task statuses via API match DB
    expect(workflow.tasks).toHaveLength(10);
    for (const task of workflow.tasks) {
      expect(['COMPLETED', 'CANCELLED']).toContain(task.status);
    }

    // Verify same counts via API
    const apiCancelledCount = workflow.tasks.filter(
      (t: { status: string }) => t.status === 'CANCELLED',
    ).length;
    expect(apiCancelledCount).toBe(cancelledCount);

    // ---- Test 7: Cancel the same workflow again — 200 idempotent no-op ----
    const cancelAgainResponse = await server.inject({
      method: 'POST',
      url: `/workflows/${workflowId}/cancel`,
    });

    expect(cancelAgainResponse.statusCode).toBe(200);
    const cancelAgainBody = JSON.parse(cancelAgainResponse.body);
    expect(cancelAgainBody.workflowId).toBe(workflowId);
    expect(cancelAgainBody.status).toBe('CANCELLED');

    // Verify nothing changed in the DB after the idempotent cancel
    const taskResultAfter = await pool.query<{
      logical_id: string;
      status: string;
    }>(
      `SELECT logical_id, status FROM tasks WHERE workflow_id = $1 ORDER BY submission_order`,
      [workflowId],
    );

    // Same statuses as before
    for (let i = 0; i < taskResult.rows.length; i++) {
      expect(taskResultAfter.rows[i]!.status).toBe(
        taskResult.rows[i]!.status,
      );
    }
  }, 60000); // 60s timeout for this test
});
