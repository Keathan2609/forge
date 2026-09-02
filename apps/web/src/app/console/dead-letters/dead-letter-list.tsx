'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { DeadLetterView } from '@forge/contracts';
import { forgeApi } from '@/lib/api';
import { formatDuration, shortId } from '@/lib/format';
import { TimeAgo } from '@/components/time-ago';
import { CodeBlock, Empty, ErrorBox, KeyValue, PageHeader, StateBadge, ui } from '@/components/ui';
import styles from './dead-letters.module.css';

const STATUSES = ['OPEN', 'REPLAYED', 'ACKNOWLEDGED'] as const;

/**
 * The dead-letter queue, as an operational ledger.
 *
 * Every entry expands to show the *complete* attempt history — every attempt, its
 * worker, its duration and its error. That is the whole value of the page: "it failed"
 * is not actionable, "it failed three times on three different workers with the same
 * error" is.
 *
 * The row is a ledger line rather than a card because the page's job is comparison. An
 * operator scans the error column looking for the one entry that is not the same
 * `SIMULATED_FAILURE` as the eleven above it, and aligned columns are what make that
 * possible.
 */
export function DeadLetterList({
  items,
  status,
  counts,
}: {
  items: DeadLetterView[];
  status: string;
  counts: Record<string, number>;
}): ReactNode {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (id: string, action: 'retry' | 'acknowledge'): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      if (action === 'retry') await forgeApi.retryDeadLetter(id);
      else await forgeApi.acknowledgeDeadLetter(id);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openCount = counts.OPEN ?? 0;

  return (
    <>
      <PageHeader
        title="Dead letters"
        count={
          openCount === 0
            ? 'No unresolved tasks'
            : openCount + (openCount === 1 ? ' unresolved task' : ' unresolved tasks')
        }
        subtitle="Tasks that exhausted their retry budget and require intervention."
      />

      <div className={styles.filters}>
        {STATUSES.map((option) => (
          <Link
            key={option}
            href={'/console/dead-letters?status=' + option}
            className={styles.filter + (status === option ? ' ' + styles.filterActive : '')}
            aria-current={status === option ? 'page' : undefined}
          >
            <span className={styles.filterLabel}>{option}</span>
            <span className={styles.filterCount}>
              {String(counts[option] ?? 0).padStart(2, '0')}
            </span>
          </Link>
        ))}
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      {items.length === 0 ? (
        <Empty
          title={status === 'OPEN' ? 'No open dead letters' : 'Nothing here'}
          hint={
            status === 'OPEN'
              ? 'Every task that has failed so far either recovered or is still retrying.'
              : undefined
          }
        />
      ) : (
        <div className={styles.ledger}>
          <div className={styles.head} aria-hidden="true">
            <span>Workflow</span>
            <span>Task</span>
            <span>Error</span>
            <span className={styles.headRight}>Attempts</span>
            <span className={styles.headRight}>Age</span>
            <span className={styles.headRight}>Status</span>
          </div>

          {items.map((item) => {
            const open = expanded === item.id;
            return (
              <div key={item.id} className={styles.entry}>
                <button
                  className={styles.row + (open ? ' ' + styles.rowOpen : '')}
                  onClick={() => setExpanded(open ? null : item.id)}
                  aria-expanded={open}
                >
                  <span className={styles.workflow}>{item.workflowKey}</span>
                  <span className={styles.task}>{item.nodeKey}</span>
                  <span className={styles.error}>
                    {item.errorCode && <span className={styles.errorCode}>{item.errorCode}</span>}
                    <span className={styles.errorMessage}>{item.errorMessage}</span>
                  </span>
                  <span className={styles.attempts}>{String(item.attempts).padStart(2, '0')}</span>
                  <span className={styles.age}>
                    <TimeAgo iso={item.createdAt} />
                  </span>
                  <span className={styles.status}>
                    <StateBadge
                      state={item.status === 'OPEN' ? 'FAILED' : 'SKIPPED'}
                      label={item.status}
                    />
                    <span className={styles.chevron + (open ? ' ' + styles.chevronOpen : '')}>
                      ›
                    </span>
                  </span>
                </button>

                {open && (
                  <div className={styles.body}>
                    <div className={styles.detailGrid}>
                      <div>
                        <div className={styles.sectionLabel}>Details</div>
                        <KeyValue
                          entries={[
                            [
                              'Handler',
                              <span key="t" className={ui.mono}>
                                {item.type}
                              </span>,
                            ],
                            [
                              'Run',
                              <Link
                                key="r"
                                href={'/console/runs/' + item.workflowRunId}
                                className={ui.mono}
                                style={{ textDecoration: 'underline' }}
                              >
                                {shortId(item.workflowRunId, 12)} →
                              </Link>,
                            ],
                            [
                              'Task',
                              <span key="k" className={ui.mono}>
                                {shortId(item.taskRunId, 12)}
                              </span>,
                            ],
                            ['Created', <TimeAgo key="c" iso={item.createdAt} />],
                            ...(item.resolvedAt
                              ? ([
                                  [
                                    'Resolved',
                                    <span key="rs">
                                      <TimeAgo iso={item.resolvedAt} /> by{' '}
                                      {item.resolvedBy ?? 'unknown'}
                                    </span>,
                                  ],
                                ] as Array<[string, ReactNode]>)
                              : []),
                          ]}
                        />
                        <div
                          className={styles.sectionLabel}
                          style={{ marginTop: 'var(--space-6)' }}
                        >
                          Input
                        </div>
                        <CodeBlock>{JSON.stringify(item.input, null, 2)}</CodeBlock>
                      </div>

                      <div>
                        <div className={styles.sectionLabel}>
                          Attempt history ({item.attemptHistory.length})
                        </div>
                        <div>
                          {item.attemptHistory.map((attempt) => (
                            <div key={attempt.id} className={styles.attemptRow}>
                              <span className={styles.attemptNumber}>
                                {String(attempt.attemptNumber).padStart(2, '0')}
                              </span>
                              <StateBadge state={attempt.state} />
                              <span className={styles.attemptError}>
                                {attempt.errorMessage ?? '—'}
                              </span>
                              <span className={styles.attemptMeta}>
                                {formatDuration(attempt.durationMs)}
                                {attempt.workerId
                                  ? ' · worker ' + shortId(attempt.workerId, 6)
                                  : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {item.status === 'OPEN' && (
                      <div className={styles.entryActions}>
                        <button
                          className={ui.button + ' ' + ui.buttonPrimary}
                          onClick={() => void act(item.id, 'retry')}
                          disabled={busy !== null}
                        >
                          Retry task
                        </button>
                        <button
                          className={ui.button}
                          onClick={() => void act(item.id, 'acknowledge')}
                          disabled={busy !== null}
                        >
                          Acknowledge
                        </button>
                        <span className={styles.actionNote}>
                          Retry returns the task to the queue with a fresh retry budget. It only
                          works while the parent run is still live.
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
