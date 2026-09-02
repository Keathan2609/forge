import type { WorkflowDefinition } from './workflow';
import type {
  DeadLetterStatus,
  TaskAttemptState,
  TaskRunState,
  WorkerState,
  WorkflowRunState,
} from './states';

/**
 * Read models returned by the API.
 *
 * These are deliberately flat and denormalised: the console renders them directly,
 * and keeping the shape stable means the API can change its storage layout without
 * breaking the SDK, CLI or web client.
 */

export interface WorkflowSummaryView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  latestVersion: number;
  versionCount: number;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
  stats: {
    total: number;
    running: number;
    succeeded: number;
    failed: number;
    /** succeeded / (succeeded + failed), or null when nothing has finished. */
    successRate: number | null;
    p50DurationMs: number | null;
  };
}

export interface WorkflowVersionView {
  id: string;
  version: number;
  changelog: string | null;
  definition: WorkflowDefinition;
  createdAt: string;
  /** Content hash of the canonicalised definition — identical definitions reuse a version. */
  checksum: string;
}

export interface TaskAttemptView {
  id: string;
  attemptNumber: number;
  state: TaskAttemptState;
  workerId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Truncated in list responses; full body available on the attempt endpoint. */
  errorStack: string | null;
  output: unknown;
  traceId: string | null;
}

export interface TaskRunView {
  id: string;
  nodeKey: string;
  name: string;
  type: string;
  queue: string;
  state: TaskRunState;
  attempts: number;
  maxAttempts: number;
  dependsOn: string[];
  input: unknown;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  timeoutMs: number;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  workerId: string | null;
  traceId: string | null;
  lease: {
    workerId: string;
    acquiredAt: string;
    expiresAt: string;
    heartbeatAt: string;
    attemptNumber: number;
  } | null;
}

export interface WorkflowRunView {
  id: string;
  workflowKey: string;
  workflowName: string;
  version: number;
  state: WorkflowRunState;
  input: unknown;
  output: unknown;
  errorMessage: string | null;
  triggeredBy: string;
  idempotencyKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  traceId: string | null;
  /** Present on the detail endpoint only. */
  definition?: WorkflowDefinition;
  tasks?: TaskRunView[];
  counts: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    retrying: number;
    deadLettered: number;
    skipped: number;
  };
}

export interface WorkerView {
  id: string;
  name: string;
  hostname: string;
  pid: number;
  state: WorkerState;
  version: string;
  queues: string[];
  capabilities: string[];
  concurrency: number;
  activeTasks: number;
  tasksCompleted: number;
  tasksFailed: number;
  lastHeartbeatAt: string;
  /** Seconds since registration — computed by the API, not stored. */
  uptimeSeconds: number;
  registeredAt: string;
  currentTasks: Array<{
    taskRunId: string;
    nodeKey: string;
    workflowRunId: string;
    startedAt: string;
  }>;
}

export interface DeadLetterView {
  id: string;
  status: DeadLetterStatus;
  workflowRunId: string;
  workflowKey: string;
  taskRunId: string;
  nodeKey: string;
  type: string;
  attempts: number;
  errorCode: string | null;
  errorMessage: string;
  input: unknown;
  lastOutput: unknown;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  attemptHistory: TaskAttemptView[];
}

export interface ScheduleView {
  id: string;
  name: string;
  workflowKey: string;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  enabled: boolean;
  input: unknown;
  lastRunAt: string | null;
  lastRunId: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface SystemStatusView {
  status: 'healthy' | 'degraded';
  checkedAt: string;
  components: {
    database: { ok: boolean; latencyMs: number | null; message?: string };
    redis: { ok: boolean; latencyMs: number | null; message?: string };
    workers: { ok: boolean; online: number; unresponsive: number };
    outbox: { ok: boolean; pending: number; oldestPendingAgeMs: number | null };
  };
  version: string;
}

export interface DashboardStatsView {
  runs: {
    active: number;
    queuedTasks: number;
    runningTasks: number;
    last24h: { total: number; succeeded: number; failed: number; cancelled: number };
    successRate: number | null;
  };
  workers: { online: number; unresponsive: number; totalCapacity: number; activeTasks: number };
  deadLetters: { open: number };
  outbox: { pending: number; failed: number };
  /** Hourly buckets for the last 24 hours, oldest first. */
  throughput: Array<{ bucket: string; started: number; succeeded: number; failed: number }>;
  recentRuns: WorkflowRunView[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Execution snapshots.
 *
 * The input the scheduler reasons over: a run and its tasks as they exist right now.
 * They live in `contracts` rather than in the engine because they are pure data shapes
 * mirroring database rows — and because putting them here is what lets `@forge/testing`
 * build fixtures without depending on the engine, which would otherwise be a cycle
 * (the engine's own tests use those fixtures).
 */
export interface TaskSnapshot {
  nodeKey: string;
  state: TaskRunState;
  output: unknown;
  attempts: number;
  error: { code: string | null; message: string } | null;
  /** Set while RETRYING; the task becomes dispatchable once this time passes. */
  nextAttemptAt: Date | null;
}

export interface RunSnapshot {
  id: string;
  workflowKey: string;
  version: number;
  state: WorkflowRunState;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  startedAt: Date | null;
  createdAt: Date;
  /** From the definition; the control plane fails the run when this elapses. */
  timeoutMs: number;
}
