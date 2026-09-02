/**
 * Append-only execution event vocabulary.
 *
 * Every event is persisted to `ExecutionEvent` with a per-run monotonic sequence
 * number, then fanned out to subscribers over Redis pub/sub → SSE. The database
 * table is the record of truth; the pub/sub fan-out is a best-effort accelerator.
 */

export const ExecutionEventType = {
  WORKFLOW_CREATED: 'WORKFLOW_CREATED',
  WORKFLOW_STARTED: 'WORKFLOW_STARTED',
  WORKFLOW_COMPLETED: 'WORKFLOW_COMPLETED',
  WORKFLOW_FAILED: 'WORKFLOW_FAILED',
  WORKFLOW_CANCELLED: 'WORKFLOW_CANCELLED',
  WORKFLOW_TIMED_OUT: 'WORKFLOW_TIMED_OUT',

  TASK_BLOCKED: 'TASK_BLOCKED',
  TASK_READY: 'TASK_READY',
  TASK_QUEUED: 'TASK_QUEUED',
  TASK_STARTED: 'TASK_STARTED',
  TASK_HEARTBEAT: 'TASK_HEARTBEAT',
  TASK_PROGRESS: 'TASK_PROGRESS',
  TASK_COMPLETED: 'TASK_COMPLETED',
  TASK_FAILED: 'TASK_FAILED',
  TASK_RETRY_SCHEDULED: 'TASK_RETRY_SCHEDULED',
  TASK_TIMED_OUT: 'TASK_TIMED_OUT',
  TASK_CANCELLED: 'TASK_CANCELLED',
  TASK_SKIPPED: 'TASK_SKIPPED',
  TASK_RECOVERED: 'TASK_RECOVERED',
  TASK_DEAD_LETTERED: 'TASK_DEAD_LETTERED',

  LEASE_ACQUIRED: 'LEASE_ACQUIRED',
  LEASE_RENEWED: 'LEASE_RENEWED',
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  LEASE_RELEASED: 'LEASE_RELEASED',

  WORKER_REGISTERED: 'WORKER_REGISTERED',
  WORKER_OFFLINE: 'WORKER_OFFLINE',

  DEAD_LETTER_REPLAYED: 'DEAD_LETTER_REPLAYED',
  DEAD_LETTER_ACKNOWLEDGED: 'DEAD_LETTER_ACKNOWLEDGED',
} as const;
export type ExecutionEventType = (typeof ExecutionEventType)[keyof typeof ExecutionEventType];

export interface ExecutionEvent {
  id: string;
  /** Monotonic per workflow run. Lets a reconnecting client resume without gaps. */
  seq: number;
  type: ExecutionEventType;
  workflowRunId: string;
  taskRunId: string | null;
  /** Stable node key from the workflow definition (e.g. `charge-payment`). */
  nodeKey: string | null;
  workerId: string | null;
  attemptNumber: number | null;
  traceId: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
}

/** Redis pub/sub channels. */
export const CHANNELS = {
  /** Every execution event, for the global console feed. */
  eventsAll: 'forge:events:all',
  /** Per-run channel so a run page does not receive unrelated traffic. */
  eventsForRun: (workflowRunId: string) => `forge:events:run:${workflowRunId}`,
  /** Fleet-level changes (worker registration, heartbeat state changes). */
  fleet: 'forge:events:fleet',
} as const;

/** Redis list keys used as work queues. Redis is transport, never state. */
export const QUEUES = {
  /** Task dispatch, partitioned by logical queue name from the definition. */
  taskDispatch: (queue: string) => `forge:q:tasks:${queue}`,
  /** "This run may have new ready work" trigger. Coalesced by the control plane. */
  runAdvance: 'forge:q:run-advance',
  /** Outbox publisher hand-off failures land here for inspection. */
  outboxDlq: 'forge:q:outbox-dlq',
} as const;

/** Redis keys used for coordination (not durable state). */
export const KEYS = {
  runAdvanceLock: (runId: string) => `forge:lock:advance:${runId}`,
  outboxPublisherLock: 'forge:lock:outbox-publisher',
  queueDepthSample: 'forge:metrics:queue-depth',
  cancelFlag: (runId: string) => `forge:cancel:${runId}`,
} as const;
