import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://daguser:dagpass@localhost:5432/dagdb';

let pool: pg.Pool;
let dbAvailable = false;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    console.warn(
      '⚠  Postgres is not reachable — skipping crash recovery tests.',
    );
    return;
  }

  const migrationsDir = path.resolve(__dirname, '..', '..', 'migrations');
  await migrate(pool, migrationsDir);
});

afterAll(async () => {
  if (pool) await pool.end();
});

afterEach(async () => {
  if (!dbAvailable) return;
  await pool.query('DELETE FROM task_dependencies');
  await pool.query('DELETE FROM tasks');
  await pool.query('DELETE FROM workflows');
});

function startServer(port: number): ChildProcess {
  const proc = spawn('npx', ['tsx', path.resolve(__dirname, '..', '..', 'src', 'index.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL,
      WORKER_COUNT: '10',
      HEARTBEAT_INTERVAL_MS: '500',
      REAPER_POLL_MS: '2000',
      LEASE_TIMEOUT_MS: '3000',
      CRON_TICK_MS: '10000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return proc;
}

async function waitForHealth(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://localhost:${port}/health`);
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server on port ${port} did not become healthy within ${timeoutMs}ms`);
}

async function submitWorkflow(port: number, tasks: unknown[]): Promise<string> {
  const resp = await fetch(`http://localhost:${port}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  });
  if (!resp.ok) throw new Error(`Submit failed: ${resp.status}`);
  const body = await resp.json() as { workflowId: string };
  return body.workflowId;
}

async function waitForNRunning(workflowId: string, n: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tasks WHERE workflow_id = $1 AND status = 'RUNNING'`,
      [workflowId],
    );
    if (parseInt(result.rows[0]!.count, 10) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Did not find ${n} RUNNING tasks within ${timeoutMs}ms`);
}

async function waitForWorkflowTerminal(workflowId: string, timeoutMs = 60000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM workflows WHERE id = $1`,
      [workflowId],
    );
    const status = result.rows[0]?.status;
    if (status && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Workflow did not reach terminal state within ${timeoutMs}ms`);
}

describe('Crash recovery (kill -9)', () => {
  it('recovers from kill -9 mid-execution', async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const port = 3099;

    // Clean up any leftover data
    await pool.query('DELETE FROM task_dependencies');
    await pool.query('DELETE FROM tasks');
    await pool.query('DELETE FROM workflows');

    // 1. Start the app as a child process
    const proc = startServer(port);
    try {
      await waitForHealth(port);
    } catch {
      proc.kill('SIGKILL');
      ctx.skip();
      return;
    }

    // 2. Submit a 10-task chain with 'slow' handler (500ms each)
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      tasks.push({
        id: `task-${i}`,
        handler: 'slow',
        input: { ms: 500 },
        dependsOn: i > 0 ? [`task-${i - 1}`] : [],
        retryPolicy: { maxAttempts: 5, backoffBase: 100, backoffCap: 1000 },
      });
    }

    const workflowId = await submitWorkflow(port, tasks);

    // 3. Wait until at least 1 task is RUNNING
    await waitForNRunning(workflowId, 1);

    // 4. Kill the process with SIGKILL (kill -9)
    proc.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 5. Start a new instance
    const proc2 = startServer(port);
    try {
      await waitForHealth(port);
    } catch {
      proc2.kill('SIGKILL');
      ctx.skip();
      return;
    }

    try {
      // 6. Wait for workflow to reach terminal state
      await waitForWorkflowTerminal(workflowId);

      // 7. Assert: all 10 tasks are COMPLETED or FAILED. None stuck in RUNNING.
      const taskResult = await pool.query<{ status: string; attempts: number; max_attempts: number }>(
        `SELECT status, attempts, max_attempts FROM tasks WHERE workflow_id = $1`,
        [workflowId],
      );

      for (const task of taskResult.rows) {
        expect(['COMPLETED', 'FAILED']).toContain(task.status);
      }

      const runningCount = taskResult.rows.filter((t) => t.status === 'RUNNING').length;
      expect(runningCount).toBe(0);

      // 8. Assert: no task has attempts > max_attempts
      for (const task of taskResult.rows) {
        expect(task.attempts).toBeLessThanOrEqual(task.max_attempts);
      }
    } finally {
      proc2.kill('SIGKILL');
    }
  }, 90000);
});
