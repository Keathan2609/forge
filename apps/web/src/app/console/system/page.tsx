import type { ReactNode } from 'react';
import { forgeApi, CLIENT_BASE } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { AutoRefresh } from '@/components/auto-refresh';
import { ErrorBox, PageHeader, ui } from '@/components/ui';
import styles from './system.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'System' };

/** Label left, value right, hairline between. The page's only layout primitive. */
function Readout({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  tone?: 'ok' | 'warn' | 'down';
}): ReactNode {
  const toneClass = tone ? ' ' + styles[tone] : '';
  return (
    <div className={styles.readout}>
      <span className={styles.readoutLabel}>{label}</span>
      <span className={styles.readoutValue + toneClass}>
        {value}
        {note !== undefined && <span className={styles.readoutNote}>{note}</span>}
      </span>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <section className={styles.group}>
      <h2 className={styles.groupLabel}>{label}</h2>
      {children}
    </section>
  );
}

/** Zero-padded so a column of readings keeps a straight left edge as values change. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Component health and observability entry points.
 *
 * This page answers "is the platform itself healthy?" as distinct from "did my workflow
 * succeed?" — the outbox lag figure in particular, which is the one number that reveals
 * a control plane failing to dispatch while every other signal still looks fine.
 *
 * Grouped the way an operator triages: RUNTIME is "are the processes up", EXECUTION is
 * "is work moving", RELIABILITY is "what has already gone wrong". A number that is fine
 * in one group and alarming in another — queued tasks, say — belongs to whichever
 * question it answers first.
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

  const c = status.components;
  const healthy = status.status === 'healthy';

  const up = (ok: boolean): ReactNode => (
    <>
      <span className={styles.dot} />
      {ok ? 'Healthy' : 'Down'}
    </>
  );

  return (
    <>
      <AutoRefresh intervalMs={5_000} />

      <PageHeader
        title="System"
        count={
          <span
            className={
              styles.headerState + ' ' + (healthy ? styles.headerHealthy : styles.headerDegraded)
            }
          >
            <span className={styles.dot} />
            {status.status}
          </span>
        }
        subtitle={
          'Platform health, checked ' +
          new Date(status.checkedAt).toISOString().slice(11, 19) +
          'Z and refreshed every five seconds.'
        }
      />

      <div className={styles.readouts}>
        <Group label="Runtime">
          <Readout label="API" value={up(true)} tone="ok" />
          <Readout
            label="PostgreSQL"
            value={c.database.latencyMs === null ? up(c.database.ok) : c.database.latencyMs + 'ms'}
            tone={c.database.ok ? 'ok' : 'down'}
          />
          <Readout
            label="Redis"
            value={c.redis.latencyMs === null ? up(c.redis.ok) : c.redis.latencyMs + 'ms'}
            tone={c.redis.ok ? 'ok' : 'down'}
          />
          <Readout
            label="Workers"
            value={pad(c.workers.online) + ' online'}
            note={
              c.workers.unresponsive > 0
                ? c.workers.unresponsive + ' unresponsive'
                : stats.workers.totalCapacity + ' slots'
            }
            tone={c.workers.ok ? 'ok' : 'warn'}
          />
          <Readout label="Version" value={status.version} />
        </Group>

        <Group label="Execution">
          <Readout label="Active runs" value={pad(stats.runs.active)} />
          <Readout label="Running tasks" value={pad(stats.runs.runningTasks)} />
          <Readout
            label="Queued tasks"
            value={pad(stats.runs.queuedTasks)}
            note={stats.runs.queuedTasks > 0 ? 'awaiting a worker' : undefined}
          />
          <Readout
            label="Success rate"
            value={
              stats.runs.successRate === null
                ? '—'
                : (stats.runs.successRate * 100).toFixed(1) + '%'
            }
            note="last 24 hours"
          />
          <Readout
            label="Completed"
            value={pad(stats.runs.last24h.succeeded) + ' / ' + pad(stats.runs.last24h.total)}
            note="last 24 hours"
          />
        </Group>

        <Group label="Reliability">
          <Readout
            label="Dead letters"
            value={pad(stats.deadLetters.open)}
            note={stats.deadLetters.open > 0 ? 'awaiting a decision' : undefined}
            tone={stats.deadLetters.open > 0 ? 'down' : 'ok'}
          />
          <Readout
            label="Outbox pending"
            value={pad(c.outbox.pending)}
            note={
              c.outbox.oldestPendingAgeMs === null
                ? undefined
                : 'oldest ' + formatDuration(c.outbox.oldestPendingAgeMs)
            }
            tone={c.outbox.ok ? 'ok' : 'down'}
          />
          <Readout
            label="Outbox failed"
            value={pad(stats.outbox.failed)}
            note={stats.outbox.failed > 0 ? 'parked after max attempts' : undefined}
            tone={stats.outbox.failed > 0 ? 'down' : 'ok'}
          />
          <Readout
            label="Failed runs"
            value={pad(stats.runs.last24h.failed)}
            note="last 24 hours"
            tone={stats.runs.last24h.failed > 0 ? 'warn' : 'ok'}
          />
          <Readout
            label="Cancelled"
            value={pad(stats.runs.last24h.cancelled)}
            note="last 24 hours"
          />
        </Group>
      </div>

      <section className={ui.section}>
        <h2 className={styles.groupLabel} style={{ marginBottom: 'var(--space-4)' }}>
          Observability
        </h2>
        <p className={ui.hint} style={{ marginBottom: 'var(--space-4)', maxWidth: '76ch' }}>
          Every service exports OpenTelemetry traces and Prometheus metrics. A single trace spans
          the API request, the outbox publish, the queue hop and the worker&apos;s execution.
        </p>
        <div className={styles.links}>
          <a href="http://localhost:16686" target="_blank" rel="noreferrer" className={ui.button}>
            Jaeger ↗
          </a>
          <a href="http://localhost:9090" target="_blank" rel="noreferrer" className={ui.button}>
            Prometheus ↗
          </a>
          <a href={CLIENT_BASE + '/metrics'} target="_blank" rel="noreferrer" className={ui.button}>
            API /metrics ↗
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
      </section>

      <section className={ui.section}>
        <h2 className={styles.groupLabel} style={{ marginBottom: 'var(--space-4)' }}>
          Exported metrics
        </h2>
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
      </section>
    </>
  );
}
