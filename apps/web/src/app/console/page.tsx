import Link from 'next/link';
import type { ReactNode } from 'react';
import { forgeApi } from '@/lib/api';
import { formatCount, formatDuration, formatPercent, shortId } from '@/lib/format';
import { Card, Empty, ErrorBox, PageHeader, Stat, StatGrid, StateBadge, ui } from '@/components/ui';
import { ThroughputChart } from '@/components/throughput-chart';
import { AutoRefresh } from '@/components/auto-refresh';
import { TimeAgo } from '@/components/time-ago';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview' };

/**
 * Console overview.
 *
 * Backed by one aggregate endpoint rather than six parallel requests, so the whole page
 * reflects a single consistent moment. A dashboard whose panels disagree — 4 running
 * runs, 0 running tasks — is worse than one that is a second stale.
 */
export default async function OverviewPage(): Promise<ReactNode> {
  let stats;
  try {
    stats = await forgeApi.stats();
  } catch (err) {
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorBox>
          Could not reach the FORGE API: {(err as Error).message}. Is it running? Try{' '}
          <code>pnpm forge:dev</code>.
        </ErrorBox>
      </>
    );
  }

  const { runs, workers, deadLetters, outbox, throughput, recentRuns } = stats;
  const idleCapacity = Math.max(0, workers.totalCapacity - workers.activeTasks);

  return (
    <>
      {/* The overview is a monitoring surface; refreshing it is the whole point. */}
      <AutoRefresh intervalMs={5_000} />

      <PageHeader
        title="Overview"
        subtitle="Live execution state across the cluster"
        actions={
          <Link href="/console/runs" className={ui.button}>
            All runs
          </Link>
        }
      />

      <div className={ui.section}>
        <StatGrid>
          <Stat
            label="Active runs"
            value={runs.active}
            meta={runs.active === 0 ? 'idle' : 'in flight'}
            tone={runs.active > 0 ? 'accent' : undefined}
          />
          <Stat
            label="Running tasks"
            value={runs.runningTasks}
            meta={runs.queuedTasks + ' queued'}
          />
          <Stat
            label="Workers"
            value={workers.online}
            meta={
              workers.unresponsive > 0
                ? workers.unresponsive + ' unresponsive'
                : idleCapacity + ' slots free'
            }
            tone={workers.unresponsive > 0 ? 'warn' : workers.online === 0 ? 'error' : 'success'}
          />
          <Stat
            label="Success rate"
            value={formatPercent(runs.successRate)}
            meta="last 24 hours"
            tone={
              runs.successRate === null
                ? undefined
                : runs.successRate >= 0.95
                  ? 'success'
                  : runs.successRate >= 0.8
                    ? 'warn'
                    : 'error'
            }
          />
          <Stat
            label="Dead letters"
            value={deadLetters.open}
            meta={deadLetters.open > 0 ? 'need attention' : 'clear'}
            tone={deadLetters.open > 0 ? 'error' : 'success'}
          />
          <Stat
            label="Outbox"
            value={outbox.pending}
            meta={outbox.failed > 0 ? outbox.failed + ' failed' : 'pending dispatch'}
            tone={outbox.failed > 0 ? 'error' : outbox.pending > 50 ? 'warn' : undefined}
          />
        </StatGrid>
      </div>

      <div className={ui.section}>
        <Card
          title="Throughput"
          action={
            <span className={ui.muted} style={{ fontSize: 'var(--text-xs)' }}>
              {formatCount(runs.last24h.total)} runs · {runs.last24h.succeeded} succeeded ·{' '}
              {runs.last24h.failed} failed
            </span>
          }
        >
          <ThroughputChart data={throughput} />
        </Card>
      </div>

      <Card title="Recent runs" flush>
        {recentRuns.length === 0 ? (
          <Empty
            title="No runs yet"
            hint="Seed the demo workflows with `pnpm demo:seed`, then trigger one with `pnpm demo:run`."
          />
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Workflow</th>
                  <th>State</th>
                  <th className={ui.numeric}>Tasks</th>
                  <th className={ui.numeric}>Duration</th>
                  <th>Triggered by</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id} className={ui.tableRowLink}>
                    <td>
                      <Link href={'/console/runs/' + run.id} className={ui.mono}>
                        {shortId(run.id)}
                      </Link>
                    </td>
                    <td>
                      <Link href={'/console/runs/' + run.id}>{run.workflowKey}</Link>{' '}
                      <span className={ui.muted}>v{run.version}</span>
                    </td>
                    <td>
                      <StateBadge state={run.state} />
                    </td>
                    <td className={ui.numeric}>
                      {run.counts.succeeded}/{run.counts.total}
                    </td>
                    <td className={ui.numeric}>{formatDuration(run.durationMs)}</td>
                    <td className={ui.muted}>{run.triggeredBy}</td>
                    <td className={ui.muted}>
                      <TimeAgo iso={run.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
