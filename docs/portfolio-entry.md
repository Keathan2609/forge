# Portfolio entry — FORGE

## Project name

**FORGE**

## Category

Software Engineering / Distributed Systems

## One-line description

A self-hosted distributed workflow orchestration engine with durable execution, worker
leasing and a transactional outbox — built to keep running correctly when its own
components die.

## Short description

FORGE executes workflows defined as directed acyclic graphs across a fleet of independent
worker processes. Execution state lives entirely in PostgreSQL, so a worker can be killed
mid-task, the API can restart, and Redis can be wiped without any in-flight run losing
progress or reaching an incorrect terminal state.

It ships a REST API, a type-safe TypeScript SDK, a CLI, and a web console with a DAG
editor and live execution visualisation over server-sent events. Correctness is
demonstrated rather than asserted: an automated chaos script kills a real worker mid-task
and verifies, step by step, that another worker completes the run.

## Long description

Most job queues answer "run this function later". FORGE answers a harder question: "run
this graph of dependent tasks across a fleet, and still be correct after any component
dies at any instant."

Almost every design decision in it exists because of a specific failure mode:

- **A worker is `kill -9`'d mid-task.** Every attempt is held by a time-bounded lease its
  holder must renew. A dead worker stops renewing, the lease expires, and the control
  plane returns the task to the queue. Critically, that recovery does _not_ consume the
  application's retry budget — infrastructure failure and application failure are
  tracked in separate counters, because conflating them means a node configured to
  "retry three times if it fails" dead-letters after a cluster reschedules its pod twice.

- **A process commits and then dies before publishing.** State changes and their dispatch
  intent are written to a transactional outbox in the same transaction. The publisher
  pushes to Redis _before_ marking rows published, so a crash republishes rather than
  losing the message — duplicate delivery is absorbable, a lost dispatch is a stuck
  workflow.

- **A message is delivered twice.** FORGE does not claim exactly-once. It states three
  separate guarantees: at-least-once transport delivery, at-most-once _commit_ per
  attempt (enforced by two unique database constraints, not application logic), and
  at-least-once logical execution. Handlers are told plainly they must be idempotent.

- **A workflow is edited while a run is in flight.** Definitions are immutable and
  content-addressed by checksum; saving a change creates a new version, and running
  executions keep the exact document they started with.

The orchestration policy itself is a **pure function**. `advanceRun(graph, run, tasks)`
returns a plan with no I/O, which means fan-out, fan-in, conditional pruning, failure
propagation and completion detection are covered by 190 unit tests that need no
infrastructure at all.

Conditions on nodes and edges are evaluated by a purpose-built parser rather than `eval`,
`new Function` or `vm` — workflow definitions arrive over an HTTP API, so anything capable
of arbitrary property traversal would be a remote code execution primitive.

## Problem

Building a workflow engine is easy if nothing crashes. The interesting engineering is
entirely in the failure modes, and the ones that matter are invisible until they happen:

- A task stuck in `RUNNING` forever because the worker holding it vanished. This is the
  most common failure in home-grown job systems, and it is usually discovered days later.
- A state change that commits, followed by a process death before the queue publish — a
  workflow that will never make progress, with no signal that anything is wrong.
- Duplicate message delivery causing a payment to be charged twice.
- A workflow edited mid-run, silently changing the behaviour of executions already in
  flight.
- Retries that exhaust their budget on infrastructure churn rather than real failures.

Off-the-shelf answers exist (Temporal, Airflow, AWS Step Functions), but they hide exactly
the mechanisms that make them work.

## Solution

A five-runtime platform with one strict rule: **PostgreSQL is the only source of truth;
Redis carries messages and nothing else.**

| Component                 | Responsibility                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **API** (NestJS)          | Definitions, run commands, queries, SSE. Never executes a task                                   |
| **Control plane**         | Outbox publisher, run advancer, lease reaper, retry sweeper, run-timeout sweeper, cron scheduler |
| **Workers**               | Lease tasks, execute registered handlers under timeout and cancellation                          |
| **Web console** (Next.js) | DAG editor, live execution, worker fleet, dead-letter queue                                      |
| **CLI / SDK**             | Programmatic and terminal access                                                                 |

Workers read and write execution state directly in PostgreSQL under a lease. Redis only
ever signals that work _may_ exist — it is never asked what the state is, which is why
losing it costs latency rather than correctness.

