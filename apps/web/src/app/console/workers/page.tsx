import Link from 'next/link';
import type { ReactNode } from 'react';
import { forgeApi } from '@/lib/api';
import { formatDuration, shortId } from '@/lib/format';
import { AutoRefresh } from '@/components/auto-refresh';
import { TimeAgo } from '@/components/time-ago';
import { Card, Empty, ErrorBox, PageHeader, Stat, StatGrid, StateBadge, ui } from '@/components/ui';
import styles from './workers.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Workers' };

/**
 * Worker fleet.
 *
 * The load bars are the point of this page: they make it immediately visible whether
 * work is spread across the fleet or piled onto one worker, which is the question you
 * actually have when a run is slower than expected.
 */
export default async function WorkersPage(): Promise<ReactNode> {
  let workers;
  try {
    workers = (await forgeApi.workers()).items;
  } catch (err) {
    return (
      <>
        <PageHeader title="Workers" />
        <ErrorBox>Could not load the fleet: {(err as Error).message}</ErrorBox>
      </>
    );
  }

  const live = workers.filter((w) => w.state !== 'OFFLINE');
  const online = live.filter((w) => w.state === 'ONLINE');
  const capacity = online.reduce((sum, w) => sum + w.concurrency, 0);
  const active = live.reduce((sum, w) => sum + w.activeTasks, 0);
  const completed = workers.reduce((sum, w) => sum + w.tasksCompleted, 0);
  const failed = workers.reduce((sum, w) => sum + w.tasksFailed, 0);

  return (
    <>
      <AutoRefresh intervalMs={3_000} />

      <PageHeader title="Workers" subtitle="Registered workers and their current allocation" />

      <div className={ui.section}>
        <StatGrid>
          <Stat
            label="Online"
            value={online.length}
            meta={live.length - online.length + ' unresponsive'}
            tone={online.length === 0 ? 'error' : 'success'}
          />
          <Stat label="Capacity" value={capacity} meta="concurrent task slots" />
          <Stat
            label="Executing"
            value={active}
            meta={capacity > 0 ? Math.round((active / capacity) * 100) + '% utilised' : '—'}
            tone={active > 0 ? 'accent' : undefined}
          />
          <Stat label="Tasks completed" value={completed} meta={failed + ' failed'} />
        </StatGrid>
      </div>

      {live.length === 0 ? (
        <Card>
          <Empty
            title="No workers registered"
            hint="Start the fleet with `pnpm forge:dev`, or `docker compose up -d worker`."
          />
        </Card>
      ) : (
        <div className={styles.grid}>
          {live.map((worker) => {
            const utilisation =
              worker.concurrency > 0 ? worker.activeTasks / worker.concurrency : 0;
            return (
              <Card key={worker.id} title={worker.name}>
                <div className={styles.workerHeader}>
                  <StateBadge state={worker.state} />
                  <span className={ui.mono} title={worker.id}>
                    {shortId(worker.id, 12)}
                  </span>
                </div>

                <div className={styles.loadRow}>
                  <span className={styles.loadLabel}>
                    {worker.activeTasks} / {worker.concurrency} slots
                  </span>
                  <div
                    className={styles.loadBar}
                    role="meter"
                    aria-valuenow={worker.activeTasks}
                    aria-valuemin={0}
                    aria-valuemax={worker.concurrency}
                  >
                    {Array.from({ length: worker.concurrency }).map((_, index) => (
                      <span
                        key={index}
                        className={
                          styles.loadSlot +
                          (index < worker.activeTasks ? ' ' + styles.loadSlotActive : '')
                        }
                      />
                    ))}
                  </div>
                  <span className={styles.loadPercent}>{Math.round(utilisation * 100)}%</span>
                </div>

                <dl className={ui.kv} style={{ marginTop: 'var(--space-3)' }}>
                  <dt className={ui.kvKey}>Host</dt>
                  <dd className={ui.kvValue}>
                    <span className={ui.mono}>
                      {worker.hostname}:{worker.pid}
                    </span>
                  </dd>
                  <dt className={ui.kvKey}>Queues</dt>
                  <dd className={ui.kvValue}>
                    <span className={ui.mono}>{worker.queues.join(', ')}</span>
                  </dd>
                  <dt className={ui.kvKey}>Handlers</dt>
                  <dd className={ui.kvValue}>
                    <span className={ui.mono} title={worker.capabilities.join(', ')}>
                      {worker.capabilities.length} registered
                    </span>
                  </dd>
                  <dt className={ui.kvKey}>Completed</dt>
                  <dd className={ui.kvValue}>
                    {worker.tasksCompleted}
                    {worker.tasksFailed > 0 && (
                      <span style={{ color: 'var(--state-error)' }}>
                        {' '}
                        · {worker.tasksFailed} failed
                      </span>
                    )}
                  </dd>
                  <dt className={ui.kvKey}>Uptime</dt>
                  <dd className={ui.kvValue}>{formatDuration(worker.uptimeSeconds * 1000)}</dd>
                  <dt className={ui.kvKey}>Heartbeat</dt>
                  <dd className={ui.kvValue}>
                    <TimeAgo iso={worker.lastHeartbeatAt} />
                  </dd>
                </dl>

                {worker.currentTasks.length > 0 && (
                  <div className={styles.currentTasks}>
                    <div className={styles.currentLabel}>Executing now</div>
                    {worker.currentTasks.map((task) => (
                      <Link
                        key={task.taskRunId}
                        href={'/console/runs/' + task.workflowRunId}
                        className={styles.currentTask}
                      >
                        <span className={styles.currentNode}>{task.nodeKey}</span>
                        <span className={ui.muted}>
                          <TimeAgo iso={task.startedAt} />
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
