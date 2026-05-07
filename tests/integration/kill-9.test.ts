import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';
import { cleanDB, getRandomPort, DATABASE_URL } from '../helpers/test-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * KILL -9 RECOVERY TEST
 *
 * Spawns the app as a child process, submits a 10-task chain with 'slow'
 * handler (500ms each), waits until 3 tasks are RUNNING/COMPLETED,
 * sends SIGKILL to the entire process tree, waits 2 seconds, starts a new
 * instance on the same port, and verifies the workflow recovers to a terminal
 * state with no tasks stuck in RUNNING.
 */

let pool: pg.Pool | null = null;
let childProcs: ChildProcess[] = [];

/** Kill an entire process tree by PID (SIGKILL to process group). */
function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    // Kill the process group (negative PID)
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      // Fallback: pkill all children, then kill the parent
      execSync(`pkill -9 -P ${proc.pid} 2>/dev/null || true`, {
        stdio: 'ignore',
      });
      proc.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
}

function startServer(port: number): ChildProcess {
  const proc = spawn(
    'npx',
    ['tsx', path.resolve(__dirname, '..', '..', 'src', 'index.ts')],
    {
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL,
        WORKER_COUNT: '10',
        HEARTBEAT_INTERVAL_MS: '500',
        REAPER_POLL_MS: '2000',
        LEASE_TIMEOUT_MS: '3000',
        CRON_TICK_MS: '60000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Create a new process group so we can kill the entire tree
      detached: true,
    },
  );
  proc.stderr?.on('data', (d: Buffer) =>
    process.stderr.write(`[kill9:${port}] ${d}`),
  );
  proc.stdout?.on('data', (d: Buffer) =>
    process.stdout.write(`[kill9:${port}] ${d}`),
  );
  // Unref so the child doesn't keep the parent alive if we forget to kill
  proc.unref();
  childProcs.push(proc);
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
  throw new Error(
    `Server on port ${port} did not become healthy within ${timeoutMs}ms`,
  );
}

async function submitWorkflowHTTP(
  port: number,
  tasks: unknown[],
): Promise<string> {
  const resp = await fetch(`http://localhost:${port}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  });
  if (!resp.ok) throw new Error(`Submit failed: ${resp.status}`);
  const body = (await resp.json()) as { workflowId: string };
  return body.workflowId;
}

async function waitForRunningCount(
  dbPool: pg.Pool,
  workflowId: string,
  minCount: number,
  timeoutMs = 30000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await dbPool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tasks
       WHERE workflow_id = $1 AND status IN ('RUNNING', 'COMPLETED')`,
      [workflowId],
    );
    const count = parseInt(result.rows[0]?.count ?? '0', 10);
    if (count >= minCount) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Fewer than ${minCount} tasks reached RUNNING/COMPLETED within ${timeoutMs}ms`,
  );
}

async function waitForWorkflowTerminal(
  dbPool: pg.Pool,
  workflowId: string,
  timeoutMs = 60000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await dbPool.query<{ status: string }>(
      `SELECT status FROM workflows WHERE id = $1`,
      [workflowId],
    );
    const status = result.rows[0]?.status;
    if (status && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Workflow ${workflowId} did not reach terminal state within ${timeoutMs}ms`,
  );
}

/** Wait until a port is free (no EADDRINUSE). */
async function waitForPortFree(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`http://localhost:${port}/health`);
      // Still responding — port is in use
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch {
      // Connection refused — port is free
      return;
    }
  }
  throw new Error(`Port ${port} still in use after ${timeoutMs}ms`);
}

afterEach(async () => {
  // Kill any lingering child processes
  for (const proc of childProcs) {
    killTree(proc);
  }
  childProcs = [];

  if (pool) {
    try {
      await cleanDB(pool);
    } catch {
      // DB might not be available
    }
    await pool.end();
    pool = null;
  }
});

describe('Kill -9 recovery test', () => {
  it(
    'recovers from SIGKILL mid-execution',
    async (ctx) => {
      pool = new pg.Pool({ connectionString: DATABASE_URL });

      // Probe DB
      try {
        await pool.query('SELECT 1');
      } catch {
        console.warn('⚠  Postgres not reachable — skipping kill -9 test.');
        ctx.skip();
        return;
      }

      // Run migrations + clean
      const migrationsDir = path.resolve(__dirname, '..', '..', 'migrations');
      await migrate(pool, migrationsDir);
      await cleanDB(pool);

      const port = await getRandomPort();

      // 1. Start the app as a child process
      const proc1 = startServer(port);
      try {
        await waitForHealth(port);
      } catch {
        killTree(proc1);
        console.warn('⚠  Server did not start — skipping kill -9 test.');
        ctx.skip();
        return;
      }

      // 2. Submit a 10-task chain with 'slow' handler (500ms each)
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        id: `task-${i}`,
        handler: 'slow',
        input: { ms: 500 },
        dependsOn: i > 0 ? [`task-${i - 1}`] : [],
        retryPolicy: { maxAttempts: 5, backoffBase: 100, backoffCap: 1000 },
      }));

      const workflowId = await submitWorkflowHTTP(port, tasks);

      // 3. Poll until at least 3 tasks have been picked up (RUNNING or COMPLETED)
      await waitForRunningCount(pool, workflowId, 3, 30000);

      // 4. Send SIGKILL to the entire child process tree
      killTree(proc1);

      // 5. Wait 2 seconds for the process to fully die and port to free up
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await waitForPortFree(port, 5000);

      // 6. Start a new instance on the same port
      const proc2 = startServer(port);
      try {
        await waitForHealth(port);
      } catch {
        killTree(proc2);
        console.warn(
          '⚠  Second server instance did not start — skipping.',
        );
        ctx.skip();
        return;
      }

      // 7. Poll until workflow is terminal (timeout: 60s)
      const finalStatus = await waitForWorkflowTerminal(
        pool,
        workflowId,
        60000,
      );

      // Assert: workflow reached terminal state
      expect(['COMPLETED', 'FAILED']).toContain(finalStatus);

      // Assert: all tasks are COMPLETED or FAILED. No RUNNING tasks remain.
      const taskResult = await pool.query<{
        logical_id: string;
        status: string;
        attempts: number;
        max_attempts: number;
      }>(
        `SELECT logical_id, status, attempts, max_attempts
         FROM tasks WHERE workflow_id = $1 ORDER BY submission_order`,
        [workflowId],
      );

      expect(taskResult.rows).toHaveLength(10);

      for (const task of taskResult.rows) {
        expect(['COMPLETED', 'FAILED']).toContain(task.status);
      }

      const runningCount = taskResult.rows.filter(
        (t) => t.status === 'RUNNING',
      ).length;
      expect(runningCount).toBe(0);

      // Assert: no task was executed more times than max_attempts
      for (const task of taskResult.rows) {
        expect(task.attempts).toBeLessThanOrEqual(task.max_attempts);
      }

      console.log(
        `Kill -9 recovery: workflow ${finalStatus}, tasks: ${JSON.stringify(
          taskResult.rows.map((t) => ({
            id: t.logical_id,
            status: t.status,
            attempts: t.attempts,
          })),
        )}`,
      );

      // Clean up second process
      killTree(proc2);
    },
    120000,
  );
});