Three independent sweepers guarantee nothing gets stuck, each covering a case where no
event will ever arrive: a worker died, a backoff elapsed, or a run is blocked on work no
worker can execute.

## Architecture

```
Console / SDK / CLI
        │ REST + SSE
        ▼
      API ──────────────┐ one transaction
        │               ▼
        │       PostgreSQL (source of truth)
        │       runs · tasks · attempts · leases
        │       events · outbox · idempotency
        │               │ poll
        │               ▼
        │       Control plane
        │       publisher · advancer · reaper · sweepers · cron
        │               │ publish
        │               ▼
        │            Redis (transport only)
        │               │ BRPOP
        │               ▼
        └──────────  worker × N  ──── claim lease, write result ──▶ PostgreSQL
                        │ OTLP
                        ▼
                 Jaeger · Prometheus
```

**Packages:** `engine` (pure orchestration — DAG analysis, state machine, retry maths,
expression parser; zero I/O), `contracts` (Zod schemas shared by every runtime and the
client), `database` (Prisma), `transport` (Redis), `sdk`, `observability`, `config`,
`logger`, `testing`.

## Core engineering challenges

**1. Recovering a task whose worker vanished, without corrupting the retry budget.**
Solved with leases plus a three-counter model (`attempts` / `failures` / `recoveries`).
The retry policy is evaluated against `failures` alone, so a crash costs latency rather
than a retry the application never got to use.

**2. Closing the dual-write gap between the database and the queue.** A transactional
outbox, with the publisher deliberately marking rows published _after_ pushing rather
than before — the reverse ordering silently drops every message whose push fails.

**3. Making duplicate delivery harmless.** Two unique constraints — one attempt row per
`(task, attempt number)`, one lease per attempt — make double execution unrepresentable
rather than merely unlikely. Two workers racing on the same dispatch both attempt the
insert; the loser rolls back and discards its message.

**4. Keeping the orchestration policy testable.** The scheduler is a pure function from a
snapshot to a plan, and it is idempotent by construction: applying a plan to an
already-advanced run yields an empty plan, which is what makes duplicate advance messages
safe.

**5. Evaluating user-supplied conditions without an RCE.** A hand-written lexer, parser
and evaluator for a language with no assignment, no member access outside the whitelisted
context, no loops and five pure builtins — plus bounded length and AST size, and explicit
rejection of prototype-reaching paths.

**6. Propagating one trace across five processes and a queue.** The W3C `traceparent` is
serialised into the outbox payload and the queue message and re-extracted by the consumer,
so an API request and the worker execution it causes ten seconds later on another host
belong to one trace.

**7. Concurrent idempotency.** The original implementation checked for an existing record
before creating a run — correct sequentially, and wrong under concurrency, where five
simultaneous triggers all pass the check. The fix claims the key _before_ doing the work
and lets the unique index arbitrate. Found by an integration test, not in production.

## Technology

**Backend** — TypeScript (strict, `noUncheckedIndexedAccess`), Node.js, NestJS,
PostgreSQL 17, Prisma 6, Redis 7, Zod
**Frontend** — Next.js 15 (App Router, React 19), CSS Modules, @xyflow/react
**Observability** — OpenTelemetry, Jaeger, Prometheus (prom-client), pino
**Infrastructure** — Docker multi-stage builds, Docker Compose, Kubernetes + Kustomize,
GitHub Actions
**Testing** — Vitest (unit + integration), Playwright (E2E), real PostgreSQL and Redis in
CI service containers
**Tooling** — pnpm workspaces, Turborepo, ESLint, Prettier

## Notable features

- Live DAG visualisation over SSE with resumable streams — a reconnecting client sends
  its last sequence number and receives exactly what it missed
- Visual DAG editor that validates against the _real engine_ over the API, and refuses to
  draw an edge that would create a cycle
- Dead-letter queue showing every attempt, including ones abandoned by lease expiry
- Worker fleet view with per-worker slot allocation
- Exponential backoff with full jitter, so a fan-out failing together does not
  re-synchronise into a second stampede
- Durable cron schedules; N control-plane replicas cannot double-fire an occurrence
- Content-addressed workflow versions — re-saving an unchanged graph is a no-op
- CLI with `--json`, meaningful exit codes, and `forge system status` usable as a CI gate
- Failure-injection handlers gated behind a demo flag the API refuses to combine with
  `NODE_ENV=production`

