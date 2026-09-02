import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type Registry as PromRegistry,
} from 'prom-client';

/**
 * Prometheus metrics.
 *
 * Every metric here is incremented from a real code path — none are synthesised for the
 * dashboard. Where a value is better read from the database than accumulated in memory
 * (queue depth, active workers, outbox lag), it is registered as a *collected* gauge
 * with an async source, so a process restart cannot leave a stale reading behind and
 * three replicas do not each report their own partial view.
 */

export interface MetricsOptions {
  service: 'api' | 'worker' | 'scheduler';
  /** Adds the standard Node process metrics (heap, event loop lag, GC). */
  defaultMetrics?: boolean;
  prefix?: string;
}

/**
 * Sources for gauges whose value is read at scrape time rather than accumulated.
 *
 * Fleet-wide values must not be counted per-process: with three API replicas each would
 * report a third of the truth, and a restart would zero the counter. Reading them from
 * the database when Prometheus scrapes keeps the number correct regardless of how many
 * replicas are running, and makes a stale value impossible.
 */
export interface MetricCollectors {
  queueDepth?: () => Promise<Record<string, number>>;
  workerCounts?: () => Promise<Record<string, number>>;
  workerActiveTasks?: () => Promise<number>;
  outbox?: () => Promise<{ pending: number; oldestPendingAgeMs: number | null }>;
}

export interface ForgeMetrics {
  registry: PromRegistry;
  /** Wire up scrape-time sources once the database client is available. */
  setCollectors: (collectors: MetricCollectors) => void;

  workflowsStarted: Counter<'workflow'>;
  workflowsCompleted: Counter<'workflow'>;
  workflowsFailed: Counter<'workflow' | 'reason'>;
  workflowDuration: Histogram<'workflow' | 'state'>;

  tasksStarted: Counter<'workflow' | 'node' | 'type'>;
  tasksCompleted: Counter<'workflow' | 'node' | 'type'>;
  tasksFailed: Counter<'workflow' | 'node' | 'type' | 'code'>;
  taskRetries: Counter<'workflow' | 'node'>;
  taskDuration: Histogram<'workflow' | 'node' | 'type' | 'outcome'>;

  deadLetters: Counter<'workflow' | 'node'>;
  leaseRecoveries: Counter<'workflow' | 'node'>;
  leaseRenewals: Counter<never>;

  outboxPublished: Counter<'type'>;
  outboxFailures: Counter<'type'>;
  outboxLagSeconds: Gauge<never>;
  outboxPending: Gauge<never>;

  queueDepth: Gauge<'queue'>;
  activeWorkers: Gauge<'state'>;
  workerActiveTasks: Gauge<never>;

  claimAttempts: Counter<'result'>;
  advanceDuration: Histogram<never>;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'method' | 'route'>;
  sseConnections: Gauge<never>;
}

/**
 * Buckets chosen for the workloads FORGE actually sees: sub-second orchestration steps
 * at the bottom, multi-minute batch tasks at the top. The default prom-client buckets
 * top out at 10s and would put every real task in `+Inf`.
 */
