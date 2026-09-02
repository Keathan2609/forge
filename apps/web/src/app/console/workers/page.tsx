import Link from 'next/link';
import type { ReactNode } from 'react';
import { forgeApi } from '@/lib/api';
import { formatDuration, shortId } from '@/lib/format';
import { AutoRefresh } from '@/components/auto-refresh';
import { TimeAgo } from '@/components/time-ago';
import { Empty, ErrorBox, PageHeader, Stat, StatGrid, StateBadge, ui } from '@/components/ui';
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

      <PageHeader
        title="Workers"
        count={
          online.length +
          (online.length === 1 ? ' worker online' : ' workers online') +
          ' · ' +
          active +
          ' of ' +
          capacity +
          ' slots busy'
        }
        subtitle="Every registered worker, its current allocation and its lifetime counters."
      />

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
        <Empty
          title="No workers registered"
          hint="Start the fleet with `pnpm forge:dev`, or `docker compose up -d worker`."
        />
      ) : (
        <div className={styles.ledger}>
          <div className={styles.head} aria-hidden="true">
            <span>Worker</span>
            <span>State</span>
            <span>Load</span>
            <span>Queues</span>
            <span className={styles.headRight}>Completed</span>
            <span className={styles.headRight}>Uptime</span>
            <span className={styles.headRight}>Heartbeat</span>
          </div>

          {live.map((worker) => (
            <div key={worker.id} className={styles.worker}>
              <div className={styles.row}>
                <span className={styles.name}>
                  <span className={styles.nameLabel}>{worker.name}</span>
                  <span className={styles.nameId} title={worker.id}>
                    {shortId(worker.id, 12)} · {worker.hostname}:{worker.pid}
                  </span>
                </span>

                <StateBadge state={worker.state} />

                <span className={styles.load}>
                  <span
                    className={styles.loadBar}
                    role="meter"
                    aria-valuenow={worker.activeTasks}
                    aria-valuemin={0}
                    aria-valuemax={worker.concurrency}
                    aria-label={worker.name + ' slot usage'}
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
                  </span>
                  <span className={styles.loadLabel}>
                    {worker.activeTasks} / {worker.concurrency} slots · {worker.capabilities.length}{' '}
                    handlers
                  </span>
                </span>

                <span className={styles.mono} title={worker.queues.join(', ')}>
                  {worker.queues.join(' · ')}
                </span>

                <span className={styles.numeric}>
                  {worker.tasksCompleted}
                  {worker.tasksFailed > 0 && (
                    <span className={styles.failed}> · {worker.tasksFailed}</span>
                  )}
                </span>

                <span className={styles.numeric}>
                  {formatDuration(worker.uptimeSeconds * 1000)}
                </span>

                <span
                  className={
                    styles.numeric + (worker.state === 'UNRESPONSIVE' ? ' ' + styles.stale : '')
                  }
                >
                  <TimeAgo iso={worker.lastHeartbeatAt} />
                </span>
              </div>

              {worker.currentTasks.length > 0 && (
                <div className={styles.tasks}>
                  {worker.currentTasks.map((task) => (
                    <Link
                      key={task.taskRunId}
                      href={'/console/runs/' + task.workflowRunId}
                      className={styles.task}
                    >
                      <span className={styles.taskMark} aria-hidden="true">
                        ▸
                      </span>
                      <span className={styles.taskNode}>{task.nodeKey}</span>
                      <span className={styles.taskMeta}>
                        started <TimeAgo iso={task.startedAt} />
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
