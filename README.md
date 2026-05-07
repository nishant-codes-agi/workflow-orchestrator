# DAG-Based Workflow Orchestrator

A production-grade DAG-based workflow orchestrator built from scratch in Node.js + TypeScript with PostgreSQL for persistence and Fastify for the HTTP API. Single-process, 10 concurrent workers, handles 500-task diamond DAGs in under 5 seconds.

## Quick Start

```bash
# One command to start everything
docker compose up --build
```

The app waits for PostgreSQL to be healthy, runs migrations automatically, and starts listening on port 3000.

```bash
# Verify it's running
curl http://localhost:3000/health
# {"status":"ok","db":"connected"}
```

## Setup

### Prerequisites

- Docker & Docker Compose (recommended)
- Or: Node.js 20+, PostgreSQL 16+

### Docker (full stack)

```bash
docker compose up --build
```

### Local development

```bash
# Start Postgres
docker compose up postgres -d

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env: change DATABASE_URL host from 'postgres' to 'localhost'

# Run dev server (with hot reload)
npm run dev
```

### Running tests

```bash
# All unit tests
npm test

# Integration tests only (requires running Postgres)
npm run test:integration

# Lint
npm run lint

# Type check
npx tsc --noEmit
```

## API Reference

### POST /workflows

Submit a DAG workflow for execution. Returns immediately after persisting.

```bash
curl -X POST http://localhost:3000/workflows \
  -H 'Content-Type: application/json' \
  -d '{
    "tasks": [
      { "id": "A", "handler": "noop", "dependsOn": [] },
      { "id": "B", "handler": "noop", "dependsOn": ["A"] },
      { "id": "C", "handler": "noop", "dependsOn": ["A"] },
      { "id": "D", "handler": "noop", "dependsOn": ["B", "C"] }
    ]
  }'
```

**Response:** `201 { "workflowId": "uuid" }`

Each task supports:
- `id` (string, required) -- caller-supplied logical ID
- `handler` (string, required) -- registered handler name
- `input` (any) -- opaque JSON passed to handler
- `dependsOn` (string[]) -- logical IDs of prerequisite tasks
- `retryPolicy` -- `{ maxAttempts, backoffBase, backoffCap }`
- `timeoutMs` (number) -- hard execution timeout per attempt
- `priority` (number) -- higher = more urgent

**Errors:**
- `422` with cycle path if DAG contains a cycle
- `422` if handler name is not registered

### GET /workflows/:id

Returns workflow status and per-task statuses.

```bash
curl http://localhost:3000/workflows/<workflowId>
```

**Response:** `200 { id, status, createdAt, updatedAt, tasks: [{ logicalId, status, handler, attempts, maxAttempts, error, completedAt }] }`

### POST /workflows/:id/cancel

Cooperative cancel. Running tasks drain to completion; pending/ready tasks are marked CANCELLED.

```bash
curl -X POST http://localhost:3000/workflows/<workflowId>/cancel
```

**Response:** `200 { workflowId, status: "CANCELLING" | "CANCELLED" }`
**Idempotent:** re-cancelling returns 200.

### POST /schedules

Register a cron schedule that auto-submits a workflow on each fire.

```bash
curl -X POST http://localhost:3000/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "cronExpression": "*/15 * * * *",
    "timezone": "America/New_York",
    "workflowDefinition": {
      "tasks": [{ "id": "job", "handler": "noop" }]
    }
  }'
```

**Response:** `201 { scheduleId, nextFireAt }`

Supports standard 5-field cron: `minute hour day-of-month month day-of-week`.

### GET /health

```bash
curl http://localhost:3000/health
```

**Response:** `200 { status: "ok", db: "connected" }`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | HTTP server port |
| `DATABASE_URL` | -- | PostgreSQL connection string |
| `WORKER_COUNT` | 10 | Max concurrent task executions |
| `HEARTBEAT_INTERVAL_MS` | 5000 | Worker heartbeat frequency |
| `REAPER_POLL_MS` | 30000 | Stale task reclamation interval |
| `LEASE_TIMEOUT_MS` | 15000 | Heartbeat staleness threshold |
| `CRON_TICK_MS` | 10000 | Cron schedule poll interval |

## Project Structure

```
src/
  index.ts                    # entry point + startup recovery sequence
  server.ts                   # Fastify setup + route registration
  config.ts                   # env parsing + validation
  db/
    pool.ts                   # pg Pool wrapper
    migrate.ts                # migration runner
  interfaces/
    task.ts                   # Task, TaskDefinition, TaskStatus
    workflow.ts               # Workflow, WorkflowDefinition, WorkflowStatus
    schedule.ts               # Schedule
  data-structures/
    min-heap.ts               # binary min-heap with compound key
    bounded-semaphore.ts      # integer counter + Promise waiter queue
    cycle-detector.ts         # DFS three-coloring cycle detection
  routes/
    workflow.routes.ts        # POST/GET /workflows, POST cancel
    schedule.routes.ts        # POST /schedules
  services/
    workflow.service.ts       # submission, query, cancel logic
  repositories/
    workflow.repository.ts    # workflow DB access
    task.repository.ts        # task DB access (CAS, ready-set, reaper)
    schedule.repository.ts    # schedule DB access
  engine/
    handler-registry.ts       # in-process Map<string, HandlerFn>
    scheduler-loop.ts         # tick-based heap-to-worker dispatch
    worker-pool.ts            # semaphore-bounded task execution
    task-completer.ts         # outcome persistence + ready-set cascade
    reaper.ts                 # heartbeat reaper + startup recovery
    backoff.ts                # decorrelated jitter formula
  cron/
    parser.ts                 # 5-field cron expression parser
    next-fire.ts              # DST-aware next fire time computation
    cron-scheduler.ts         # poll + fire + advance loop
migrations/                   # raw SQL schema files
tests/
  unit/                       # unit tests (data structures, engine, cron)
  integration/                # integration tests (diamond DAG, kill -9, retry storm)
  helpers/
    test-server.ts            # test HTTP client + DB cleanup
docs/
  design.md                   # data structure & design trade-off doc
  architecture.md             # architecture diagram + state machines
```

## Design Decisions

See [docs/design.md](docs/design.md) for detailed rationale on data structure choices, concurrency guarantees, and production hardening plans.

See [docs/architecture.md](docs/architecture.md) for the system architecture diagram and state machines.
