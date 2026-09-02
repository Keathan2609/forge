# 005 — Delivery semantics: what FORGE actually guarantees

**Status:** accepted
**Date:** 2026-09-01

## Context

"Exactly-once" is the most over-claimed property in distributed systems. It is routinely
asserted by anything with a queue and a deduplication table, and it is almost always
false in the sense a user assumes — that their side effect happens precisely one time.

FORGE could make that claim. It has an outbox, unique constraints and idempotency keys.
This ADR exists to say precisely what is and is not true, because a workflow engine that
lies about its semantics is worse than one with weaker, honest ones: users build on the
guarantee they were given.

## Decision

**Three distinct concepts, named separately and never conflated.**

### 1. Transport delivery — _at-least-once_

A message on a Redis queue may be delivered more than once. The outbox publisher pushes
before marking (ADR 003), so a crash between the two republishes. A worker that pops a
message and dies loses it, and the sweepers re-derive the work later.

FORGE makes no attempt to make delivery exactly-once. It is not achievable over a
transport without transactions, and pretending otherwise would push the problem into
consumers that were not written to expect it.

### 2. Task attempt — _at-most-once commit, per attempt number_

This is where the real guarantee lives, and it is enforced by two unique constraints
rather than by application logic:

```
task_attempt   UNIQUE (task_run_id, attempt_number)
worker_lease   UNIQUE (task_run_id, attempt_number)
```

Two workers racing on the same dispatch both try to insert attempt N. Exactly one wins;
the loser's insert violates the constraint, its transaction rolls back, and it discards
the message. Completion is then accepted only from the worker still holding the live
lease, re-checked inside the completing transaction.

The result: **attempt N of a task commits its result at most once, ever.** The integration
suite asserts this directly by racing two claims for the same task.

### 3. Logical task execution — _at-least-once, with an at-most-once commit_

A task's handler may _run_ more than once — that is the entire point of retries, and it
is also what happens when a lease expires and another worker recovers the task. What
cannot happen is two of those runs both committing a result.

So: **if your handler has side effects, it must be idempotent.** FORGE cannot make an
HTTP POST to a payment provider happen exactly once; nothing can, without the provider's
cooperation. What FORGE provides is the tools to make it safe:

- `$.node.attempt` is in the execution context, so a handler can detect a retry
- the run id and node key form a natural idempotency key for a downstream provider
- `nonRetryableErrors` stops a deterministic failure from being retried at all

### API-level idempotency

`POST /v1/workflows/:key/runs` accepts an `Idempotency-Key`. The same key with the same
body returns the original run; the same key with a _different_ body is a `409`, because
silently returning an unrelated run would hide a client bug.

The claim is inserted _before_ the run is built, so the unique index arbitrates
concurrent triggers: exactly one transaction wins and the losers resolve against the
winner's record. This was a real bug — the original implementation only checked for an
existing record, which handles the sequential case and loses the concurrent one.

## Alternatives considered

**Claim exactly-once and rely on the idempotency table.** Rejected as dishonest. The
table makes _run creation_ idempotent; it says nothing about whether a handler's side
effect happened twice.

**Redis Streams with consumer groups and acknowledgement.** Better transport semantics
and a pending-entries list. Rejected in ADR 002 because it creates a second place
recording "which tasks are in flight". `worker_lease` already answers that durably, and
reconciling the two would be a source of bugs rather than of safety.

**Two-phase commit into user handlers.** Would require every handler to implement
prepare/commit. Rejected as an unreasonable burden that most real side effects (an HTTP
call) cannot satisfy anyway.

## Consequences

**Good.**

- The guarantee is precise, testable and tested. Each of the three levels has integration
  coverage.
- Handler authors are told plainly what they must do, rather than being lulled by a
  false promise.
- The constraints do the work. Correctness does not depend on getting the application
  logic right in every path, because the database refuses the invalid state.

**Bad, and accepted.**

- Users must write idempotent handlers. Documented in the README, in the handler
  registry's own comments, and here.
- Duplicate _execution_ is observable — a task can legitimately show three attempts where
  only one committed. The console shows all of them, including `ABANDONED` ones, because
  hiding them would misrepresent what happened.
- No cross-service transactional guarantee. FORGE orchestrates; it does not distribute
  transactions. A saga with compensating actions is the pattern for that, and FORGE's DAG
  is a reasonable way to express one.
