# 002 — Redis as transport, not as state

**Status:** accepted
**Date:** 2026-09-01

## Context

ADR 001 puts execution state in PostgreSQL. Something still has to get a task from
"ready" to a worker with low latency, and let a worker block rather than poll.

Polling PostgreSQL directly would work — `SELECT … FOR UPDATE SKIP LOCKED` is a
legitimate queue — but at N workers polling every 100ms it is a lot of load to add to
the database that is already the throughput ceiling, and the latency floor is the poll
interval.

## Decision

**Redis is the asynchronous transport: work queues (`LPUSH`/`BRPOP`) and pub/sub fan-out
for live events. It is never consulted for state.**

- `forge:q:tasks:<queue>` — task dispatch, partitioned by logical queue
- `forge:q:run-advance` — "this run may have new ready work"
- `forge:events:run:<id>` and `forge:events:all` — pub/sub for the console
- a small number of short-lived locks used only to _reduce duplicate work_, never to
  keep state correct

## Alternatives considered

**PostgreSQL `LISTEN`/`NOTIFY`.** No extra infrastructure, and transactional — the
notification fires on commit. Rejected mainly because payloads are limited to 8000 bytes
and, more importantly, notifications are _not durable_: a consumer that is disconnected
when a notification fires never receives it. That is recoverable via the sweepers, but it
also holds a dedicated connection per listener, which is expensive on the database.

**Postgres-backed queue via `SKIP LOCKED`.** Genuinely good, and FORGE already uses this
pattern for the outbox. Rejected for task dispatch because it means every worker polls
the database continuously; the whole point of Redis here is to let a worker block on
`BRPOP` and consume nothing until work exists.

**A real broker (RabbitMQ, NATS, Kafka).** Better delivery semantics, better routing,
better durability. Rejected as disproportionate: FORGE needs "wake up, there may be
work", and the durable record already lives elsewhere. Adding a broker would add an
operational component whose guarantees the design deliberately does not depend on.

## Consequences

**Good.**

- Sub-millisecond dispatch latency, and workers that consume no resources while idle.
- Queue partitioning by name comes free, so a `media` worker pool is a config change.
- Because correctness never depends on Redis, its failure modes are boring. Losing it
  stalls dispatch; it does not corrupt anything.

**Bad, and accepted.**

- At-least-once delivery only. Redis has no transactions spanning "pop" and "process",
  so a consumer that dies after popping loses the message. FORGE recovers via lease
  expiry and the sweepers, but that is a _recovery path_, not a delivery guarantee.
- Duplicates are normal, not exceptional. Every consumer must be idempotent (ADR 005).
- One more thing to run.

**Deliberate non-use.** FORGE does not use Redis Streams with consumer groups, which
would give per-message acknowledgement and a pending-entries list. That would be a
better queue — but it would also create a second place where "which tasks are in flight"
is recorded, and the whole design rests on there being exactly one such place. The
`worker_lease` table already answers that question, durably, and reconciling it with a
Redis PEL would be a source of bugs rather than a source of safety.
