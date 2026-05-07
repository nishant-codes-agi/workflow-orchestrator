# Architecture Diagram

```
                         ┌─────────────────────────────────────────────────┐
                         │              HTTP API (Fastify)                 │
                         │                                                │
                         │  POST /workflows    POST /workflows/:id/cancel │
                         │  GET  /workflows/:id    POST /schedules        │
                         │  GET  /health                                  │
                         └──────┬────────────────────────┬────────────────┘
                                │                        │
                         submit / cancel / query         │
                                │                        │
                         ┌──────▼────────────────────────▼────────────────┐
                         │             Workflow Service                    │
                         │                                                │
                         │  ┌──────────────┐  ┌────────────────────────┐  │
                         │  │DAG Validator │  │ Cancellation Manager   │  │
                         │  │(DFS 3-color) │  │ (Cooperative drain)    │  │
                         │  └──────────────┘  └────────────────────────┘  │
                         └──────┬──────────────────┬─────────────────┬────┘
                                │                  │                 │
                         persist │           fire   │        mark     │
                                │                  │      CANCELLING │
                         ┌──────▼──────────────────▼─────────────────▼────┐
                         │       PostgreSQL (persistence layer)           │
                         │                                                │
                         │  workflows │ tasks │ task_dependencies │       │
                         │  schedules │ migrations                        │
                         └──────────────────────┬────────────────────┬────┘
                                                │                    │
              load READY tasks on startup       │                    │
              + new-ready on dep completion     │                    │
                         ┌──────────────────────▼──┐                 │
                         │   Scheduler Loop         │                │
                         │   (tick every ~100ms)     │                │
                         │                          │                │
                         │  ┌─────────────────────┐ │                │
                         │  │ In-Memory Min-Heap  │ │                │
                         │  │ Priority Queue      │ │                │
                         │  │ (-priority,         │ │                │
                         │  │  sched_at, seq)     │ │                │
                         │  └────────┬────────────┘ │                │
                         └───────────┼──────────────┘                │
                                     │ dequeue                       │
                         ┌───────────▼──────────────┐                │
                         │   Worker Pool             │                │
                         │   (bounded semaphore,     │                │
                         │    N concurrent workers)  │                │
                         │                          │                │
                         │   ┌─────┐ ┌─────┐       │                │
                         │   │ W-1 │ │ W-N │  ...  │                │
                         │   └──┬──┘ └──┬──┘       │                │
                         │      │       │           │                │
                         │  execute handler         │                │
                         │  (Promise.race + timeout)│                │
                         │                          │                │
                         │  on complete:            │                │
                         │   UPDATE pending_deps    │                │
                         │   heartbeat / retry      │                │
                         └──────────┬───────────────┘                │
                                    │                                │
                         state transitions                           │
                         READY → RUNNING → COMPLETED/FAILED          │
                                    │                                │
                         ┌──────────▼───────────────┐                │
                         │  Recovery Reaper          │                │
                         │  (startup + periodic poll │                │
                         │   every REAPER_POLL_MS)   │                │
                         │                          │                │
                         │  Reclaim stale RUNNING   │                │
                         │  tasks via atomic         │                │
                         │  UPDATE...RETURNING       │                │
                         │                          │                │
                         │  → re-enqueue if within  │                │
                         │    retry policy           │                │
                         │  → else FAILED            │                │
                         └──────────────────────────┘                │
                                                                     │
                         ┌───────────────────────────────────────────┘
                         │
                         ▼
                         ┌──────────────────────────┐
                         │  Cron Scheduler           │
                         │  (tick every CRON_TICK_MS) │
                         │                          │
                         │  Poll due schedules       │
                         │  → parse cron expression  │
                         │  → submit workflow clone  │
                         │  → compute next_fire_at   │
                         │  (IANA tz, DST-aware)     │
                         └──────────────────────────┘
```

## Data Flow

1. **Submission:** `POST /workflows` validates the DAG (cycle detection), persists workflow + tasks + dependencies in a single transaction, marks zero-dependency tasks as `READY`.

2. **Scheduling:** The scheduler loop ticks every ~100ms, loading `READY` tasks from the DB into the in-memory min-heap. Tasks are dequeued in priority order and dispatched to workers when semaphore permits are available.

3. **Execution:** Each worker acquires a semaphore permit, claims the task via CAS guard (`UPDATE WHERE status='READY'`), starts a heartbeat interval, executes the handler with `Promise.race` timeout, and persists the outcome.

4. **Ready-set cascade:** On task completion, children's `pending_deps` are atomically decremented. The worker that observes `pending_deps = 0` is the unique enqueuer of the child task.

5. **Recovery:** The reaper reclaims tasks stuck in `RUNNING` with stale heartbeats. Tasks within retry budget get re-enqueued with decorrelated jitter backoff. Exhausted tasks transition to `FAILED`.

6. **Cron:** The cron scheduler polls for due schedules, deep-clones the workflow definition, submits it as a new workflow, and computes the next fire time with DST-aware timezone resolution.

## State Machines

### Workflow States

```
submit ──► RUNNING ──► all tasks terminal ──► COMPLETED
                  │                     └──► any FAILED ──► FAILED
                  │
                  └──► cancel request ──► CANCELLING
                                              │
                                    all tasks drained
                                              │
                                              ▼
                                          CANCELLED
```

### Task States

```
PENDING ──[pending_deps=0]──► READY ──[worker picks up]──► RUNNING
                                                               │
                                            ┌──────────────────┤
                                            │                  │
                                         success            failure
                                            │                  │
                                            ▼           attempts<max?
                                        COMPLETED         │        │
                                                        yes       no
                                                         │        │
                                                   PENDING      FAILED
                                                  (backoff)
                                                               │
                                          wf CANCELLING ──► CANCELLED
```
