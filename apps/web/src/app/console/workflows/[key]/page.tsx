import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ApiError, forgeApi } from '@/lib/api';
import { formatDuration, shortId } from '@/lib/format';
import { TimeAgo } from '@/components/time-ago';
import { Card, CodeBlock, Empty, KeyValue, PageHeader, StateBadge, ui } from '@/components/ui';
import { DagGraph } from '@/components/dag/graph';
import { TriggerPanel } from './trigger-panel';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<{ title: string }> {
  const { key } = await params;
  return { title: key };
}

export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ version?: string }>;
}): Promise<ReactNode> {
  const { key } = await params;
  const { version } = await searchParams;

  let workflow;
  let versions;
  let recentRuns;

  try {
    workflow = await forgeApi.workflow(key, version ? Number(version) : undefined);
    [versions, recentRuns] = await Promise.all([
      forgeApi.versions(key),
      forgeApi.runs({ workflowKey: key, limit: 10 }),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const definition = workflow.definition;

  return (
    <>
      <PageHeader
        title={workflow.name}
        subtitle={workflow.key + ' · version ' + workflow.version}
        actions={
          <>
            <Link href={'/console/runs?workflow=' + encodeURIComponent(key)} className={ui.button}>
              All runs
            </Link>
            <Link
              href={'/console/workflows/' + encodeURIComponent(key) + '/edit'}
              className={ui.button}
            >
              Edit
            </Link>
          </>
        }
      />

      {definition.description && (
        <p className={ui.pageSubtitle} style={{ marginBottom: 'var(--space-4)' }}>
          {definition.description}
        </p>
      )}

      <div className={ui.section}>
        <DagGraph definition={definition} height={420} minimap={definition.nodes.length > 5} />
      </div>

      <div className={ui.grid2 + ' ' + ui.section}>
        <Card title="Shape">
          <KeyValue
            entries={[
              ['Nodes', String(workflow.analysis.nodes)],
              ['Edges', String(workflow.analysis.edges)],
              ['Entry nodes', workflow.analysis.entryNodes.join(', ') || '—'],
              ['Critical path', workflow.analysis.criticalPath + ' tasks deep'],
              ['Run timeout', formatDuration(definition.timeoutMs)],
              [
                'Default retries',
                definition.defaultRetryPolicy.maxAttempts +
                  ' attempts, ' +
                  formatDuration(definition.defaultRetryPolicy.initialDelayMs) +
                  ' × ' +
                  definition.defaultRetryPolicy.multiplier,
              ],
            ]}
          />
        </Card>

        <TriggerPanel workflowKey={key} inputSchema={definition.inputSchema} />
      </div>

      <div className={ui.section}>
        <Card title="Tasks" flush>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Handler</th>
                  <th>Queue</th>
                  <th className={ui.numeric}>Timeout</th>
                  <th className={ui.numeric}>Retries</th>
                  <th>Depends on</th>
                  <th>Condition</th>
                </tr>
              </thead>
              <tbody>
                {definition.nodes.map((node) => (
                  <tr key={node.key}>
                    <td className={ui.mono}>{node.key}</td>
                    <td className={ui.mono}>{node.type}</td>
                    <td className={ui.mono}>{node.queue}</td>
                    <td className={ui.numeric}>{formatDuration(node.timeoutMs)}</td>
                    <td className={ui.numeric}>{node.retryPolicy.maxAttempts}</td>
                    <td className={ui.muted}>
                      {definition.edges
                        .filter((e) => e.to === node.key)
                        .map((e) => e.from)
                        .join(', ') || '—'}
                    </td>
                    <td className={ui.mono}>{node.condition ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className={ui.grid2}>
        <Card title="Recent runs" flush>
          {recentRuns.items.length === 0 ? (
            <Empty title="No runs yet" />
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>State</th>
                    <th className={ui.numeric}>Duration</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.items.map((run) => (
                    <tr key={run.id} className={ui.tableRowLink}>
                      <td>
                        <Link href={'/console/runs/' + run.id} className={ui.mono}>
                          {shortId(run.id)}
                        </Link>
                      </td>
                      <td>
                        <StateBadge state={run.state} />
                      </td>
                      <td className={ui.numeric}>{formatDuration(run.durationMs)}</td>
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

        <Card title="Versions" flush>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.numeric}>Version</th>
                  <th>Checksum</th>
                  <th>Changelog</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {versions.items.slice(0, 10).map((entry) => (
                  <tr key={entry.id} className={ui.tableRowLink}>
                    <td className={ui.numeric}>
                      <Link href={'/console/workflows/' + key + '?version=' + entry.version}>
                        v{entry.version}
                      </Link>
                    </td>
                    <td className={ui.mono}>{entry.checksum.slice(0, 12)}</td>
                    <td className={ui.muted}>{entry.changelog ?? '—'}</td>
                    <td className={ui.muted}>
                      <TimeAgo iso={entry.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className={ui.section} style={{ marginTop: 'var(--space-6)' }}>
        <Card title="Definition">
          <CodeBlock>{JSON.stringify(definition, null, 2)}</CodeBlock>
        </Card>
      </div>
    </>
  );
}
