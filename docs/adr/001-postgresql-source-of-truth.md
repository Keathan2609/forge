# 001 — PostgreSQL is the single source of truth for execution state

**Status:** accepted
**Date:** 2026-09-01

## Context

A workflow engine has to answer one question correctly, at any moment, after any
failure: _what is the state of this run, and what should happen next?_

The tempting design is to keep that state where the work is queued. Redis is already
present as a transport, it is fast, and libraries like BullMQ store job state in it
directly. Several well-known Node orchestrators do exactly this.

The problem is what "state" means here. A FORGE run is not one job. It is a graph of
tasks with dependencies, a per-task retry budget, an attempt history, a set of leases,
and a completion rule that depends on all of the above. Answering "what should happen
next" means evaluating a predicate over the whole graph, transactionally, while other
processes are mutating parts of it.

## Decision

**PostgreSQL holds all execution state. Redis carries messages and nothing else.**

Concretely:

- every state transition is a row update in PostgreSQL, inside a transaction
- a queue message is a _hint_ that work may exist; consumers always re-read PostgreSQL
  before acting, and revalidate before writing
- Redis is never queried to determine what state something is in
- losing Redis entirely costs latency, not correctness

## Alternatives considered

**Redis as the primary store (BullMQ-style).** Fastest to build, and adequate when a
job is independent. Rejected because the operations FORGE needs are multi-row and must
be atomic: "mark this task succeeded, evaluate whether its three dependents are now
ready, queue the two that are, and complete the run if that was the last task" is one
transaction in PostgreSQL and a Lua script with hand-rolled locking in Redis. Redis also
offers no way to express the constraints that make duplicate execution impossible (see
ADR 005) — no unique indexes, no foreign keys, no `SELECT … FOR UPDATE`.

**Event sourcing with a projection.** Append events, rebuild state by replaying them.
Genuinely attractive for auditability, and FORGE keeps an append-only `execution_event`
log for exactly that reason. Rejected as the _primary_ model because every scheduling
decision would need either a replay or a separately-maintained projection, and a
projection that can lag is a projection that can hand a worker a stale answer. The
event log is a record of what happened, not the mechanism by which decisions are made.

**A dedicated workflow engine (Temporal, Cadence).** These solve the problem properly.
Rejected because the point of this project is to build the mechanism, not to operate
someone else's.

## Consequences

**Good.**

- Multi-row state transitions are atomic and expressible in one place.
- Uniqueness constraints do real work: `task_attempt(task_run_id, attempt_number)` and
  `worker_lease(task_run_id, attempt_number)` make double execution unrepresentable
  rather than merely unlikely (ADR 005).
- Recovery is trivial to reason about. After any crash, every process re-reads the same
  rows and reaches the same conclusion.
- `FLUSHALL` on Redis is survivable: the outbox republishes undelivered messages and the
  sweepers pick up whatever the lost messages would have triggered.

**Bad, and accepted.**

- PostgreSQL is the throughput ceiling. Every task transition is at least one round trip,
  and a fan-out of 50 is 50 rows. This is fine for the workloads FORGE targets
  (thousands of tasks per minute) and would need partitioning or sharding well before it
  is not.
- The row lock taken by `advance()` serialises concurrent advances of the _same_ run.
  Different runs proceed in parallel; a single very wide run does not.
- More moving parts than a Redis-only design: an outbox, a publisher, and sweepers all
  exist to bridge the durable store to the transport.

**Load-bearing consequence.** Because Redis is not the source of truth, every consumer
_must_ be written to re-read and revalidate. That discipline is what makes at-least-once
delivery safe, and it is enforced by `claimTask`, `completeTask` and `advance` all
re-checking state inside their transaction rather than trusting the message.