## Technical decisions

Seven ADRs, each covering context, alternatives considered, and consequences:

1. **PostgreSQL as the single source of truth** — rejects the Redis-primary design used
   by most Node job queues, accepting a throughput ceiling for multi-row atomicity and
   real constraints
2. **Redis as transport, never as state** — including why Redis Streams with consumer
   groups was rejected: it would create a second record of what is in flight
3. **Transactional outbox** — why push-then-mark, and why CDC was disproportionate here
4. **Worker leases** — and why recovery must not consume the retry budget
5. **Delivery semantics** — an explicit refusal to claim exactly-once, with the three
   levels stated separately
6. **Observability** — why fleet-wide gauges are read at scrape time rather than
   accumulated per-process
7. **A purpose-built expression language** — why not `vm`, and why not a general
   expression library

## What I built

Everything: schema design, the pure orchestration engine, all five runtimes, the SDK,
the CLI, the console including the DAG editor, the Docker and Kubernetes definitions, CI,
the test suites, and the documentation.

**Verified working**, not merely written:

- 370 unit tests across every package (190 of them in the pure engine), 13
  control-plane integration tests against real PostgreSQL and Redis, and 13 Playwright
  E2E tests driving the console against a live stack
- An automated chaos script that SIGKILLs a real worker mid-task and asserts on every
  step of the recovery
- Retries with visible exponential backoff, dead-lettering, failure propagation,
  concurrent idempotency and outbox republish — all exercised end to end

**Three real bugs were found and fixed during development**, all of one shape: a component
performed a state transition the state machine forbade, and the two test suites that
should have caught it each verified only their own half. The fix was a declared inventory
of every transition the runtime performs, asserted against the transition table — so that
class of bug now fails the build.

## GitHub description

> Distributed workflow orchestration engine with durable execution, worker leasing and a
> transactional outbox. TypeScript, PostgreSQL, Redis, OpenTelemetry. Survives worker
> crashes by design — with an automated chaos test that proves it.

## Suggested GitHub topics

```
typescript · nodejs · nestjs · nextjs · distributed-systems · workflow-engine
orchestration · event-driven · postgresql · redis · prisma · opentelemetry
observability · docker · kubernetes · dag · fault-tolerance · transactional-outbox
```

## Suggested portfolio tags

Distributed Systems · Backend Architecture · Fault Tolerance · Concurrency ·
Event-Driven Architecture · State Machines · Observability · API Design ·
Database Design · Full Stack · Infrastructure

## Suggested screenshot order

1. **Live execution** (`/console/runs/:id`) — the DAG mid-run with a node executing, the
   timeline beside it, and the task detail panel open. The single strongest image.
2. **Crash recovery** — the same view for a `crash-recovery-demo` run, showing
   `LEASE_EXPIRED` → `TASK_RECOVERED` → `TASK_STARTED` on a different worker.
3. **Chaos script output** — the terminal transcript of `pnpm demo:chaos`, with each step
   asserted.
4. **Retry sequence** — a `resilience-demo` timeline showing 1s → 2s backoff and a
   dead-letter.
5. **Dead-letter queue** — an entry expanded to show every attempt with its worker.
6. **Workflow editor** — mid-edit, with live validation from the engine.
7. **Worker fleet** — three workers with slot allocation visible.
8. **Overview** — throughput, success rate and outbox lag.
9. **Jaeger trace** — one trace spanning API → outbox → queue → worker.
10. **Architecture diagram** — from the README.

## Honest caveats

Worth stating, because they are the first things a careful reader will look for:

- **No dynamic fan-out.** The graph is fixed at trigger time; a workflow cannot create
  one task per item in a runtime collection. This is the most significant missing feature.
- **Authentication is a single shared API key.** Deliberate — the project's interesting
  problems are orchestration problems — but it is not a production auth model, and the
  documentation says so rather than implying otherwise.
- **The Kubernetes manifests are not production-ready.** `infra/kubernetes/README.md`
  enumerates the eight things that would have to change, including managed PostgreSQL,
  real secret management and TLS.
- **No performance benchmarks are claimed.** No load testing was carried out, so there are
  no throughput or latency figures to quote. The architectural bottleneck (PostgreSQL) is
  identified in the system design, along with what would be done next.
