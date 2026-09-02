'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { DeadLetterView } from '@forge/contracts';
import { forgeApi } from '@/lib/api';
import { formatDuration, formatRelative, shortId } from '@/lib/format';
import {
  Card,
  CodeBlock,
  Empty,
  ErrorBox,
  KeyValue,
  PageHeader,
  StateBadge,
  ui,
} from '@/components/ui';
import styles from './dead-letters.module.css';

const STATUSES = ['OPEN', 'REPLAYED', 'ACKNOWLEDGED'] as const;

/**
 * The dead-letter queue.
 *
 * Every entry expands to show the *complete* attempt history — every attempt, its
 * worker, its duration and its error. That is the whole value of the page: "it failed"
 * is not actionable, "it failed three times on three different workers with the same
 * error" is.
 */
export function DeadLetterList({
  items,
  status,
}: {
  items: DeadLetterView[];
  status: string;
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

  return (
    <>
      <PageHeader
        title="Dead letters"
        subtitle="Tasks that exhausted their retry budget and are waiting for a decision"
        actions={
          <div className={ui.actions}>
            {STATUSES.map((option) => (
              <Link
                key={option}
                href={'/console/dead-letters?status=' + option}
                className={
                  ui.button + ' ' + ui.buttonSmall + (status === option ? '' : ' ' + ui.buttonGhost)
                }
              >
                {option.toLowerCase()}
              </Link>
            ))}
          </div>
        }
      />

      {error && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      {items.length === 0 ? (
        <Card>
          <Empty
            title={status === 'OPEN' ? 'No open dead letters' : 'Nothing here'}
            hint={
              status === 'OPEN'
                ? 'Every task that has failed so far either recovered or is still retrying.'
                : undefined
            }
          />
        </Card>
      ) : (
        <div className={styles.list}>
          {items.map((item) => {
            const open = expanded === item.id;
            return (
              <div key={item.id} className={styles.entry}>
                <button
                  className={styles.entryHeader}
                  onClick={() => setExpanded(open ? null : item.id)}
                  aria-expanded={open}
                >
                  <span className={styles.entryMain}>
                    <span className={styles.entryTitle}>
                      <span className={ui.mono}>{item.workflowKey}</span>
                      <span className={styles.separator}>/</span>
                      <span className={styles.entryNode}>{item.nodeKey}</span>
                    </span>
                    <span className={styles.entryError}>
                      {item.errorCode ? item.errorCode + ': ' : ''}
                      {item.errorMessage}
                    </span>
                  </span>
                  <span className={styles.entryMeta}>
                    <StateBadge
                      state={item.status === 'OPEN' ? 'FAILED' : 'SKIPPED'}
                      label={item.status}
                    />
                    <span className={ui.mono}>{item.attempts} attempts</span>
                    <span className={ui.muted}>{formatRelative(item.createdAt)}</span>
                    <span className={styles.chevron + (open ? ' ' + styles.chevronOpen : '')}>
                      ›
                    </span>
                  </span>
                </button>

                {open && (
                  <div className={styles.entryBody}>
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
                                style={{ color: 'var(--accent)' }}
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
                            ['Created', formatRelative(item.createdAt)],
                            ...(item.resolvedAt
                              ? ([
                                  [
                                    'Resolved',
                                    formatRelative(item.resolvedAt) +
                                      ' by ' +
                                      (item.resolvedBy ?? 'unknown'),
                                  ],
                                ] as Array<[string, ReactNode]>)
                              : []),
                          ]}
                        />
                        <div
                          className={styles.sectionLabel}
                          style={{ marginTop: 'var(--space-4)' }}
                        >
                          Input
                        </div>
                        <CodeBlock>{JSON.stringify(item.input, null, 2)}</CodeBlock>
                      </div>

                      <div>
                        <div className={styles.sectionLabel}>
                          Attempt history ({item.attemptHistory.length})
                        </div>
                        <div className={styles.attempts}>
                          {item.attemptHistory.map((attempt) => (
                            <div key={attempt.id} className={styles.attempt}>
                              <span className={styles.attemptNumber}>#{attempt.attemptNumber}</span>
                              <StateBadge state={attempt.state} />
                              <span className={styles.attemptMeta}>
                                {formatDuration(attempt.durationMs)}
                                {attempt.workerId ? ' · ' + shortId(attempt.workerId, 6) : ''}
                              </span>
                              {attempt.errorMessage && (
                                <span className={styles.attemptError}>{attempt.errorMessage}</span>
                              )}
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
                        <span className={ui.muted} style={{ fontSize: 'var(--text-xs)' }}>
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
