'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ExecutionEvent,
  TaskAttemptView,
  TaskRunView,
  WorkflowRunView,
} from '@forge/contracts';
import { forgeApi } from '@/lib/api';
import {
  eventTone,
  formatClock,
  formatDateTime,
  formatDuration,
  formatJson,
  shortId,
} from '@/lib/format';
import { Card, CodeBlock, ErrorBox, KeyValue, PageHeader, StateBadge, ui } from '@/components/ui';
import { DagGraph } from '@/components/dag/graph';
import { useRunStream } from '@/lib/use-run-stream';
import styles from './run-view.module.css';

/**
 * Live execution view.
 *
 * The graph, timeline and detail panel are three views of one subscription — they cannot
 * disagree, because they render from the same state. Selecting a node filters the
 * timeline and loads that task's attempt history.
 */
export function RunView({
  runId,
  initialRun,
  initialEvents,
}: {
  runId: string;
  initialRun: WorkflowRunView;
  initialEvents: ExecutionEvent[];
}): ReactNode {
  const router = useRouter();
  const { run, events, connected } = useRunStream(runId, initialRun, initialEvents);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const tasksByKey = useMemo(() => {
    const map: Record<string, TaskRunView> = {};
    for (const task of run.tasks ?? []) map[task.nodeKey] = task;
    return map;
  }, [run.tasks]);

  const selectedTask = selectedKey ? tasksByKey[selectedKey] : undefined;
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state);

  const visibleEvents = useMemo(
    () => (selectedKey ? events.filter((e) => e.nodeKey === selectedKey) : events),
    [events, selectedKey],
  );

  const cancel = async (): Promise<void> => {
    setBusy('cancel');
    setActionError(null);
    try {
      const result = await forgeApi.cancelRun(runId, 'cancelled from the console');
      if (!result.accepted) setActionError(result.message);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const replay = async (): Promise<void> => {
    setBusy('replay');
    setActionError(null);
    try {
      const result = await forgeApi.replayRun(runId);
      router.push('/console/runs/' + result.runId);
    } catch (err) {
      setActionError((err as Error).message);
      setBusy(null);
    }
  };

  // How many distinct workers touched this run — the one number that makes the
  // distribution visible without opening the fleet page.
  const workerCount = new Set((run.tasks ?? []).map((t) => t.workerId).filter(Boolean)).size;

  return (
    <>
      <PageHeader
        title={run.workflowName}
        subtitle={run.workflowKey + ' v' + run.version + ' · ' + runId}
        actions={
          <>
            <span className={styles.live}>
              <span className={styles.liveDot + (connected ? '' : ' ' + styles.liveDotOff)} />
              {terminal ? 'finished' : connected ? 'live' : 'reconnecting…'}
            </span>
            {!terminal && (
              <button
                className={ui.button + ' ' + ui.buttonDanger}
                onClick={() => void cancel()}
                disabled={busy !== null}
              >
                Cancel run
              </button>
            )}
            <button className={ui.button} onClick={() => void replay()} disabled={busy !== null}>
              Replay
            </button>
            <Link href={'/console/workflows/' + run.workflowKey} className={ui.button}>
              Definition
            </Link>
          </>
        }
      />

      {actionError && (
        <div className={styles.errorBanner}>
          <ErrorBox>{actionError}</ErrorBox>
        </div>
      )}

      {run.errorMessage && (
        <div className={styles.errorBanner}>
          <ErrorBox>{run.errorMessage}</ErrorBox>
        </div>
      )}

      {/* The run's vital signs, as an instrument readout rather than a row of pills. The
          figures are large and monospaced so duration, progress and fan-out can be read
          from the graph without moving your eyes back to prose. */}
      <div className={styles.readout}>
        <div className={styles.readoutItem}>
          <span className={styles.readoutLabel}>State</span>
          <span className={styles.readoutValue}>
            <StateBadge state={run.state} />
          </span>
        </div>
        <div className={styles.readoutItem}>
          <span className={styles.readoutLabel}>Duration</span>
          <span className={styles.readoutValue}>{formatDuration(run.durationMs)}</span>
        </div>
        <div className={styles.readoutItem}>
          <span className={styles.readoutLabel}>Tasks</span>
          <span className={styles.readoutValue}>
            {run.counts.succeeded}
            <span className={styles.readoutOf}>/{run.counts.total}</span>
          </span>
        </div>
        <div className={styles.readoutItem}>
          <span className={styles.readoutLabel}>Workers</span>
          <span className={styles.readoutValue}>{workerCount}</span>
        </div>
        {run.counts.running > 0 && (
          <div className={styles.readoutItem}>
            <span className={styles.readoutLabel}>Running</span>
            <span className={styles.readoutValue}>{run.counts.running}</span>
          </div>
        )}
        {run.counts.retrying > 0 && (
          <div className={styles.readoutItem}>
            <span className={styles.readoutLabel}>Retrying</span>
            <span className={styles.readoutValue + ' ' + styles.readoutWarn}>
              {run.counts.retrying}
            </span>
          </div>
        )}
        {run.counts.deadLettered > 0 && (
          <div className={styles.readoutItem}>
            <span className={styles.readoutLabel}>Dead-lettered</span>
            <span className={styles.readoutValue + ' ' + styles.readoutError}>
              {run.counts.deadLettered}
            </span>
          </div>
        )}
        {run.counts.skipped > 0 && (
          <div className={styles.readoutItem}>
            <span className={styles.readoutLabel}>Skipped</span>
            <span className={styles.readoutValue}>{run.counts.skipped}</span>
          </div>
        )}
      </div>

      <div className={styles.layout}>
        <div>
          <div className={ui.section}>
            {run.definition ? (
              <DagGraph
                definition={run.definition}
                tasks={tasksByKey}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
                height={440}
                minimap={run.definition.nodes.length > 5}
              />
            ) : (
              <ErrorBox>The run&apos;s workflow definition could not be loaded.</ErrorBox>
            )}
          </div>

          <Card
            title={selectedKey ? 'Timeline · ' + selectedKey : 'Timeline'}
            action={
              selectedKey ? (
                <button
                  className={ui.button + ' ' + ui.buttonGhost + ' ' + ui.buttonSmall}
                  onClick={() => setSelectedKey(null)}
                >
                  Show all
                </button>
              ) : (
                <span className={ui.muted} style={{ fontSize: 'var(--text-xs)' }}>
                  {events.length} events
                </span>
              )
            }
            flush
          >
            <Timeline events={visibleEvents} follow={!terminal} />
          </Card>
        </div>

        <div className={styles.panel}>
          <TaskPanel task={selectedTask} />
        </div>
      </div>
    </>
  );
}

/**
 * The execution timeline.
 *
 * Auto-scrolls to the newest event only while the user is already at the bottom —
 * yanking the viewport away from something someone is reading is the fastest way to make
 * a live view unusable.
 */
function Timeline({ events, follow }: { events: ExecutionEvent[]; follow: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onScroll = (): void => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      pinned.current = distance < 40;
    };
    element.addEventListener('scroll', onScroll);
    return (): void => element.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!follow || !pinned.current) return;
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [events.length, follow]);

  if (events.length === 0) {
    return <div className={styles.emptyPanel}>No events yet.</div>;
  }

  const toneClass: Record<string, string> = {
    success: styles.toneSuccess as string,
    error: styles.toneError as string,
    warn: styles.toneWarn as string,
    running: styles.toneRunning as string,
    idle: styles.toneIdle as string,
  };

  return (
    <div className={styles.timeline} ref={ref}>
      {events.map((event) => (
        <div key={event.id} className={styles.timelineRow + ' ' + toneClass[eventTone(event.type)]}>
          <span className={styles.timelineTime}>{formatClock(event.occurredAt)}</span>
          <span className={styles.timelineBody}>
            {event.nodeKey && <span className={styles.timelineNode}>{event.nodeKey} </span>}
            <span className={styles.timelineMessage}>
              {event.message ?? event.type.toLowerCase().replace(/_/g, ' ')}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Task detail: metadata, input/output, and the full attempt history. */
function TaskPanel({ task }: { task: TaskRunView | undefined }): ReactNode {
  const [attempts, setAttempts] = useState<TaskAttemptView[]>([]);

  useEffect(() => {
    if (!task) {
      setAttempts([]);
      return;
    }
    let cancelled = false;
    // Fetched only for the selected node. Loading attempt history for every node in a
    // 40-node graph would be 40 requests to render one panel that shows one of them.
    void forgeApi.taskAttempts(task.id).then((list) => {
      if (!cancelled) setAttempts(list);
    });
    return (): void => {
      cancelled = true;
    };
    // `task.attempts` is in the dependency list so the history reloads when a retry
    // adds one — the panel must not go stale while a task is being retried.
  }, [task?.id, task?.attempts, task]);

  if (!task) {
    return (
      <Card title="Task detail">
        <div className={styles.emptyPanel}>
          Select a node in the graph to inspect its input, output, worker and attempt history.
        </div>
      </Card>
    );
  }

  return (
    <Card title={task.nodeKey} flush>
      <div className={styles.panelSection}>
        <KeyValue
          entries={[
            ['State', <StateBadge key="s" state={task.state} />],
            [
              'Type',
              <span key="t" className={ui.mono}>
                {task.type}
              </span>,
            ],
            [
              'Queue',
              <span key="q" className={ui.mono}>
                {task.queue}
              </span>,
            ],
            [
              'Attempts',
              <span key="a" className={ui.mono}>
                {task.attempts} / {task.maxAttempts}
              </span>,
            ],
            [
              'Duration',
              <span key="d" className={ui.mono}>
                {formatDuration(task.durationMs)}
              </span>,
            ],
            [
              'Worker',
              <span key="w" className={ui.mono}>
                {task.workerId ? shortId(task.workerId, 12) : '—'}
              </span>,
            ],
            [
              'Depends on',
              <span key="dep" className={ui.mono}>
                {task.dependsOn.length > 0 ? task.dependsOn.join(', ') : '—'}
              </span>,
            ],
            [
              'Started',
              <span key="st" className={ui.mono}>
                {formatDateTime(task.startedAt)}
              </span>,
            ],
            [
              'Finished',
              <span key="fi" className={ui.mono}>
                {formatDateTime(task.finishedAt)}
              </span>,
            ],
            ...(task.nextAttemptAt
              ? [
                  [
                    'Next attempt',
                    <span key="na" className={ui.mono}>
                      {formatDateTime(task.nextAttemptAt)}
                    </span>,
                  ] as [string, ReactNode],
                ]
              : []),
            ...(task.traceId
              ? [
                  [
                    'Trace',
                    <a
                      key="tr"
                      className={ui.mono}
                      href={'http://localhost:16686/trace/' + task.traceId}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--accent)' }}
                    >
                      {shortId(task.traceId, 16)} ↗
                    </a>,
                  ] as [string, ReactNode],
                ]
              : []),
          ]}
        />
      </div>

      {task.errorMessage && (
        <div className={styles.panelSection}>
          <div className={styles.panelLabel}>Error</div>
          <ErrorBox>
            {task.errorCode ? task.errorCode + ': ' : ''}
            {task.errorMessage}
          </ErrorBox>
        </div>
      )}

      {task.lease && (
        <div className={styles.panelSection}>
          <div className={styles.panelLabel}>Active lease</div>
          <KeyValue
            entries={[
              [
                'Worker',
                <span key="lw" className={ui.mono}>
                  {shortId(task.lease.workerId, 12)}
                </span>,
              ],
              [
                'Expires',
                <span key="le" className={ui.mono}>
                  {formatDateTime(task.lease.expiresAt)}
                </span>,
              ],
              [
                'Heartbeat',
                <span key="lh" className={ui.mono}>
                  {formatDateTime(task.lease.heartbeatAt)}
                </span>,
              ],
            ]}
          />
        </div>
      )}

      <div className={styles.panelSection}>
        <div className={styles.panelLabel}>Input</div>
        <CodeBlock>{formatJson(task.input)}</CodeBlock>
      </div>

      <div className={styles.panelSection}>
        <div className={styles.panelLabel}>Output</div>
        <CodeBlock>{formatJson(task.output)}</CodeBlock>
      </div>

      {attempts.length > 0 && (
        <div className={styles.panelSection}>
          <div className={styles.panelLabel}>Attempts ({attempts.length})</div>
          <div className={styles.attempts}>
            {attempts.map((attempt) => (
              <div key={attempt.id} className={styles.attempt}>
                <span className={styles.attemptNumber}>#{attempt.attemptNumber}</span>
                <StateBadge state={attempt.state} />
                <span className={styles.attemptMeta}>
                  {formatDuration(attempt.durationMs)}
                  {attempt.workerId ? ' · ' + shortId(attempt.workerId, 6) : ''}
                </span>
                {attempt.errorMessage && (
                  <span className={styles.attemptError}>
                    {attempt.errorCode ? attempt.errorCode + ': ' : ''}
                    {attempt.errorMessage}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
