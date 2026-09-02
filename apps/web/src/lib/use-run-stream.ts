'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecutionEvent, WorkflowRunView } from '@forge/contracts';
import { CLIENT_BASE, forgeApi } from './api';

/**
 * Live run subscription.
 *
 * The contract this hook maintains, and why each part exists:
 *
 *   - events arrive over SSE and are appended in sequence order
 *   - `EventSource` reconnects on its own and resends `Last-Event-ID`, so the server
 *     replays exactly what was missed — no gap, no duplicates
 *   - the *run snapshot* is refetched when an event implies its shape changed, rather
 *     than being reconstructed from the event stream: reconstructing derived state on
 *     the client would mean two implementations of the same rules, and they will
 *     eventually disagree
 *   - once the run is terminal the stream is closed. A finished run emits nothing more,
 *     and one open connection per historical run tab adds up fast.
 */

export interface RunStreamState {
  run: WorkflowRunView;
  events: ExecutionEvent[];
  connected: boolean;
  refresh: () => void;
}

const TERMINAL_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

/** Events that change the run's tasks, and so require a snapshot refetch. */
const STRUCTURAL = [
  'TASK_QUEUED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'TASK_RETRY_SCHEDULED',
  'TASK_TIMED_OUT',
  'TASK_CANCELLED',
  'TASK_SKIPPED',
  'TASK_RECOVERED',
  'TASK_DEAD_LETTERED',
  'TASK_BLOCKED',
  'TASK_READY',
  'LEASE_EXPIRED',
  'WORKFLOW_STARTED',
  'WORKFLOW_COMPLETED',
  'WORKFLOW_FAILED',
  'WORKFLOW_CANCELLED',
  'WORKFLOW_TIMED_OUT',
];

const PASSIVE = ['TASK_PROGRESS', 'TASK_HEARTBEAT', 'WORKFLOW_CREATED', 'LEASE_ACQUIRED'];

export function useRunStream(
  runId: string,
  initialRun: WorkflowRunView,
  initialEvents: ExecutionEvent[],
): RunStreamState {
  const [run, setRun] = useState<WorkflowRunView>(initialRun);
  const [events, setEvents] = useState<ExecutionEvent[]>(initialEvents);
  const [connected, setConnected] = useState(false);

  const lastSeq = useRef(
    initialEvents.length > 0 ? (initialEvents[initialEvents.length - 1]?.seq ?? 0) : 0,
  );
  // Coalesce refetches: a fan-out completing produces several events in the same tick,
  // and each must not trigger its own request.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminal = TERMINAL_STATES.includes(run.state);

  const refresh = useCallback(() => {
    void forgeApi
      .run(runId)
      .then(setRun)
      .catch(() => {
        /* transient; the next event or the poll below will retry */
      });
  }, [runId]);

  const scheduleRefresh = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      refresh();
    }, 120);
  }, [refresh]);

  useEffect(() => {
    if (terminal) {
      setConnected(false);
      return;
    }

    const url = new URL(CLIENT_BASE + '/v1/runs/' + runId + '/stream');
    if (lastSeq.current > 0) url.searchParams.set('afterSeq', String(lastSeq.current));

    // `EventSource` rather than fetch + ReadableStream: the browser handles
    // reconnection, backoff and Last-Event-ID, which is most of what makes SSE worth
    // choosing over a WebSocket for a one-directional feed.
    const source = new EventSource(url.toString());

    const onMessage = (raw: MessageEvent<string>): void => {
      try {
        const event = JSON.parse(raw.data) as ExecutionEvent;
        if (event.seq <= lastSeq.current) return;
        lastSeq.current = event.seq;
        setEvents((current) => [...current, event]);
        if (STRUCTURAL.includes(event.type)) scheduleRefresh();
      } catch {
        /* ignore a malformed frame rather than tearing down the stream */
      }
    };

    source.onopen = (): void => {
      setConnected(true);
      // A reconnect may have missed a state change even with the replay; resync once.
      scheduleRefresh();
    };

    source.onerror = (): void => {
      // EventSource retries on its own; surfacing this as a hard error would be
      // misleading during an ordinary reconnect.
      setConnected(false);
    };

    // The server sets a per-type `event:` field, so the default `message` handler does
    // not fire for them — every type has to be registered explicitly.
    source.addEventListener('message', onMessage as EventListener);
    for (const type of [...STRUCTURAL, ...PASSIVE]) {
      source.addEventListener(type, onMessage as EventListener);
    }

    return (): void => {
      source.close();
      setConnected(false);
      if (refetchTimer.current) {
        clearTimeout(refetchTimer.current);
        refetchTimer.current = null;
      }
    };
  }, [runId, terminal, scheduleRefresh]);

  // Safety net: if the stream is silently dead, a slow poll still finishes the run.
  useEffect(() => {
    if (terminal) return;
    const timer = setInterval(refresh, 10_000);
    return (): void => clearInterval(timer);
  }, [terminal, refresh]);

  return { run, events, connected, refresh };
}
