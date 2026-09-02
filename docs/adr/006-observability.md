# 006 — Observability: one trace across five processes

**Status:** accepted
**Date:** 2026-09-01

## Context

A single workflow run touches five runtimes and two datastores. When a run is slow or
wrong, the question is almost never "which service is broken" — it is "where did _this
particular run_ spend its time, and what happened to it".

Per-service logs cannot answer that. Neither can per-service dashboards. The run is the
unit of interest, and it crosses every process boundary in the system.

## Decision

**Three signals, each chosen for a different question, and correlated by run.**

### Traces — "what happened to this run"

OpenTelemetry, exported over OTLP to Jaeger. The W3C `traceparent` is serialised into the
outbox payload and the queue message, then re-extracted by the consumer
(`injectTraceContext` / `withExtractedContext`). One API request that triggers a run
produces one trace spanning:

```
POST /v1/workflows/:key/runs   (api)
  └─ outbox.publish            (control plane)
       └─ run.advance          (control plane)
            └─ task.execute    (worker, on another host, seconds later)
```

Propagating through a queue is the part that takes deliberate work — a trace that stops
at the queue boundary answers only half the question — and it is why the trace id is also
stored on `task_run` and `task_attempt`, so the console can link straight to Jaeger.

### Metrics — "is the system healthy, in aggregate"

Prometheus, exposed on `/metrics` by every runtime. Two categories, and the distinction
matters:

- **Counters and histograms** accumulated in-process from real code paths:
  `forge_tasks_started_total`, `forge_task_duration_seconds`,
  `forge_worker_lease_recoveries_total`.
- **Gauges collected at scrape time** from PostgreSQL: `forge_queue_depth`,
  `forge_active_workers`, `forge_outbox_lag_seconds`.

Fleet-wide values _must not_ be accumulated per-process. With three API replicas, each
would report a third of the truth, and a restart would zero the counter. Reading them
from the database when Prometheus scrapes keeps the number correct regardless of replica
count, and makes a stale value impossible.

### Logs — "what exactly did this component do"

Structured JSON via pino. Every line carries `service`, and — where applicable —
`workflowRunId`, `taskRunId`, `nodeKey`, `workerId`, `attempt` and `traceId`. Child
loggers bind that context once rather than threading it through call signatures.

Secrets are redacted by path at the logger, not at each call site, so a new field named
`password` is safe the moment it exists.

## Alternatives considered

**Logs only.** Cheapest. Rejected because reconstructing a distributed run from five log
streams is exactly the task tracing exists to eliminate.

**Traces only.** Tempting, since traces answer the hardest question. Rejected because
tracing is sampled and retained briefly; "how many tasks failed this week" is a metrics
question, and answering it from traces is both expensive and wrong.

**A vendor SDK (Datadog, New Relic).** Better out of the box. Rejected because it makes
the project's observability story a procurement decision rather than an engineering one,
and OTLP means any backend can be swapped in.

## Consequences

**Good.**

- One trace per run, across every process — which is the property that makes the
  observability real rather than decorative.
- Vendor-neutral. Jaeger and Prometheus are the local defaults; any OTLP-compatible
  backend works with an environment variable.
- Metric cardinality is deliberately bounded: HTTP routes are labelled by _template_
  (`/v1/runs/:id`), never by concrete path. Labelling by run id would create one time
  series per run and take the metrics endpoint down within an hour.
- Telemetry failing never takes the service down. The SDK bootstrap catches its own
  errors, and a failed metric collection leaves the previous value rather than throwing.

**Bad, and accepted.**

- The OTel SDK must be imported before anything it instruments, which is why every
  runtime has a `telemetry.ts` that is the first import in `main.ts`. It looks like a
  style violation and is not.
- Auto-instrumentation adds startup time and some overhead per span.
- Filesystem and DNS instrumentation are disabled outright — they produce enormous
  volumes of spans that are never the answer to "why was this workflow slow".
- Running the full local stack means Jaeger and Prometheus containers as well.
