import Link from 'next/link';
import type { ReactNode } from 'react';
import { forgeApi } from '@/lib/api';
import { formatDuration, formatPercent } from '@/lib/format';
import { TimeAgo } from '@/components/time-ago';
import { Card, Empty, ErrorBox, PageHeader, ui } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Workflows' };

export default async function WorkflowsPage(): Promise<ReactNode> {
  let items;
  try {
    items = (await forgeApi.workflows()).items;
  } catch (err) {
    return (
      <>
        <PageHeader title="Workflows" />
        <ErrorBox>Could not load workflows: {(err as Error).message}</ErrorBox>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Workflows"
        count={items.length + (items.length === 1 ? ' definition' : ' definitions')}
        subtitle="Immutable, content-addressed definitions and their execution history."
        actions={
          <Link href="/console/workflows/new" className={ui.button + ' ' + ui.buttonPrimary}>
            New workflow
          </Link>
        }
      />

      <Card flush>
        {items.length === 0 ? (
          <Empty
            title="No workflows defined"
            hint="Run `pnpm demo:seed` to install the demo workflows, or create one in the editor."
          />
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Name</th>
                  <th className={ui.numeric}>Version</th>
                  <th className={ui.numeric}>Nodes</th>
                  <th className={ui.numeric}>Runs</th>
                  <th className={ui.numeric}>Success</th>
                  <th className={ui.numeric}>Avg duration</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((workflow) => (
                  <tr key={workflow.id} className={ui.tableRowLink}>
                    <td>
                      <Link href={'/console/workflows/' + workflow.key} className={ui.mono}>
                        {workflow.key}
                      </Link>
                    </td>
                    <td>{workflow.name}</td>
                    <td className={ui.numeric}>v{workflow.latestVersion}</td>
                    <td className={ui.numeric}>{workflow.nodeCount}</td>
                    <td className={ui.numeric}>{workflow.stats.total}</td>
                    <td
                      className={ui.numeric}
                      style={{
                        color:
                          workflow.stats.successRate === null
                            ? 'var(--text-tertiary)'
                            : workflow.stats.successRate >= 0.95
                              ? 'var(--state-success)'
                              : workflow.stats.successRate >= 0.8
                                ? 'var(--state-warn)'
                                : 'var(--state-error)',
                      }}
                    >
                      {formatPercent(workflow.stats.successRate)}
                    </td>
                    <td className={ui.numeric}>{formatDuration(workflow.stats.p50DurationMs)}</td>
                    <td className={ui.muted}>
                      <TimeAgo iso={workflow.updatedAt} />
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
