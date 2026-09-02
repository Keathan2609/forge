# Portfolio capture plan — FORGE

Ten images, in the order they should appear. The first one carries the project; the rest
exist to answer the questions a reader forms after seeing it.

Everything below is capturable from a running stack. Bring one up first:

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

```bash
pnpm demo:seed
```

Wait for `docker compose ps` to show every service healthy before capturing anything. The
console is at `http://localhost:3000`, the API at `http://localhost:4000`.

## Before you start

Applies to every shot, so it is stated once here rather than repeated ten times.

- **Browser chrome off.** No bookmarks bar, no extensions, no other tabs. The URL bar may
  stay — `localhost:3000/console/runs/…` reads as a real running system, which helps.
- **Dark theme.** The console is designed dark; the screenshots in a portfolio grid should
  match each other.
- **Device pixel ratio 2** where the tool allows it. A 1× screenshot of a dense UI looks
  soft next to everything else on a portfolio page.
- **No personal data on screen.** Nothing here generates any, but check the OS
  notification area and any terminal prompt showing a home directory path.
- **Do not stage anything in the browser devtools.** Every number in these shots comes out
  of PostgreSQL. That is the entire point of the project, and a fabricated screenshot
  would be the one thing that discredits it.

---

## HERO — live workflow execution

**Route** `/console/runs/:id`

**How to get the state**

```bash
curl -s -X POST http://localhost:4000/v1/workflows/order-fulfilment/runs \
  -H 'content-type: application/json' \
  -d '{"input":{"orderId":"ord_hero","amount":4999,"items":[{"sku":"KB-87","qty":1}]}}'
```

Open the returned `runId` immediately and capture **while it is still running** — the
window between the two parallel tasks starting and the fan-in node beginning is roughly
one second, so trigger it with the tab already open and be ready. `reserve-inventory`
takes ~860ms, which is the shot: one node `RUNNING`, one `SUCCEEDED`, one still `QUEUED`,
downstream nodes `PENDING`.

**Must be visible** several distinct node states in the DAG at once, each node's worker ID
badge, the timeline mid-stream on the right, the live `RUNNING` run header.

**Demonstrates** real-time distributed execution, dependency-ordered scheduling, and that
different tasks are genuinely running on different worker processes.

**Viewport** 1600×1000, landscape. Wide enough that the graph and timeline sit side by
side without either collapsing.

**Hide first** nothing — the whole layout is the point. If the left nav badge shows a large
dead-letter count from earlier experiments, clear them first (see IMAGE 06 note).

---

## IMAGE 02 — workflow editor

**Route** `/console/workflows/order-fulfilment` → edit

**State** mid-edit, with the validation panel showing a result from the engine. The most
useful version shows a _rejected_ edit — drag an edge that closes a cycle, so the error
message from the real engine is on screen.

**Demonstrates** that the editor validates against the actual orchestration engine over
the API rather than reimplementing rules in the browser; graph authoring; schema
validation as a first-class part of the product.

**Viewport** 1600×1000, landscape.

**Hide first** the node inspector if it is showing an unrelated node — select the node the
error refers to so the shot reads as one coherent action.

---

## IMAGE 03 — execution detail with timeline and inspector

**Route** `/console/runs/:id` for a **completed** `order-fulfilment` run, with a node
selected.

**State** a `SUCCEEDED` run, one node clicked so the task detail panel shows its input,
output, worker, duration and attempt history, and the timeline filtered to that node.

**Demonstrates** depth of persisted execution data — this is the shot that says the system
records what happened rather than just whether it worked.

**Viewport** 1600×1000, landscape.

**Hide first** nothing. If the output JSON is short, pick `prepare-shipment`, which has
both an input mapping and a computed output.

---

## IMAGE 04 — worker fleet

**Route** `/console/workers`

**State** three workers `ONLINE`, ideally with tasks in flight so slot allocation is
non-zero. Trigger a few runs first:

```bash
for i in 1 2 3 4 5 6; do curl -s -X POST http://localhost:4000/v1/workflows/media-pipeline/runs -H 'content-type: application/json' -d '{"input":{}}' >/dev/null & done; wait
```

**Must be visible** three distinct worker IDs, their queues and capabilities, concurrency
slots in use.

**Demonstrates** that this is a real distributed fleet with independent processes, not a
single process pretending.

**Viewport** 1440×900, landscape.

**Hide first** stale `OFFLINE` worker rows from previous sessions. The liveness loop prunes
them within a minute or so — wait rather than capturing a fleet list padded with corpses.

---

## IMAGE 05 — controlled failure and retry

**Route** `/console/runs/:id` for a `resilience-demo` run

```bash
curl -s -X POST http://localhost:4000/v1/workflows/resilience-demo/runs \
  -H 'content-type: application/json' -d '{"input":{"scenario":"retry"}}'
```

