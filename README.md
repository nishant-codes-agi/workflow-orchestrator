# DAG-Based Workflow Orchestrator

A production-grade DAG-based workflow orchestrator built with Node.js, TypeScript, PostgreSQL, and Fastify.

## Setup

### Prerequisites
- Node.js 20+
- Docker & Docker Compose

### Local development

```bash
# Start Postgres
docker compose up postgres -d

# Install dependencies
npm install

# Copy env
cp .env.example .env
# Edit .env to point DATABASE_URL to localhost

# Run dev server
npm run dev
```

### Docker (full stack)

```bash
docker compose up --build
```

### Running tests

```bash
npm test
```

## Project structure

```
src/
  index.ts              # entry point
  server.ts             # Fastify setup
  config.ts             # env parsing + validation
  db/
    pool.ts             # pg Pool wrapper
    migrate.ts          # migration runner
  interfaces/           # type contracts
  data-structures/      # heap, semaphore, cycle-detect
  routes/               # Fastify route handlers
  services/             # business logic
  repositories/         # DB access (repository pattern)
  engine/               # scheduler loop, worker pool, reaper
  cron/                 # cron parser + scheduler
migrations/             # raw SQL migration files
tests/
  unit/                 # unit tests
  integration/          # integration tests
  helpers/              # test utilities
```
