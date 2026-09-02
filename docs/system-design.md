# FORGE — system design

A distributed workflow orchestration engine with durable execution.

This document describes what FORGE does, how it is built, how it behaves when parts of it
fail, and where its limits are. It is written for someone deciding whether the design is
sound, so it states the trade-offs rather than only the strengths.

---

## 1. Requirements

### Functional

| #   | Requirement                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------- |
| F1  | Define workflows as directed acyclic graphs of tasks, via API, SDK, CLI or a visual editor            |
| F2  | Execute tasks across a fleet of independent worker processes                                          |
| F3  | Run independent tasks concurrently; join on fan-in                                                    |
| F4  | Retry failed tasks with configurable exponential backoff and jitter                                   |
| F5  | Enforce a per-attempt timeout and a per-run timeout                                                   |
| F6  | Cancel a run in flight                                                                                |
| F7  | Recover automatically from worker crashes                                                             |
| F8  | Dead-letter tasks that exhaust their retry budget, and allow an operator to retry or acknowledge them |
| F9  | Schedule runs by cron or at a fixed time, durably                                                     |
| F10 | Version workflow definitions; in-flight runs keep the version they started with                       |
| F11 | Record an append-only execution history and stream it live                                            |
| F12 | Prevent duplicate runs for a caller-supplied idempotency key                                          |
| F13 | Conditionally skip nodes and prune branches                                                           |
| F14 | Expose traces, metrics and structured logs                                                            |

### Non-functional

| #   | Requirement                                                    | How it is met                                                          |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| N1  | **Durability.** No acknowledged run may be lost                | All state in PostgreSQL; transactional outbox for side effects         |
| N2  | **Crash safety.** Any process may die at any instant           | Leases, guarded transitions, idempotent consumers                      |
| N3  | **No stuck work.** Every task reaches a terminal state         | Lease expiry, retry sweeper, run-timeout sweeper                       |
| N4  | **Horizontal scalability** of API, workers and control plane   | Stateless processes; all coordination through the database             |
| N5  | **Observability.** One run is one trace                        | W3C trace context propagated through the queue                         |
| N6  | **Safety.** A submitted workflow cannot execute arbitrary code | Handler registry; purpose-built expression language                    |
| N7  | **Honest semantics**                                           | At-least-once delivery, at-most-once commit — stated, not claimed away |

### Explicitly out of scope

Multi-tenancy, an identity provider, cross-service distributed transactions, sub-second
scheduling latency, and workflows whose graph shape depends on runtime data (dynamic
fan-out over a collection).

---

## 2. Architecture

```
        ┌──────────────┐        ┌──────────────┐
        │ Web console  │        │  SDK / CLI   │
        │  (Next.js)   │        │              │
        └──────┬───────┘        └──────┬───────┘
               │      REST + SSE       │
               └───────────┬───────────┘
                           ▼
                  ┌─────────────────┐
                  │       API       │   validates, persists, returns
                  │    (NestJS)     │   — never executes a task
                  └────────┬────────┘
                           │ one transaction
                           ▼
        ┌──────────────────────────────────────┐
        │             PostgreSQL               │
        │  runs · tasks · attempts · leases    │   ← source of truth
        │  events · outbox · idempotency       │
        └───────┬──────────────────────┬───────┘
                │ poll                 │ claim lease, write result
                ▼                      │
        ┌─────────────────┐            │
        │  Control plane  │            │
        │  publisher      │            │
        │  advancer       │            │
        │  lease reaper   │            │
        │  retry sweeper  │            │
        │  cron scheduler │            │
        └────────┬────────┘            │
                 │ publish             │
                 ▼                     │
           ┌───────────┐               │
           │   Redis   │  transport    │
           │  queues   │  only         │
           │  pub/sub  │               │
           └─────┬─────┘               │
                 │ BRPOP               │
                 ▼                     │
        ┌─────────────────┐            │
        │  worker × N     ├────────────┘
        │  leases tasks   │
        └────────┬────────┘
                 │ OTLP
                 ▼
        ┌─────────────────────────┐
        │ Jaeger  ·  Prometheus   │
        └─────────────────────────┘
```