const TASK_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900];
const WORKFLOW_DURATION_BUCKETS = [0.1, 0.5, 1, 5, 15, 30, 60, 300, 900, 3600];
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export function createMetrics(options: MetricsOptions): ForgeMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: options.service });

  if (options.defaultMetrics !== false) {
    collectDefaultMetrics({ register: registry, prefix: 'forge_' });
  }

  const counter = <T extends string>(name: string, help: string, labelNames: T[]): Counter<T> =>
    new Counter({ name, help, labelNames, registers: [registry] });

  const gauge = <T extends string>(name: string, help: string, labelNames: T[]): Gauge<T> =>
    new Gauge({ name, help, labelNames, registers: [registry] });

  const histogram = <T extends string>(
    name: string,
    help: string,
    labelNames: T[],
    buckets: number[],
  ): Histogram<T> => new Histogram({ name, help, labelNames, buckets, registers: [registry] });

  // Mutable holder: the gauges below are constructed now (prom-client only accepts a
  // `collect` hook at construction) but their data sources arrive later, once the
  // process has a database client.
  const collectors: MetricCollectors = {};

  /** A collection failure must never fail a scrape, let alone the process. */
  const safely = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch {
      /* leave the previous value; Prometheus will see it go stale */
    }
  };

  const queueDepth = new Gauge<'queue'>({
    name: 'forge_queue_depth',
    help: 'Tasks in QUEUED state, by logical queue',
    labelNames: ['queue'],
    registers: [registry],
    async collect() {
      await safely(async () => {
        if (!collectors.queueDepth) return;
        const depths = await collectors.queueDepth();
        this.reset();
        for (const [queue, value] of Object.entries(depths)) this.set({ queue }, value);
      });
    },
  });

  const activeWorkers = new Gauge<'state'>({
    name: 'forge_active_workers',
    help: 'Registered workers by state',
    labelNames: ['state'],
    registers: [registry],
    async collect() {
      await safely(async () => {
        if (!collectors.workerCounts) return;
        const counts = await collectors.workerCounts();
        this.reset();
        for (const [state, value] of Object.entries(counts)) this.set({ state }, value);
      });
    },
  });

  const workerActiveTasks = new Gauge({
    name: 'forge_worker_active_tasks',
    help: 'Tasks currently executing across the fleet',
    registers: [registry],
    async collect() {
      await safely(async () => {
        if (!collectors.workerActiveTasks) return;
        this.set(await collectors.workerActiveTasks());
      });
    },
  });

  const outboxPending = new Gauge({
    name: 'forge_outbox_pending',
    help: 'Unpublished outbox rows',
    registers: [registry],
    async collect() {
      await safely(async () => {
        if (!collectors.outbox) return;
        this.set((await collectors.outbox()).pending);
      });
    },
  });

  const outboxLagSeconds = new Gauge({
    name: 'forge_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox row — the primary control-plane health signal',
    registers: [registry],
    async collect() {
      await safely(async () => {
        if (!collectors.outbox) return;
        const health = await collectors.outbox();
        this.set(health.oldestPendingAgeMs === null ? 0 : health.oldestPendingAgeMs / 1000);
      });
    },
  });

  return {
    registry,
    setCollectors: (next: MetricCollectors): void => {
      Object.assign(collectors, next);
    },

    workflowsStarted: counter('forge_workflows_started_total', 'Workflow runs started', [
      'workflow',
    ]),
    workflowsCompleted: counter(
      'forge_workflows_completed_total',
      'Workflow runs that reached SUCCEEDED',
      ['workflow'],
    ),
    workflowsFailed: counter(
      'forge_workflows_failed_total',
      'Workflow runs that reached FAILED, TIMED_OUT or CANCELLED',
      ['workflow', 'reason'],
    ),
    workflowDuration: histogram(
      'forge_workflow_duration_seconds',
      'End-to-end workflow run duration',
      ['workflow', 'state'],
      WORKFLOW_DURATION_BUCKETS,
    ),

    tasksStarted: counter('forge_tasks_started_total', 'Task attempts started', [
      'workflow',
      'node',
      'type',
    ]),
    tasksCompleted: counter('forge_tasks_completed_total', 'Task attempts that succeeded', [
      'workflow',
      'node',
      'type',
    ]),
    tasksFailed: counter('forge_tasks_failed_total', 'Task attempts that failed', [
      'workflow',
      'node',
      'type',
      'code',
    ]),
    taskRetries: counter('forge_task_retry_total', 'Retries scheduled after a failed attempt', [
      'workflow',
      'node',
    ]),
    taskDuration: histogram(
      'forge_task_duration_seconds',
      'Task attempt execution time, measured by the worker',
      ['workflow', 'node', 'type', 'outcome'],
      TASK_DURATION_BUCKETS,
    ),

    deadLetters: counter(
      'forge_dead_letters_total',
      'Tasks parked in the dead-letter queue after exhausting their retry budget',
      ['workflow', 'node'],
    ),
    leaseRecoveries: counter(
      'forge_worker_lease_recoveries_total',
      'Task attempts reclaimed by the control plane after a lease expired',
      ['workflow', 'node'],
    ),
    leaseRenewals: counter('forge_worker_lease_renewals_total', 'Lease renewals performed', []),

    outboxPublished: counter(
      'forge_outbox_published_total',
      'Outbox rows successfully handed to the transport',
      ['type'],
    ),
    outboxFailures: counter('forge_outbox_failures_total', 'Outbox publish failures', ['type']),
    outboxLagSeconds,
    outboxPending,
    queueDepth,
    activeWorkers,
    workerActiveTasks,

    claimAttempts: counter(
      'forge_task_claim_total',
      'Claim attempts by outcome — `lost-race` and `not-claimable` are normal under at-least-once delivery',
      ['result'],
    ),
    advanceDuration: histogram(
      'forge_run_advance_duration_seconds',
      'Time to compute and apply one advance plan',
      [],
      [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    ),
    httpRequests: counter('forge_http_requests_total', 'HTTP requests handled by the API', [
      'method',
      'route',
      'status',
    ]),
    httpDuration: histogram(
      'forge_http_request_duration_seconds',
      'API request duration',
      ['method', 'route'],
      HTTP_BUCKETS,
    ),
    sseConnections: gauge('forge_sse_connections', 'Open server-sent-event connections', []),
  };
}

export async function renderMetrics(
  metrics: ForgeMetrics,
): Promise<{ body: string; contentType: string }> {
  return {
    body: await metrics.registry.metrics(),
    contentType: metrics.registry.contentType,
  };
}
