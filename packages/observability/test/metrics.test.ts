import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/metrics';

/**
 * Metric definitions.
 *
 * Two properties are worth pinning. First, that fleet-wide gauges are read from their
 * source at scrape time rather than accumulated in-process — with several replicas each
 * would otherwise report a fraction of the truth. Second, that label sets stay bounded:
 * a metric labelled by run id produces one time series per run and takes the endpoint
 * down within an hour.
 */

function metrics() {
  // Default process metrics are off so assertions see only what this package declares.
  return createMetrics({ service: 'api', defaultMetrics: false });
}

describe('metric registry', () => {
  it('declares every metric the documentation promises', async () => {
    const m = metrics();
    // Counters only appear in the output once observed, so touch each one.
    m.workflowsStarted.inc({ workflow: 'w' });
    m.workflowsCompleted.inc({ workflow: 'w' });
    m.workflowsFailed.inc({ workflow: 'w', reason: 'FAILED' });
    m.tasksStarted.inc({ workflow: 'w', node: 'n', type: 't' });
    m.tasksFailed.inc({ workflow: 'w', node: 'n', type: 't', code: 'X' });
    m.taskRetries.inc({ workflow: 'w', node: 'n' });
    m.taskDuration.observe({ workflow: 'w', node: 'n', type: 't', outcome: 'ok' }, 0.1);
    m.deadLetters.inc({ workflow: 'w', node: 'n' });
    m.leaseRecoveries.inc({ workflow: 'w', node: 'n' });

    const output = await m.registry.metrics();

    for (const name of [
      'forge_workflows_started_total',
      'forge_workflows_completed_total',
      'forge_workflows_failed_total',
      'forge_tasks_started_total',
      'forge_tasks_failed_total',
      'forge_task_retry_total',
      'forge_task_duration_seconds',
      'forge_dead_letters_total',
      'forge_worker_lease_recoveries_total',
      'forge_queue_depth',
      'forge_active_workers',
      'forge_outbox_lag_seconds',
    ]) {
      expect(output, name + ' is documented but not exported').toContain(name);
    }
  });

  it('tags every series with the service that produced it', async () => {
    const m = createMetrics({ service: 'worker', defaultMetrics: false });
    m.tasksStarted.inc({ workflow: 'w', node: 'n', type: 't' });

    expect(await m.registry.metrics()).toContain('service="worker"');
  });

  it('gives task duration buckets that span real workloads', async () => {
    const m = metrics();
    // A 5-minute task must not land in +Inf: prom-client's defaults top out at 10s,
    // which would make every batch task indistinguishable.
    m.taskDuration.observe({ workflow: 'w', node: 'n', type: 't', outcome: 'ok' }, 300);

    const output = await m.registry.metrics();
    expect(output).toContain('le="300"');
    expect(output).toContain('le="900"');
  });

  it('labels HTTP metrics by route template, never by concrete path', async () => {
    const m = metrics();
    m.httpRequests.inc({ method: 'GET', route: '/v1/runs/:id', status: '200' });

    const output = await m.registry.metrics();
    expect(output).toContain('route="/v1/runs/:id"');
    // A concrete id in a label is unbounded cardinality.
    expect(output).not.toMatch(/route="\/v1\/runs\/[0-9a-f-]{36}"/);
  });
});

describe('scrape-time gauges', () => {
  it('reads queue depth from its source when scraped', async () => {
    const m = metrics();
    let calls = 0;
    m.setCollectors({
      queueDepth: async () => {
        calls += 1;
        return { default: 7, media: 3 };
      },
    });

    const output = await m.registry.metrics();

    expect(calls).toBe(1);
    expect(output).toContain('forge_queue_depth{queue="default"');
    expect(output).toMatch(/forge_queue_depth\{queue="default",service="api"\} 7/);
    expect(output).toMatch(/forge_queue_depth\{queue="media",service="api"\} 3/);
  });

  it('reflects a changed value on the next scrape rather than accumulating', async () => {
    const m = metrics();
    let depth = 10;
    m.setCollectors({ queueDepth: async () => ({ default: depth }) });

    await m.registry.metrics();
    depth = 2;
    const second = await m.registry.metrics();

    // A gauge read from the database must report the current value, not a running total.
    expect(second).toMatch(/forge_queue_depth\{queue="default",service="api"\} 2/);
  });

  it('drops labels that no longer exist', async () => {
    const m = metrics();
    let depths: Record<string, number> = { default: 1, media: 1 };
    m.setCollectors({ queueDepth: async () => depths });

    await m.registry.metrics();
    depths = { default: 1 };
    const second = await m.registry.metrics();

    // Otherwise a decommissioned queue reports its last value forever.
    expect(second).not.toContain('queue="media"');
  });

  it('converts outbox lag from milliseconds to seconds', async () => {
    const m = metrics();
    m.setCollectors({ outbox: async () => ({ pending: 4, oldestPendingAgeMs: 2_500 }) });

    const output = await m.registry.metrics();
    expect(output).toMatch(/forge_outbox_lag_seconds\{service="api"\} 2\.5/);
    expect(output).toMatch(/forge_outbox_pending\{service="api"\} 4/);
  });

  it('reports zero lag when nothing is pending', async () => {
    const m = metrics();
    m.setCollectors({ outbox: async () => ({ pending: 0, oldestPendingAgeMs: null }) });

    expect(await m.registry.metrics()).toMatch(/forge_outbox_lag_seconds\{service="api"\} 0/);
  });

  it('survives a collector that throws', async () => {
    const m = metrics();
    m.setCollectors({
      queueDepth: async () => {
        throw new Error('database unreachable');
      },
    });

    // A metrics scrape must never take down the process it is observing.
    await expect(m.registry.metrics()).resolves.toBeTypeOf('string');
  });

  it('omits a gauge with no configured source', async () => {
    const m = metrics();
    const output = await m.registry.metrics();

    // Declared but never populated: the HELP line is present, no samples are.
    expect(output).toContain('forge_queue_depth');
    expect(output).not.toMatch(/forge_queue_depth\{queue=/);
  });
});
