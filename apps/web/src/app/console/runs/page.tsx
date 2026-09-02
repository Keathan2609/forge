import Link from 'next/link';
import type { ReactNode } from 'react';
import { forgeApi } from '@/lib/api';
import { formatDuration, shortId } from '@/lib/format';
import { AutoRefresh } from '@/components/auto-refresh';
import { TimeAgo } from '@/components/time-ago';
import { Card, Empty, ErrorBox, PageHeader, StateBadge, ui } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Runs' };

const STATES = [
  'ALL',
  'RUNNING',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const;

/**
 * Run list.
 *
 * Filters live in the URL rather than component state, so a filtered view is a link
 * someone can paste into an incident channel.
 */
export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; workflow?: string; cursor?: string }>;
}): Promise<ReactNode> {
  const params = await searchParams;
  const state = params.state && params.state !== 'ALL' ? params.state : undefined;

  let page;
  try {
    page = await forgeApi.runs({
      limit: 40,
      ...(state ? { state } : {}),
      ...(params.workflow ? { workflowKey: params.workflow } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    });
  } catch (err) {
    return (
      <>
        <PageHeader title="Runs" />
        <ErrorBox>Could not load runs: {(err as Error).message}</ErrorBox>
      </>
    );
  }

  const query = (next: Record<string, string | undefined>): string => {
    const search = new URLSearchParams();
    const merged = { state: params.state, workflow: params.workflow, ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value && value !== 'ALL') search.set(key, value);
    }
    const qs = search.toString();
    return '/console/runs' + (qs ? '?' + qs : '');
  };

  return (
    <>
      {/* Only poll when the list can actually change under you. */}
      <AutoRefresh intervalMs={4_000} enabled={state !== 'SUCCEEDED' && state !== 'FAILED'} />

      <PageHeader
        title="Runs"
        subtitle={
          params.workflow
            ? 'Filtered to ' + params.workflow
            : 'Every workflow execution, newest first'
        }
        actions={
          <div className={ui.actions}>
            {STATES.map((option) => {
              const active = (params.state ?? 'ALL') === option;
              return (
                <Link
                  key={option}
                  href={query({ state: option, cursor: undefined })}
                  className={
                    ui.button + ' ' + ui.buttonSmall + (active ? '' : ' ' + ui.buttonGhost)
                  }
                >
                  {option === 'ALL' ? 'All' : option.toLowerCase().replace('_', ' ')}
                </Link>
              );
            })}
          </div>
        }
      />

      <Card flush>
        {page.items.length === 0 ? (
          <Empty
            title="No runs match this filter"
            hint="Trigger one with `forge run order-fulfilment --example` or from a workflow page."
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
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((run) => (
                  <tr key={run.id} className={ui.tableRowLink}>
                    <td>
                      <Link href={'/console/runs/' + run.id} className={ui.mono}>
                        {shortId(run.id)}
                      </Link>
                    </td>
                    <td>
                      <Link href={query({ workflow: run.workflowKey, cursor: undefined })}>
                        {run.workflowKey}
                      </Link>{' '}
                      <span className={ui.muted}>v{run.version}</span>
                    </td>
                    <td>
                      <StateBadge state={run.state} />
                    </td>
                    <td className={ui.numeric}>
                      {run.counts.succeeded}/{run.counts.total}
                      {run.counts.failed > 0 && (
                        <span style={{ color: 'var(--state-error)' }}>
                          {' '}
                          ({run.counts.failed} failed)
                        </span>
                      )}
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

      {page.hasMore && page.nextCursor && (
        <div className={ui.actions} style={{ marginTop: 'var(--space-4)' }}>
          <Link href={query({ cursor: page.nextCursor })} className={ui.button}>
            Load more
          </Link>
        </div>
      )}
    </>
  );
}
