# Design Document: DAG-Based Workflow Orchestrator

## 1. Data Structures

### Min-Heap (Priority Queue)

The scheduling queue is a binary min-heap backed by a plain JavaScript array with O(log n) insert and extract-min via index-arithmetic sift operations.

**Compound sort key:** Tasks are ordered by `(-priority, scheduledAt, submissionOrder)`. Negated priority ensures higher-priority tasks surface first. Ties on priority fall through to earliest `scheduledAt`, then to FIFO by the database-assigned `submission_order` bigint. This three-level key prevents starvation across all observable dimensions.

**Why a binary heap over alternatives:**

| Option | Complexity | Rejected because |
|---|---|---|
| Array.sort() per dequeue | O(n log n) | Forbidden by spec |
| Sorted linked list | O(n) insert | Poor insert throughput under load |
| Fibonacci heap | O(1) amortised insert | High constant factors; overkill at this scale |
| Skip list | O(log n) probabilistic | More complex, no advantage over a heap |

The heap is a scheduling cache, not the source of truth. On crash, it is simply rebuilt from PostgreSQL by loading all `READY` tasks with `scheduled_at <= NOW()`. This means a process kill loses zero state.

### Bounded Semaphore

Worker concurrency is controlled by an integer-counter semaphore with a FIFO waiter queue. `acquire()` decrements the counter or suspends via a Promise resolver pushed onto an array. `release()` shifts the oldest waiter (FIFO fairness) or increments the counter.

No external packages (p-limit, async-pool) are used. The spec forbids library wrappers, and a 30-line class is trivially auditable compared to a transitive dependency.

### DFS Three-Coloring Cycle Detector

Cycle detection at submission time uses WHITE/GRAY/BLACK coloring on the `dependsOn` adjacency list. A back-edge (current node reaches a GRAY neighbor) proves a cycle. The full path from the GRAY ancestor to the current node is extracted from the DFS stack and returned in the 422 rejection error, giving callers a diagnostic like `Cycle detected: A -> B -> C -> A`.

Kahn's algorithm (BFS topological sort) was considered but only returns a boolean. The diagnostic value of the full cycle path justified DFS three-coloring at identical O(V+E) complexity.

## 2. Concurrency & Durability

### Strict Two-Write Protocol

Every task execution performs exactly two database writes:

1. **Write 1 (before execution):** `UPDATE tasks SET status='RUNNING', attempts=attempts+1, last_heartbeat_at=NOW() WHERE id=$1 AND status='READY' RETURNING attempts` -- the CAS guard. If `rowCount=0`, another worker already claimed this task; the current worker releases the semaphore and exits.
2. **Write 2 (after execution):** `status='COMPLETED'` or `status='FAILED'` with `completed_at=NOW()`.

A crash between Write 1 and Write 2 leaves the task in `RUNNING` with a stale heartbeat. The reaper reclaims it.

### Atomic Ready-Set Decrement

When a parent task completes, each child's `pending_deps` is decremented atomically:

```sql
UPDATE tasks SET pending_deps = pending_deps - 1
WHERE id = $1 AND status = 'PENDING'
RETURNING id, pending_deps, priority, scheduled_at, submission_order
```

The worker that observes `pending_deps = 0` in the RETURNING clause is the unique enqueuer of that child. This eliminates the TOCTOU race where two parents completing concurrently could both read `pending_deps = 1`, both write `0`, and both enqueue the child for double execution.

### Heartbeat & Reaper

While a task is `RUNNING`, the worker updates `last_heartbeat_at` every `HEARTBEAT_INTERVAL_MS` (default 5s). The reaper runs at startup and every `REAPER_POLL_MS` (default 30s), issuing a single atomic `UPDATE...RETURNING`:

- Tasks with `attempts >= max_attempts` transition to terminal `FAILED`.
- Tasks with retries remaining transition to `PENDING` with decorrelated jitter backoff applied inline via `random()`.

The single-statement approach avoids a TOCTOU window where a heartbeat could sneak in between a `SELECT` and a separate `UPDATE`.

### Decorrelated Jitter Backoff

Retry scheduling uses the AWS Architecture Blog's decorrelated jitter formula:

```
sleep = min(cap, random(base, prevSleep * 3))
```

`last_sleep_ms` is persisted per task so the jitter range self-adapts: short previous sleeps produce narrow ranges, long previous sleeps produce wide ranges. This naturally spreads retries across time without requiring coordination. The 100-task x 5-failure retry storm test validates that scheduled_at timestamps show non-zero standard deviation across same-attempt groups.

## 3. Cron

### Timezone-Aware Scheduling

Each schedule row stores an IANA timezone string (e.g. `America/New_York`). The `next_fire_at` column is always stored in UTC. The cron parser computes candidate fire times in local wall-clock time using `Intl.DateTimeFormat` with the `timeZone` option, then the result is a UTC `Date` object.

**DST handling:**
- **Spring forward (gap):** If the computed local time falls in the gap (e.g. 2:00-3:00 AM), skip to the first valid moment post-gap.
- **Fall back (fold):** If the local time occurs twice (e.g. 1:00-2:00 AM), fire on the first occurrence only (standard-time offset).

### Brute-Force vs Field-Skipping

The next-fire algorithm scans minute-by-minute with field-level skipping (skip entire days when month/DOM/DOW don't match, skip hours when hour doesn't match). Worst case for a yearly cron like `0 0 29 2 *` is O(525,600) Date object checks, which Node.js completes in under 100ms. A full field-skipping algorithm that jumps directly to the next matching month/day would reduce this to O(tens) of iterations, but introduces subtle bugs at DST boundaries where field arithmetic interacts with UTC offset changes. We chose correctness confidence over micro-optimization.

### 5-Field Parser

The parser handles the standard cron syntax: `*`, `*/n`, `n`, `n-m`, `n,m,k`, and combinations like `1-5,10,15`. Each field produces a `Set<number>` of matching values. Validation rejects out-of-range values with descriptive error messages. The `L` modifier for last-day-of-month is not required but noted as a v2 extension point.

## 4. Production Hardening

The following are out of scope for the single-process baseline but are designed-for in the current architecture:

### Multi-Process Workers

The CAS guard (`UPDATE WHERE status='READY'`) already prevents double-execution across processes. To scale horizontally: replace the in-memory heap with `SELECT ... FOR UPDATE SKIP LOCKED` as the task claiming primitive. Each worker process atomically claims a distinct `READY` task from the DB without coordination. Add a `workers` table with heartbeats for distributed lease management.

### Observability

- Structured JSON logging with `workflow_id` and `task_id` on every log line (already implemented via Fastify's pino).
- Prometheus metrics: `task_throughput_total`, `task_duration_p99`, `queue_depth`, `reaper_reclaimed_total`.
- OpenTelemetry spans per task execution for distributed tracing.
- Dead-letter queue: tasks that exhaust retries could be written to a separate `dead_letter_tasks` table for inspection.

### Schema Evolution

- Migrations are tracked in a `migrations` table, applied in alphabetical order at startup.
- `workflow_definition` is stored as JSONB in the `schedules` table, allowing per-workflow schema versioning without DDL changes.
- A named template registry (`POST /templates`) would allow v2 evolution of inline cron definitions.

### Security

- Handler names are validated against the registry at submission time (not at execution time).
- Input JSONB size limits (default 64KB) would prevent heap exhaustion via large payloads.
- Rate limiting on `POST /workflows` per API key would prevent queue flooding.
- Row-level security on the `workflows` table would enable multi-tenant deployment.