**State** capture roughly 4–6 seconds in, while `flaky-step` is in `RETRYING` and the
timeline already shows two failed attempts. The demo sets `jitter: false` deliberately so
the 1s → 2s backoff is legible rather than smeared.

**Must be visible** the retrying node, the failure messages, and — if you select
`flaky-step` — the attempt history with attempts #1 and #2 failed.

**Demonstrates** retry policy, exponential backoff, and that failures are persisted per
attempt rather than overwriting the task row.

**Viewport** 1600×1000, landscape.

**Hide first** nothing.

---

## IMAGE 06 — dead-letter queue

**Route** `/console/dead-letters`

**State** one entry expanded, showing handler, run and task IDs, the original input, and
the full attempt history with per-attempt durations and worker IDs. The `always-fails`
node of `resilience-demo` produces this on every run.

**Demonstrates** exhausted retry budgets are a first-class operational state with a
resolution workflow, not a silent drop.

**Viewport** 1440×1000, landscape.

**Hide first** the accumulated backlog. Repeated demo runs pile up identical
`always-fails` entries and a wall of eleven identical rows reads as noise rather than
design. Either acknowledge the old ones through the UI first, or capture after a fresh
`docker compose down -v` + seed so exactly one or two entries exist.

---

## IMAGE 07 — Prometheus metrics

**Route** `http://localhost:9090`

**State** a graph of a metric that is unmistakably FORGE's own rather than generic Node
process telemetry. Best options, in order:

- `forge_worker_lease_recoveries_total` — the crash-recovery counter, most distinctive
- `forge_task_retry_total`
- `forge_queue_depth` — only captures well under load, since it reads PostgreSQL at scrape
  time and reports nothing when idle; generate backlog first with the loop from IMAGE 04
- `forge_outbox_lag_seconds` — the control-plane health signal

Alternatively capture `/targets` showing all six targets `UP`, including three separately
discovered worker replicas — that image says "this is a real fleet being scraped".

**Demonstrates** domain-specific instrumentation, and fleet-wide gauges computed at scrape
time from the database rather than accumulated per process.

**Viewport** 1600×900, landscape.

**Hide first** the Prometheus expression browser's autocomplete dropdown.

---

## IMAGE 08 — distributed trace

**Route** `http://localhost:16686` → find the trace, expand it fully

**How to get a good one** trigger a fresh run and take the task's persisted trace ID
straight from the database, which guarantees you open the right trace rather than hunting:

```bash
docker exec forge-postgres psql -U forge -d forge -At -c "SELECT \"traceId\" FROM task_run WHERE \"traceId\" IS NOT NULL ORDER BY \"createdAt\" DESC LIMIT 1;"
```

Paste that into Jaeger's trace-ID lookup. Prefer a trace whose root is the API `POST`.

**Must be visible** three service colours in one trace — `forge-api`, `forge-scheduler`,
`forge-worker` — with `task.execute` nested under `run.advance`, nested under the API span.

**Demonstrates** W3C trace context surviving a database outbox and a Redis queue, which is
the part most systems drop.

**Viewport** 1600×900, landscape. Expand every span row before capturing.

**Hide first** Jaeger's search sidebar if it can be collapsed; the waterfall should fill
the frame.

---

## IMAGE 09 — CLI

**Command** in a clean terminal, no prompt clutter, dark theme, ~110 columns:

```bash
pnpm demo:chaos
```

This is the strongest terminal output in the project — seven asserted steps ending in a
run that survived losing its worker. If a shorter shot is needed:

```bash
forge runs list --limit 10
```

**Must be visible** the full chaos transcript, especially steps 4–7: lease expiry, task
recovery, takeover by a different worker ID, and the attempt history showing
`#1 ABANDONED, #2 SUCCEEDED`.

**Demonstrates** the CLI, and the recovery guarantee, in one frame.

**Viewport** portrait or tall landscape — the transcript is ~40 lines. Do not shrink the
font to fit; crop to the interesting half if necessary.

**Hide first** the shell prompt if it exposes a full home-directory path, and the
`DeprecationWarning` lines Node prints above the output — start the capture below them.

---

## IMAGE 10 — architecture diagram

**Source** the diagram in `README.md` / `docs/portfolio-entry.md`, rendered rather than
screenshotted as raw text.

**Must be visible** the one-way relationship that defines the system: everything writes to
PostgreSQL; Redis only carries messages outward to workers.

**Demonstrates** the system-design thinking behind the whole project, and gives a reader
who skipped the prose the shape of it in one image.

**Viewport** 1600×1200 or a vector export. Prefer SVG if the portfolio supports it.

**Hide first** n/a.

---

## Ordering note

If only three images can be used, take the **HERO**, **IMAGE 08 (trace)** and **IMAGE 09
(chaos transcript)**. Those three cover, in order: it works, it is genuinely distributed,
and it survives failure — which is the argument the whole project exists to make.
