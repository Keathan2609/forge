/**
 * Execution state vocabulary.
 *
 * These are the only states FORGE recognises. They are duplicated (deliberately)
 * as Prisma enums in `@forge/database` — the two are kept in sync by
 * `packages/database/test/enum-parity.test.ts`, which fails the build if they drift.
 */

export const WorkflowRunState = {
  PENDING: 'PENDING',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
} as const;
export type WorkflowRunState = (typeof WorkflowRunState)[keyof typeof WorkflowRunState];

export const TaskRunState = {
  /** Created, dependencies not yet evaluated. */
  PENDING: 'PENDING',
  /** At least one dependency is unresolved. */
  BLOCKED: 'BLOCKED',
  /** All dependencies satisfied; awaiting dispatch. */
  READY: 'READY',
  /** Handed to the transport; a worker may or may not have seen it yet. */
  QUEUED: 'QUEUED',
  /** A worker holds a live lease and is executing an attempt. */
  RUNNING: 'RUNNING',
  /** Attempt failed, backoff timer running, will be re-queued. */
  RETRYING: 'RETRYING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
  /** Retry budget exhausted; parked for human intervention. */
  DEAD_LETTERED: 'DEAD_LETTERED',
  /** Condition evaluated false — the node did not run, but did not fail. */
  SKIPPED: 'SKIPPED',
} as const;
export type TaskRunState = (typeof TaskRunState)[keyof typeof TaskRunState];

export const TaskAttemptState = {
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  /** The lease expired and the attempt was reclaimed by the reaper. */
  ABANDONED: 'ABANDONED',
  CANCELLED: 'CANCELLED',
} as const;
export type TaskAttemptState = (typeof TaskAttemptState)[keyof typeof TaskAttemptState];

export const WorkerState = {
  ONLINE: 'ONLINE',
  DRAINING: 'DRAINING',
  OFFLINE: 'OFFLINE',
  /** Heartbeat older than the liveness window. */
  UNRESPONSIVE: 'UNRESPONSIVE',
} as const;
export type WorkerState = (typeof WorkerState)[keyof typeof WorkerState];

export const OutboxStatus = {
  PENDING: 'PENDING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

export const DeadLetterStatus = {
  OPEN: 'OPEN',
  REPLAYED: 'REPLAYED',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
} as const;
export type DeadLetterStatus = (typeof DeadLetterStatus)[keyof typeof DeadLetterStatus];

/** States from which no further transition is legal. */
export const TERMINAL_WORKFLOW_STATES: readonly WorkflowRunState[] = [
  WorkflowRunState.SUCCEEDED,
  WorkflowRunState.FAILED,
  WorkflowRunState.CANCELLED,
  WorkflowRunState.TIMED_OUT,
];

export const TERMINAL_TASK_STATES: readonly TaskRunState[] = [
  TaskRunState.SUCCEEDED,
  TaskRunState.FAILED,
  TaskRunState.CANCELLED,
  TaskRunState.TIMED_OUT,
  TaskRunState.DEAD_LETTERED,
  TaskRunState.SKIPPED,
];

/** Task states that mean "a worker could currently be touching this row". */
export const ACTIVE_TASK_STATES: readonly TaskRunState[] = [
  TaskRunState.QUEUED,
  TaskRunState.RUNNING,
  TaskRunState.RETRYING,
];

export function isTerminalWorkflowState(s: WorkflowRunState): boolean {
  return TERMINAL_WORKFLOW_STATES.includes(s);
}

export function isTerminalTaskState(s: TaskRunState): boolean {
  return TERMINAL_TASK_STATES.includes(s);
}

/** A dependency is satisfied by SUCCEEDED, and (for branch pruning) by SKIPPED. */
export function isDependencySatisfied(s: TaskRunState): boolean {
  return s === TaskRunState.SUCCEEDED || s === TaskRunState.SKIPPED;
}

/** A dependency can never become satisfied from these states. */
export function isDependencyPermanentlyUnsatisfiable(s: TaskRunState): boolean {
  return (
    s === TaskRunState.FAILED ||
    s === TaskRunState.CANCELLED ||
    s === TaskRunState.TIMED_OUT ||
    s === TaskRunState.DEAD_LETTERED
  );
}
