# 003 — Transactional outbox for state-change side effects

**Status:** accepted
**Date:** 2026-09-01

## Context

State lives in PostgreSQL (ADR 001); messages travel over Redis (ADR 002). That leaves a
gap which has to be closed explicitly, because the naive version of the code is wrong in
a way that stays invisible until it isn't:

```ts
await prisma.taskRun.update({ where: { id }, data: { state: 'QUEUED' } });
await redis.lpush(queue, message); // ← the process can die here
```

The commit succeeds. The process dies. The push never happens. The task is `QUEUED`
forever with nothing on any queue that would deliver it, and nothing detects it — from
the database's point of view everything is fine.

Swapping the order does not help. It converts "lost dispatch" into "phantom dispatch for
a state change that was rolled back".

This is the dual-write problem. There is no arrangement of two independent systems that
solves it without a protocol.

## Decision

**Any state change requiring an asynchronous effect writes its intent to an
`outbox_event` row in the same transaction. A separate publisher moves rows to Redis.**

The publisher's ordering is the crux, and it is deliberately not the obvious one:

1. claim a batch with `SELECT … FOR UPDATE SKIP LOCKED` — no write yet
2. push each message to Redis
3. mark the rows `PUBLISHED` and commit

Marking before pushing would silently drop every message whose push failed. Doing it this
way means a crash between (2) and (3) _republishes_ on the next tick — a duplicate, which
every consumer already tolerates (ADR 005). Duplicate delivery is a cost the system
absorbs; a lost dispatch is a stuck workflow.

`FOR UPDATE SKIP LOCKED` is what lets N publisher replicas run without coordination: each
claims a disjoint set of rows, and a publisher that dies mid-batch releases its locks on
disconnect so another picks the rows up on the next tick.

## Alternatives considered

**Publish after commit and accept the risk.** Common, and works almost always. Rejected
because "almost always" here means a permanently stuck workflow with no signal — the
worst failure mode a workflow engine can have, since the user's entire mental model is
that the system will eventually make progress on its own.

**Two-phase commit / XA across PostgreSQL and Redis.** Redis has no XA support. Even with
a broker that does, distributed transactions are operationally miserable and a
coordinator failure blocks both resources.

**Change Data Capture (Debezium reading the WAL).** Genuinely the most robust option, and
what this pattern becomes at scale. Rejected as disproportionate: it means operating
Kafka Connect and a connector to solve a problem that ~120 lines of application code
solves adequately here. Worth revisiting if throughput ever demanded it.

**`LISTEN`/`NOTIFY` inside the transaction.** Notifications fire on commit, which is
atomicity of a sort — but they are not durable, so a consumer that is disconnected when
one fires misses it permanently. That converts one lost-message problem into another.

## Consequences

**Good.**

- No state change can lose its side effect. The intent is exactly as durable as the state
  that caused it.
- The publisher is stateless and horizontally scalable.
- `forge_outbox_lag_seconds` — the age of the oldest unpublished row — is a single number
  that reveals a control plane failing to dispatch. It is the one signal that catches a
  failure invisible in every other metric, which is why the control plane's own `/health`
  reports degraded when it exceeds 30 seconds.
- The outbox doubles as a diagnostic record of every dispatch decision made.

**Bad, and accepted.**

- Latency. A dispatch waits for the publisher's poll interval (250ms by default) rather
  than going straight to Redis. Fine for workflow orchestration; it would not be for a
  trading system.
- Write amplification: one extra row per dispatched task.
- The table grows and must be pruned. Published rows are deleted after six hours by the
  maintenance sweeper — the outbox is a queue, not the audit log. `execution_event` is the
  audit log, and it is never pruned by the application.
- A poison payload that fails to publish repeatedly is parked as `FAILED` after ten
  attempts rather than retried forever, so it cannot starve the rows behind it. Resolving
  it needs an operator; `forge system status` surfaces the count.
