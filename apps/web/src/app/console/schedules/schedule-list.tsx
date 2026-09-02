'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { ScheduleView } from '@forge/contracts';
import { forgeApi } from '@/lib/api';
import { formatDateTime, shortId } from '@/lib/format';
import { TimeAgo } from '@/components/time-ago';
import { Card, Empty, ErrorBox, PageHeader, ui } from '@/components/ui';

/**
 * Schedules.
 *
 * Pausing and resuming are the only mutations exposed here. Resuming recomputes the next
 * occurrence from now rather than replaying everything missed while paused — the note
 * under the table says so, because the alternative behaviour is what people expect and
 * being surprised by a stampede is worse than reading one sentence.
 */
export function ScheduleList({ items }: { items: ScheduleView[] }): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await forgeApi.setScheduleEnabled(id, enabled);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Schedules"
        count={
          items.filter((s) => s.enabled).length +
          ' active of ' +
          items.length +
          (items.length === 1 ? ' schedule' : ' schedules')
        }
        subtitle="Durable cron and one-shot triggers, stored in PostgreSQL."
      />

      {error && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      <Card flush>
        {items.length === 0 ? (
          <Empty
            title="No schedules"
            hint="Create one with `forge schedules` or the POST /v1/schedules endpoint."
          />
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Workflow</th>
                  <th>Cron</th>
                  <th>Timezone</th>
                  <th>Next run</th>
                  <th>Last run</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((schedule) => (
                  <tr key={schedule.id}>
                    <td>{schedule.name}</td>
                    <td>
                      <Link href={'/console/workflows/' + schedule.workflowKey} className={ui.mono}>
                        {schedule.workflowKey}
                      </Link>
                    </td>
                    <td className={ui.mono}>{schedule.cron ?? 'one-shot'}</td>
                    <td className={ui.muted}>{schedule.timezone}</td>
                    <td className={ui.mono} title={formatDateTime(schedule.nextRunAt)}>
                      {schedule.enabled ? <TimeAgo iso={schedule.nextRunAt} /> : '—'}
                    </td>
                    <td className={ui.muted}>
                      {schedule.lastRunId ? (
                        <Link href={'/console/runs/' + schedule.lastRunId} className={ui.mono}>
                          {shortId(schedule.lastRunId)}
                        </Link>
                      ) : (
                        <TimeAgo iso={schedule.lastRunAt} />
                      )}
                    </td>
                    <td>
                      <span
                        style={{
                          color: schedule.enabled ? 'var(--state-success)' : 'var(--text-tertiary)',
                          fontSize: 'var(--text-xs)',
                        }}
                      >
                        {schedule.enabled ? 'enabled' : 'paused'}
                      </span>
                    </td>
                    <td>
                      <button
                        className={ui.button + ' ' + ui.buttonSmall}
                        onClick={() => void toggle(schedule.id, !schedule.enabled)}
                        disabled={busy !== null}
                      >
                        {schedule.enabled ? 'Pause' : 'Resume'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className={ui.hint} style={{ marginTop: 'var(--space-3)' }}>
        Resuming a paused schedule recomputes its next occurrence from now — occurrences missed
        while it was paused are not replayed.
      </p>
    </>
  );
}
