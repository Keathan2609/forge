import type { ReactNode } from 'react';
import { forgeApi, CLIENT_BASE } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { AutoRefresh } from '@/components/auto-refresh';
import { Card, ErrorBox, KeyValue, PageHeader, Stat, StatGrid, ui } from '@/components/ui';
import styles from './system.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'System' };

/**
 * Component health and observability entry points.
 *
 * This page answers "is the platform itself healthy?" as distinct from "did my workflow
 * succeed?" — the outbox lag figure in particular, which is the one number that reveals
 * a control plane failing to dispatch while every other signal still looks fine.
 */
export default async function SystemPage(): Promise<ReactNode> {
  let status;
  let stats;
  try {
    [status, stats] = await Promise.all([forgeApi.status(), forgeApi.stats()]);
  } catch (err) {
    return (
      <>
        <PageHeader title="System" />
        <ErrorBox>Could not reach the API: {(err as Error).message}</ErrorBox>
      </>
    );
  }

  const components = status.components;

  const health = (ok: boolean): ReactNode => (
    <span className={ok ? styles.ok : styles.down}>
      <span className={styles.dot} />
      {ok ? 'healthy' : 'unavailable'}
    </span>
  );

  return (
    <>
      <AutoRefresh intervalMs={5_000} />

      <PageHeader
        title="System"
        subtitle={'Checked ' + new Date(status.checkedAt).toISOString().slice(11, 19) + 'Z'}
        actions={
          <span
            className={status.status === 'healthy' ? styles.badgeHealthy : styles.badgeDegraded}
          >
            {status.status}
          </span>
        }
      />

      <div className={ui.section}>
        <StatGrid>
          <Stat
            label="Outbox pending"
            value={components.outbox.pending}
            meta={
              components.outbox.oldestPendingAgeMs === null
                ? 'nothing waiting'
                : 'oldest ' + formatDuration(components.outbox.oldestPendingAgeMs)
            }
            tone={components.outbox.ok ? undefined : 'error'}
          />
          <Stat
            label="Outbox failed"
            value={stats.outbox.failed}
            meta="parked after max attempts"
            tone={stats.outbox.failed > 0 ? 'error' : undefined}
          />
          <Stat label="Queued tasks" value={stats.runs.queuedTasks} meta="awaiting a worker" />
          <Stat
            label="Running tasks"
            value={stats.runs.runningTasks}
            meta={stats.workers.totalCapacity + ' slots available'}
          />
        </StatGrid>
      </div>

      <div className={ui.grid2 + ' ' + ui.section}>
        <Card title="Components">
          <KeyValue
            entries={[
              [
                'PostgreSQL',
                <span key="db">
                  {health(components.database.ok)}
                  {components.database.latencyMs !== null && (
                    <span className={ui.muted}> · {components.database.latencyMs}ms</span>
                  )}
                </span>,
              ],
              [
                'Redis',
                <span key="redis">
                  {health(components.redis.ok)}
                  {components.redis.latencyMs !== null && (
                    <span className={ui.muted}> · {components.redis.latencyMs}ms</span>
                  )}
                </span>,
              ],
              [
                'Workers',
                <span key="w">
                  {health(components.workers.ok)}
                  <span className={ui.muted}>
                    {' '}
                    · {components.workers.online} online
                    {components.workers.unresponsive > 0
                      ? ', ' + components.workers.unresponsive + ' unresponsive'
                      : ''}
                  </span>
                </span>,
              ],
              [
                'Outbox',
                <span key="o">
                  {health(components.outbox.ok)}
                  <span className={ui.muted}> · {components.outbox.pending} pending</span>
                </span>,
              ],
              [
                'Version',
                <span key="v" className={ui.mono}>
                  {status.version}
                </span>,
              ],
            ]}
          />
        </Card>

        <Card title="Observability">
          <p className={ui.hint} style={{ marginBottom: 'var(--space-4)' }}>
            Every service exports OpenTelemetry traces and Prometheus metrics. A single trace spans
            the API request, the outbox publish, the queue hop and the worker&apos;s execution.
          </p>
          <div className={styles.links}>
            <a href="http://localhost:16686" target="_blank" rel="noreferrer" className={ui.button}>
              Jaeger — distributed traces ↗
            </a>
            <a href="http://localhost:9090" target="_blank" rel="noreferrer" className={ui.button}>
              Prometheus — metrics ↗
            </a>
            <a
              href={CLIENT_BASE + '/metrics'}
              target="_blank"
              rel="noreferrer"
              className={ui.button}
            >
              API /metrics (raw) ↗
            </a>
            <a
              href={CLIENT_BASE + '/health/ready'}
              target="_blank"
              rel="noreferrer"
              className={ui.button}
            >
              API readiness ↗
            </a>
          </div>
        </Card>
      </div>

      <Card title="Key metrics">
        <div className={styles.metricList}>
          {[
            ['forge_workflows_started_total', 'Workflow runs started'],
            ['forge_workflows_completed_total', 'Runs that reached SUCCEEDED'],
            ['forge_workflows_failed_total', 'Runs that failed, timed out or were cancelled'],
            ['forge_tasks_started_total', 'Task attempts started'],
            ['forge_tasks_failed_total', 'Task attempts that failed, by error code'],
            ['forge_task_retry_total', 'Retries scheduled after a failed attempt'],
            ['forge_task_duration_seconds', 'Task execution time, measured by the worker'],
            ['forge_queue_depth', 'Tasks in QUEUED state, by logical queue'],
            ['forge_active_workers', 'Registered workers by state'],
            ['forge_dead_letters_total', 'Tasks parked after exhausting their retry budget'],
            [
              'forge_worker_lease_recoveries_total',
              'Attempts reclaimed by the control plane after a lease expired',
            ],
            [
              'forge_outbox_lag_seconds',
              'Age of the oldest unpublished outbox row — the primary control-plane health signal',
            ],
          ].map(([metric, description]) => (
            <div key={metric} className={styles.metric}>
              <code className={styles.metricName}>{metric}</code>
              <span className={styles.metricDescription}>{description}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
