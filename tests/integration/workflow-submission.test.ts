import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../../src/server.js';
import { HandlerRegistry } from '../../src/engine/handler-registry.js';
import { migrate } from '../../src/db/migrate.js';
import type { FastifyInstance } from 'fastify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests for POST /workflows endpoint.
 *
 * Requires a running Postgres instance. By default uses the Docker Compose
 * database (localhost:5432). Set TEST_DATABASE_URL to override.
 *
 * When Postgres is unreachable the entire suite is skipped gracefully.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://daguser:dagpass@localhost:5432/dagdb';

let pool: pg.Pool;
let server: FastifyInstance;
let dbAvailable = false;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });

  // Probe the database — skip suite if it's not reachable
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    console.warn(
      '⚠  Postgres is not reachable — skipping integration tests. ' +
        'Start Docker Compose first: docker compose up -d',
    );
    return;
  }

  // Run migrations so tables exist
  const migrationsDir = path.resolve(__dirname, '..', '..', 'migrations');
  await migrate(pool, migrationsDir);

  // Register the same handlers the real app uses
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

  const config = {
    port: 0, // unused — we inject requests via server.inject()
    databaseUrl: DATABASE_URL,
    workerCount: 0,
    heartbeatIntervalMs: 5000,
    reaperPollMs: 30000,
    leaseTimeoutMs: 15000,
    cronTickMs: 10000,
  };

  const built = await buildServer(pool, config, handlerRegistry);
  server = built.server;

  await server.ready();
});

afterAll(async () => {
  if (server) await server.close();
  if (pool) await pool.end();
});

afterEach(async () => {
  if (!dbAvailable) return;
  // Clean up test data between tests (tasks first due to FK constraints)
  await pool.query('DELETE FROM task_dependencies');
  await pool.query('DELETE FROM tasks');
  await pool.query('DELETE FROM workflows');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /workflows', () => {
  // -----------------------------------------------------------------------
  // 1 & 2 & 3: Valid 3-task chain → 201, then verify DB rows
  // -----------------------------------------------------------------------
  it('should accept a valid 3-task chain workflow and return 201', async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // A → B → C  (chain: C depends on B, B depends on A)
    const response = await server.inject({
      method: 'POST',
      url: '/workflows',
      payload: {
        tasks: [
          { id: 'A', handler: 'noop' },
          { id: 'B', handler: 'noop', dependsOn: ['A'] },
          { id: 'C', handler: 'noop', dependsOn: ['B'] },
        ],
      },
    });

    // ---- Test 1: 201 response ----
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('workflowId');
    expect(typeof body.workflowId).toBe('string');

    const workflowId = body.workflowId;

    // ---- Test 2: Query DB directly ----
    const dbResult = await pool.query<{
      logical_id: string;
      status: string;
      pending_deps: number;
    }>(
      `SELECT logical_id, status, pending_deps
       FROM tasks
       WHERE workflow_id = $1
       ORDER BY submission_order`,
      [workflowId],
    );

    expect(dbResult.rows).toHaveLength(3);

    const taskMap = new Map(
      dbResult.rows.map((r) => [r.logical_id, r]),
    );

    // ---- Test 3: First task READY (pending_deps=0), others PENDING ----
    const taskA = taskMap.get('A')!;
    expect(taskA.status).toBe('READY');
    expect(taskA.pending_deps).toBe(0);

    const taskB = taskMap.get('B')!;
    expect(taskB.status).toBe('PENDING');
    expect(taskB.pending_deps).toBe(1);

    const taskC = taskMap.get('C')!;
    expect(taskC.status).toBe('PENDING');
    expect(taskC.pending_deps).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 4: Cycle detection → 422 with cycle path in error body
  // -----------------------------------------------------------------------
  it('should reject a workflow with a cycle (A->B->C->A) with 422', async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const response = await server.inject({
      method: 'POST',
      url: '/workflows',
      payload: {
        tasks: [
          { id: 'A', handler: 'noop', dependsOn: ['C'] },
          { id: 'B', handler: 'noop', dependsOn: ['A'] },
          { id: 'C', handler: 'noop', dependsOn: ['B'] },
        ],
      },
    });

    expect(response.statusCode).toBe(422);

    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('error');
    expect(body.error).toMatch(/[Cc]ycle/);

    // The error should contain the cycle path showing involved nodes
    expect(body.error).toContain('->');
  });

  // -----------------------------------------------------------------------
  // 5: Unknown handler → 422 with clear error
  // -----------------------------------------------------------------------
  it('should reject a workflow with an unknown handler with 422', async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const response = await server.inject({
      method: 'POST',
      url: '/workflows',
      payload: {
        tasks: [
          { id: 'X', handler: 'non-existent-handler-xyz' },
        ],
      },
    });

    expect(response.statusCode).toBe(422);

    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('error');
    expect(body.error).toMatch(/[Uu]nknown handler/);
    expect(body.error).toContain('non-existent-handler-xyz');
  });
});