The arrow that matters most is the one from workers back to PostgreSQL. Workers read and
write execution state **directly**, under a lease. Redis only ever tells a worker that
work _may_ exist — it is never asked what the state is. That is why losing Redis costs
latency rather than correctness.

### Services

| Service           | Responsibility                                                                                   | Scaling                                    |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| **API**           | Definitions, run commands, queries, SSE. Never executes tasks                                    | Stateless, N replicas                      |
| **Control plane** | Outbox publisher, run advancer, lease reaper, retry sweeper, run-timeout sweeper, cron scheduler | N replicas; every loop is concurrency-safe |
| **Worker**        | Leases tasks, executes registered handlers, reports outcomes                                     | N replicas; scales on queue depth          |
| **Web**           | Operator console                                                                                 | Stateless, N replicas                      |
| **CLI/SDK**       | Programmatic and terminal access                                                                 | Client-side                                |

The control plane hosts six loops in one process rather than six deployments. They share
a connection pool and a Prisma client, they scale on the same axis, and each is a few
hundred lines — six containers would be operational cost with no isolation benefit. Each
loop is independently safe on N replicas, so scaling out is still one flag.

### Packages

`@forge/engine` is the important one. It is **pure**: DAG validation, cycle detection,
dependency resolution, the state machine, retry maths, lease arithmetic and the safe
expression evaluator, with no I/O whatsoever. The entire orchestration policy is a
function from a snapshot to a plan, which is why it has 190 tests that need no database.

`@forge/contracts` holds the Zod schemas and view models shared by every runtime and the
client, so the API and its consumers cannot drift.

---

## 3. Storage

PostgreSQL, via Prisma. Thirteen tables; the ones that carry the design:

| Table                 | Role                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `workflow_definition` | Stable identity of a workflow                                            |
| `workflow_version`    | **Immutable** executable snapshot, content-addressed by checksum         |
| `workflow_run`        | One execution; carries `eventSeq`, the per-run event counter             |
| `task_run`            | One node in one run. `attempts` / `failures` / `recoveries` are distinct |
| `task_attempt`        | One physical execution. **Unique on `(task_run_id, attempt_number)`**    |
| `worker_lease`        | Time-bounded claim. **Unique on `(task_run_id, attempt_number)`**        |
| `execution_event`     | Append-only history. Unique on `(workflow_run_id, seq)`                  |
| `outbox_event`        | Intent to publish, written in the state-change transaction               |
| `idempotency_record`  | Unique on `(scope, key)`                                                 |
| `dead_letter`         | Exhausted tasks awaiting a decision                                      |

### Constraints that do real work

These are not defensive decoration; each makes an invalid state unrepresentable:

- `task_attempt (task_run_id, attempt_number)` — two workers cannot both create attempt N
- `worker_lease (task_run_id, attempt_number)` — one holder per attempt, forever
- `execution_event (workflow_run_id, seq)` — a gap-free order clients can resume from
- `workflow_version (definition_id, checksum)` — re-saving an unchanged graph is a no-op
- `task_run (workflow_run_id, node_key)` — task creation is idempotent
- `idempotency_record (scope, key)` — arbitrates concurrent triggers

### Indexes

Every index backs a query that runs in a hot loop:

| Index                                           | Query                                     |
| ----------------------------------------------- | ----------------------------------------- |
| `outbox_event (status, availableAt, createdAt)` | publisher's `FOR UPDATE SKIP LOCKED` scan |
| `worker_lease (releasedAt, expiresAt)`          | reaper's expired-lease scan               |
| `task_run (state, nextAttemptAt)`               | retry sweeper's due-task scan             |
| `task_run (workflowRunId, state)`               | advance path loads all tasks for a run    |
| `workflow_run (state, createdAt DESC)`          | console run list                          |
| `workflow_run (state, startedAt)`               | run-timeout sweeper                       |

