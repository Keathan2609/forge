# 004 — Worker leases, and why recovery does not consume the retry budget

**Status:** accepted
**Date:** 2026-09-01

## Context

A worker claims a task and starts executing. Then the process is `kill -9`'d, its node is
evicted, or it locks up. Nobody will ever report the outcome.

Without a mechanism, that task is `RUNNING` forever. This is the most common failure mode
in home-grown job systems, and it is usually discovered when somebody notices a job
"stuck" several days later.

## Decision

**Every task attempt is held by a time-bounded lease that its holder must renew.**

`worker_lease` records `(taskRunId, attemptNumber, workerId, acquiredAt, expiresAt,
heartbeatAt)`, unique on `(taskRunId, attemptNumber)`.

- A worker renews on a heartbeat interval that must be at most **one third** of the TTL,
  so it can miss two heartbeats without consequence. This is validated at process start
  (`assertValidLeaseConfig`) rather than discovered when a long task loses its lease.
- A renewal that fails means the lease is gone; the worker aborts its in-flight work
  immediately rather than continuing on borrowed time.
- A completion is accepted only from the worker that still holds a live lease, re-checked
  inside the completing transaction.
- The reaper reclaims leases expired by more than a grace period, marks the attempt
  `ABANDONED`, and returns the task to `QUEUED`.

### The part that is easy to get wrong

**A lease expiry does not consume the application's retry budget.**

`TaskRun` carries three counters, and the distinction between them is the whole point:

| Column       | Meaning                                        |
| ------------ | ---------------------------------------------- |
| `attempts`   | physical attempts started — monotonic          |
| `failures`   | attempts that failed for _application_ reasons |
| `recoveries` | attempts reclaimed after a lease expired       |

The retry policy is evaluated against `failures`, never `attempts`.

If it used `attempts`, a node with `maxAttempts: 3` deployed onto a cluster that
rescheduled its pod twice would dead-letter without the application code having failed
once. The user configured "retry my task three times if it fails", not "give up if
Kubernetes moves you around". Conflating infrastructure failure with application failure
makes the retry budget mean two different things at the same time, and the resulting
behaviour is impossible to explain to whoever is on call at 3am.

## Alternatives considered

**Visibility timeouts (SQS-style).** Equivalent in spirit and simpler — the message
becomes visible again after a timeout. Rejected because the timeout would live in the
queue, and FORGE's queue is explicitly not the source of truth. A lease in PostgreSQL can
be inspected, joined against and reported on: the console's "active lease" panel and the
`forge_worker_lease_recoveries_total` metric both fall out of it for free.

**Heartbeat the task row directly** (`UPDATE task_run SET heartbeat_at = now()`). One
fewer table. Rejected because it conflates "this task is executing" with "this specific
attempt by this specific worker is executing". The lease's `attemptNumber` is what lets a
completion be attributed to the correct attempt, and lets a stale worker's late
completion be rejected rather than silently overwriting a newer, correct result.

**Orchestrator-level detection** (watch for pod deletion). Rejected outright: it works
only on Kubernetes, catches only clean deletions, and would make the core correctness
property depend on the scheduler that happens to be running the workers.

## Consequences

**Good.**

- A worker can be killed at any instant, safely. `pnpm demo:chaos` proves this end to end
  and asserts on every step, so it is a test rather than a claim.
- Recovery is automatic and needs no human.
- The attempt ledger is honest: an `ABANDONED` attempt is visibly distinct from a
  `FAILED` one in the console and in the dead-letter history.
- Lease TTL is a per-deployment latency/safety trade-off, and it is a single number.

**Bad, and accepted.**

- Recovery latency is bounded below by the lease TTL plus the grace period plus the
  reaper's poll interval — roughly 20 seconds with the defaults. Shortening the TTL
  speeds recovery up but increases the chance of stealing a task from a worker that was
  merely slow.
- The grace period exists specifically so clock skew between a worker and the control
  plane cannot cause a spurious steal. It cannot be zero in a distributed deployment.
- Heartbeats are database writes. At one per in-flight task per interval across a large
  fleet this is real load, which is why the interval is configurable and the TTL is
  generous by default.

**Honest limitation.** A worker partitioned from the control plane but still able to
reach the outside world keeps executing until its own renewal fails. FORGE bounds this by
aborting the handler as soon as a renewal fails, and by capping each attempt's deadline at
the lease expiry (`effectiveDeadline`) — but between those two points there is a window in
which two workers could briefly be _executing_ the same task. The database prevents both
from _committing_; it does not prevent both from running. This is precisely why the
delivery semantics are stated as at-most-once **commit** rather than at-most-once
execution — see ADR 005.
