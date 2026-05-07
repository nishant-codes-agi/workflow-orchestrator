import { describe, it, expect, afterEach } from 'vitest';
import { HandlerRegistry } from '../../src/engine/handler-registry.js';
import {
  startTestServer,
  submitWorkflow,
  waitForWorkflowTerminalDB,
  cleanDB,
  type TestServer,
} from '../helpers/test-server.js';

/**
 * 500-TASK DIAMOND DAG integration test.
 *
 * Shape:
 *   Node 0 is the source (no deps).
 *   Nodes 1-498 depend on node 0 (fan-out).
 *   Node 499 depends on all of nodes 1-498 (fan-in).
 *
 * All use 'noop' handler.
 * WORKER_COUNT=10
 * Must complete in < 30 seconds.
 */

let ts: TestServer | null = null;

afterEach(async () => {
  if (ts) {
    await cleanDB(ts.pool);
    await ts.cleanup();
    ts = null;
  }
});

describe('500-task diamond DAG', () => {
  it(
    'executes 500-task diamond DAG under 10 concurrent workers',
    async (ctx) => {
      const handlerRegistry = new HandlerRegistry();
      handlerRegistry.register('noop', async () => {});

      try {
        ts = await startTestServer(handlerRegistry, { workerCount: 10 });
      } catch {
        console.warn('⚠  Postgres not reachable — skipping diamond DAG test.');
        ctx.skip();
        return;
      }

      const { server, pool } = ts;
      await cleanDB(pool);

      // Track concurrent running tasks to verify semaphore bound
      let maxConcurrent = 0;
      let currentConcurrent = 0;
      const concurrencyLock = {
        acquire() {
          currentConcurrent++;
          if (currentConcurrent > maxConcurrent) {
            maxConcurrent = currentConcurrent;
          }
        },
        release() {
          currentConcurrent--;
        },
      };

      // Re-register noop with concurrency tracking
      handlerRegistry.register('noop', async () => {
        concurrencyLock.acquire();
        // Small delay to make concurrency observable
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrencyLock.release();
      });

      // Build the 500-task diamond DAG programmatically
      const tasks: Array<{
        id: string;
        handler: string;
        dependsOn?: string[];
      }> = [];

      // Node 0: source (no deps)
      tasks.push({ id: 'node-0', handler: 'noop' });

      // Nodes 1-498: fan-out from node 0
      for (let i = 1; i <= 498; i++) {
        tasks.push({
          id: `node-${i}`,
          handler: 'noop',
          dependsOn: ['node-0'],
        });
      }

      // Node 499: fan-in (depends on all of 1-498)
      const fanInDeps = Array.from({ length: 498 }, (_, i) => `node-${i + 1}`);
      tasks.push({
        id: 'node-499',
        handler: 'noop',
        dependsOn: fanInDeps,
      });

      const startTime = Date.now();

      // Submit via POST /workflows
      const workflowId = await submitWorkflow(server, tasks);

      // Wait for workflow to reach COMPLETED (poll with timeout)
      const finalStatus = await waitForWorkflowTerminalDB(pool, workflowId, 30000);
      expect(finalStatus).toBe('COMPLETED');

      const elapsedMs = Date.now() - startTime;

      // Assert: all 500 tasks COMPLETED
      const taskResult = await pool.query<{
        logical_id: string;
        status: string;
        completed_at: Date | null;
      }>(
        `SELECT logical_id, status, completed_at FROM tasks
         WHERE workflow_id = $1 ORDER BY submission_order`,
        [workflowId],
      );

      expect(taskResult.rows).toHaveLength(500);

      for (const task of taskResult.rows) {
        expect(task.status).toBe('COMPLETED');
      }

      // Assert: node 0 completed before any of 1-498
      const node0 = taskResult.rows.find((t) => t.logical_id === 'node-0');
      expect(node0).toBeDefined();
      const middleNodes = taskResult.rows.filter(
        (t) => t.logical_id !== 'node-0' && t.logical_id !== 'node-499',
      );
      const node0Time = new Date(node0?.completed_at ?? 0).getTime();
      for (const mid of middleNodes) {
        const midTime = new Date(mid.completed_at ?? 0).getTime();
        expect(node0Time).toBeLessThanOrEqual(midTime);
      }

      // Assert: node 499 completed last
      const node499 = taskResult.rows.find(
        (t) => t.logical_id === 'node-499',
      );
      expect(node499).toBeDefined();
      const node499Time = new Date(node499?.completed_at ?? 0).getTime();
      for (const mid of middleNodes) {
        const midTime = new Date(mid.completed_at ?? 0).getTime();
        expect(midTime).toBeLessThanOrEqual(node499Time);
      }

      // Assert: max concurrent running tasks never exceeded WORKER_COUNT (10)
      expect(maxConcurrent).toBeLessThanOrEqual(10);

      // Assert: test completed in < 30 seconds
      expect(elapsedMs).toBeLessThan(30000);

      console.log(
        `Diamond DAG: 500 tasks completed in ${elapsedMs}ms, max concurrency: ${maxConcurrent}`,
      );
    },
    30000,
  );
});