Indexes serving only hypothetical queries are omitted — they cost write throughput on the
busiest tables.

---

## 4. Execution lifecycle

```
 trigger ──▶ [transaction]  create run + all tasks + WORKFLOW_CREATED + outbox(RUN_ADVANCE)
                │
                ▼
 publisher ──▶ claim outbox batch ──▶ push to Redis ──▶ mark PUBLISHED
                │
                ▼
 advancer  ──▶ [transaction]  lock run row
                              load snapshot
                              engine.advanceRun(graph, run, tasks) → plan
                              apply transitions (each guarded by WHERE state = expected)
                              resolve node inputs from persisted upstream outputs
                              write events + outbox(TASK_DISPATCH)
                │
                ▼
 worker    ──▶ BRPOP ──▶ [transaction]  lock task row
                                        verify claimable
                                        INSERT task_attempt   ← unique guard
                                        INSERT worker_lease   ← unique guard
                                        task → RUNNING
                │
                ├── heartbeat renews the lease; a failed renewal aborts the work
                ├── AbortSignal fires on timeout, lease loss, or cancellation
                │
                ▼
           execute handler
                │
                ▼
           [transaction]  re-verify lease ownership
                          attempt → SUCCEEDED / FAILED
                          task    → SUCCEEDED / RETRYING / DEAD_LETTERED
                          outbox(RUN_ADVANCE)
                │
                └──▶ back to the advancer, until every task is terminal
```

### The scheduling decision

`advanceRun` is a pure function. Given the graph and a snapshot of task states it returns
a plan, and it is **idempotent by construction**: calling it twice on the same snapshot
produces the same plan, and applying a plan to an already-advanced run yields an empty
one. That property is what makes duplicate `run.advance` messages harmless.

Nodes are walked in topological order, so a cascade of skipped branches resolves in a
single pass:

1. any dependency that can never succeed → the node is `CANCELLED` (failure propagation)
2. any dependency unresolved → `BLOCKED`
3. all dependencies resolved, but no incoming edge _taken_ → `SKIPPED` (branch pruning)
4. node condition false → `SKIPPED`
5. otherwise → `QUEUED` + dispatch

A run completes when every task is terminal: `SUCCEEDED` if none failed, `FAILED` if any
did, `CANCELLED` if an operator asked.

---

## 5. Failure modes and recovery

| Failure                                 | Detection                   | Recovery                                                                       | Data loss                                            |
| --------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Worker `kill -9` mid-task               | Lease expires (TTL + grace) | Reaper marks the attempt `ABANDONED`, task → `QUEUED`, another worker takes it | None. Retry budget untouched                         |
| Worker hangs                            | Heartbeat stops             | As above                                                                       | None                                                 |
| Worker partitioned                      | Renewal fails               | Worker aborts its own work; reaper recovers the task                           | None. May briefly execute twice; only one can commit |
| API crashes mid-request                 | Transaction rolls back      | Client retries; idempotency key makes it safe                                  | None                                                 |
| API crashes after commit                | —                           | Run is durable; outbox delivers the dispatch                                   | None                                                 |
| Control plane crashes                   | Loops stop                  | Restart resumes; unpublished outbox rows are republished                       | None                                                 |
| Publisher crashes between push and mark | Row stays `PENDING`         | Republished — a duplicate, absorbed by idempotent consumers                    | None                                                 |
| PostgreSQL unavailable                  | Health checks fail          | Everything stops and waits. No progress, no corruption                         | None                                                 |
| Redis unavailable                       | Health checks fail          | Dispatch stalls. On recovery the outbox republishes and sweepers re-derive     | None                                                 |
| Redis **wiped**                         | —                           | Same as above: state was never there                                           | None                                                 |
| Task exceeds its timeout                | Worker's `AbortSignal`      | Attempt `TIMED_OUT`; retry policy applies                                      | None                                                 |
| Run exceeds its timeout                 | Run-timeout sweeper         | Run `TIMED_OUT`, outstanding tasks cancelled                                   | None                                                 |
| Task fails repeatedly                   | Retry budget exhausted      | `DEAD_LETTERED` with full attempt history                                      | None                                                 |
| Definition has a cycle                  | Validation at save          | Rejected with the cycle path                                                   | N/A                                                  |

### Why nothing gets stuck

Three independent mechanisms, each covering a case where no event will ever arrive:

- **Lease reaper** — a worker died, so nothing will report the outcome
- **Retry sweeper** — a backoff elapsed, and only a clock knows
- **Run-timeout sweeper** — a run is blocked on work no worker can execute

All three are idempotent and safe on N replicas. Losing a message costs latency; the
sweepers still converge.

---

## 6. Consistency and concurrency

**Isolation.** Read Committed (PostgreSQL's default) plus explicit row locks, rather than
Serializable. `advance()` takes `SELECT … FOR UPDATE` on the run row, which serialises
concurrent advances of the _same_ run while different runs proceed in parallel.
Serializable would push the cost onto every transaction to solve a problem one row lock
already solves.

**Guarded transitions.** Every state update carries `WHERE state = <expected>`. A zero
row count means another writer got there first — expected under concurrency, and why the
plan is recomputed rather than replayed. Combined with `assertTaskTransition`, an illegal
transition is impossible through normal paths.

**The state machine is enforced, not documented.** `RUNTIME_TASK_TRANSITIONS` is a
declared inventory of every transition the system performs and which component performs
it; a test asserts it is a subset of the transition table. This exists because two real
bugs shipped where a call site performed a transition the table forbade, and neither the
engine's tests nor the state machine's tests noticed — the defect lived exactly in the
gap between them.

**Serialisation failures** are retried with jittered backoff by `withTransaction`.

---

## 7. Idempotency

Three distinct levels, never conflated. Summarised here; ADR 005 has the full treatment.

| Level              | Guarantee               | Mechanism                                                     |
| ------------------ | ----------------------- | ------------------------------------------------------------- |
| Transport delivery | at-least-once           | Redis; outbox publishes before marking                        |
| Task attempt       | at-most-once **commit** | Unique `(task_run_id, attempt_number)` on attempts and leases |
| Logical execution  | at-least-once           | Retries and recovery are re-execution by design               |
| Run creation       | exactly-once per key    | `idempotency_record`, claimed before the run is built         |

**Handlers must be idempotent.** FORGE cannot make an HTTP POST happen exactly once —
nothing can, without the receiver's cooperation. It provides `$.node.attempt`, a natural
idempotency key in the run id and node key, and `nonRetryableErrors` for deterministic
failures.

---

## 8. Scalability

**What scales horizontally:** API, workers, control plane, console. All stateless; all
coordination through PostgreSQL.

**The bottleneck is PostgreSQL**, and that is a deliberate choice (ADR 001). Each task
transition is at least one round trip. Measures already taken:

- keyset pagination on run lists — `OFFSET` degrades linearly on an append-heavy table
- grouped aggregate queries instead of N+1 (`listRuns` fetches task counts for the whole
  page in one query)
- hourly throughput computed in PostgreSQL with `generate_series`, not by pulling 24
  hours of runs into Node
- payloads truncated and redacted before entering the event log
- indexes exactly matching the hot loops

**What would come next**, in order: PgBouncer (every worker replica holds connections);
partitioning `execution_event` and `task_attempt` by month; moving the event log to a
separate store; sharding by workflow key.

**Worker autoscaling is on queue depth, not CPU.** A worker blocked on a slow downstream
service uses almost no CPU while its queue grows — CPU-based autoscaling would scale down
at precisely the moment more capacity is needed.

---

## 9. Security

| Concern                                   | Measure                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arbitrary code execution via a definition | A node's `type` is a key into a registry of code the worker already contains. An unknown type fails the task; it never reaches a loader, a shell or an eval                 |
| Code execution via conditions             | Purpose-built parser: no assignment, no member access outside `$`, no host callables beyond five pure builtins. ADR 007                                                     |
| Prototype pollution                       | `__proto__`/`constructor`/`prototype` rejected at parse time and in payload validation; `Object.hasOwn` at every resolution step; contexts built with `Object.create(null)` |
| Injection                                 | Prisma parameterises everything. Raw SQL uses tagged templates with bound parameters                                                                                        |
| Oversized payloads                        | 256 KiB per document, 24 levels of nesting, 250 nodes, 1 MiB request body                                                                                                   |
| Identifier abuse                          | Workflow and node keys are validated slugs — they appear in queue names, paths and logs                                                                                     |
| Secret leakage                            | Redacted by path in the logger and before anything enters the event log                                                                                                     |
| Resource exhaustion                       | Per-request rate limit, per-attempt timeout, per-run timeout, bounded retry budget                                                                                          |
| Failure injection                         | `simulate.*` handlers only register when `FORGE_DEMO_MODE=true`, which the API refuses to combine with `NODE_ENV=production`                                                |

**Authentication is deliberately minimal** — a single shared API key, constant-time
compared. FORGE is an engineering demonstration and its interesting problems are
orchestration problems. What is _not_ skipped is the part that would be a real bug: the
comparison does not leak length or content, the key never appears in a log, and the guard
fails closed. Production needs an identity provider in front; this document says so
rather than implying the shared key is the design.

---

## 10. Trade-offs

Stated plainly, because the reasons matter more than the choices.

**PostgreSQL as the source of truth** costs throughput and buys correctness that is
straightforward to reason about. Wrong for a million tasks a second; right here.

**The transactional outbox** costs ~250ms of dispatch latency and one row per task, and
buys the guarantee that no state change loses its side effect.

**Leases** cost recovery latency bounded by the TTL, and buy automatic recovery from any
worker failure without human involvement.

**A pure engine** costs an extra layer between the database and the decision, and buys an
orchestration policy that is exhaustively testable without infrastructure. Every
scheduling rule has a unit test that runs in milliseconds.

**A bespoke expression language** costs expressiveness and a hand-written parser, and
buys the elimination of a code-execution surface.

**Cooperative cancellation** costs immediacy — a cancelled run waits for its running
tasks to notice — and buys the absence of a race between forcing a row to `CANCELLED` and
a worker writing its own completion.

**Co-locating six control-plane loops** costs blast-radius isolation and buys a much
simpler deployment. Each loop is independently scalable, so this can be revisited without
redesign.

**Eager task materialisation** (all tasks created with the run) costs one bulk insert and
rules out data-dependent fan-out, and buys a run whose full shape is durable from the
first millisecond.

---

## 11. Known limitations

Things FORGE does not do, stated so nobody discovers them the hard way:

1. **No dynamic fan-out.** The graph is fixed at trigger time. A workflow that needs "one
   task per item in this array" cannot express it. This is the most significant missing
   feature and would require the task set to grow during a run.
2. **No sub-workflows.** A workflow cannot invoke another as a node.
3. **No cross-run coordination.** No mutexes, no semaphores, no global rate limits across
   runs.
4. **No multi-tenancy.** One logical tenant per deployment.
5. **Single-region.** No cross-region replication or failover story.
6. **Handler code ships with the worker.** Adding a task type means deploying a worker
   image — deliberate (it is what makes arbitrary code execution impossible) but it does
   mean workflow authors and worker operators must coordinate.
7. **The run row lock serialises one run's advances.** A single very wide fan-out
   advances sequentially; different runs are unaffected.
