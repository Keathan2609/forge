import {
  type TaskAttemptState,
  TaskRunState,
  type WorkflowRunState,
  isTerminalTaskState,
  isTerminalWorkflowState,
} from '@forge/contracts';
import { IllegalTransitionError } from './errors';

/**
 * Explicit state machines for runs, tasks and attempts.
 *
 * Every persisted state change goes through `assertTaskTransition` /
 * `assertWorkflowTransition` before the UPDATE is issued, and every UPDATE additionally
 * carries a `WHERE state = <expected>` guard so two concurrent writers cannot both win.
 * The table below is therefore the single authoritative answer to "can this happen?",
 * and `test/state-machine.test.ts` asserts that terminal states are genuinely absorbing.
 */

type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export const WORKFLOW_TRANSITIONS: TransitionTable<WorkflowRunState> = {
  PENDING: ['QUEUED', 'RUNNING', 'CANCELLED', 'FAILED'],
  // QUEUED exists so a run created inside a transaction is visibly distinct from one
  // whose start signal has actually reached the transport.
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED', 'TIMED_OUT'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

export const TASK_TRANSITIONS: TransitionTable<TaskRunState> = {
  // PENDING/BLOCKED -> QUEUED are compound transitions that pass *through* READY.
  //
  // FORGE decides readiness and writes the dispatch intent in the same transaction, so
  // a task is never observably READY-but-undispatched. Writing an intermediate READY row
  // would cost an extra UPDATE and an extra event to represent a state that exists for
  // microseconds inside one transaction — a state machine that describes a fiction is
  // worse than one that describes what actually happens.
  //
  // READY is still a real, reachable state: entry nodes are created in it, and the
  // dead-letter replay path lands there. It is simply not a resting place on the
  // ordinary dependency-satisfied path.
  // PENDING/BLOCKED -> FAILED covers a condition or input mapping that cannot be
  // evaluated: a definition bug, which fails the node immediately rather than burning
  // its retry budget on an outcome that cannot change.
  PENDING: ['BLOCKED', 'READY', 'QUEUED', 'CANCELLED', 'SKIPPED', 'FAILED'],
  BLOCKED: ['READY', 'QUEUED', 'CANCELLED', 'SKIPPED', 'FAILED'],
  // READY -> RUNNING exists because `CLAIMABLE_TASK_STATES` permits claiming a READY
  // task. That is normally unreachable (the advance queues before dispatching) but a
  // worker must not throw if it ever does receive one.
  READY: ['QUEUED', 'RUNNING', 'CANCELLED', 'SKIPPED'],
  QUEUED: ['RUNNING', 'CANCELLED', 'RETRYING', 'FAILED', 'TIMED_OUT'],
  // RUNNING -> QUEUED is the lease-recovery path: the reaper reclaims an abandoned
  // attempt and makes the task eligible for another worker without burning the budget
  // reserved for genuine application failures.
  // RUNNING -> DEAD_LETTERED is the exhausted-budget path taken by `failTask`.
  RUNNING: ['SUCCEEDED', 'FAILED', 'RETRYING', 'TIMED_OUT', 'CANCELLED', 'QUEUED', 'DEAD_LETTERED'],
  RETRYING: ['QUEUED', 'CANCELLED', 'DEAD_LETTERED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: ['QUEUED'], // operator-initiated replay of a failed node
  CANCELLED: [],
  // A task reaches TIMED_OUT only when an attempt exceeded its budget *and* no retries
  // remain. While retries remain, an expired attempt sends the task to RETRYING
  // instead, so TIMED_OUT is genuinely terminal.
  TIMED_OUT: ['QUEUED'], // operator-initiated replay of a timed-out node
  DEAD_LETTERED: ['QUEUED'], // dead-letter replay
  SKIPPED: [],
};

export const ATTEMPT_TRANSITIONS: TransitionTable<TaskAttemptState> = {
  RUNNING: ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABANDONED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  TIMED_OUT: [],
  ABANDONED: [],
  CANCELLED: [],
};

export function canTransitionWorkflow(from: WorkflowRunState, to: WorkflowRunState): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

export function canTransitionTask(from: TaskRunState, to: TaskRunState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function canTransitionAttempt(from: TaskAttemptState, to: TaskAttemptState): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export function assertWorkflowTransition(from: WorkflowRunState, to: WorkflowRunState): void {
  if (!canTransitionWorkflow(from, to)) {
    throw new IllegalTransitionError('workflowRun', from, to);
  }
}

export function assertTaskTransition(from: TaskRunState, to: TaskRunState): void {
  if (!canTransitionTask(from, to)) {
    throw new IllegalTransitionError('taskRun', from, to);
  }
}

export function assertAttemptTransition(from: TaskAttemptState, to: TaskAttemptState): void {
  if (!canTransitionAttempt(from, to)) {
    throw new IllegalTransitionError('taskAttempt', from, to);
  }
}

/**
 * Terminal states must be absorbing in both directions: nothing leaves them except the
 * two explicit operator-initiated replay edges (FAILED/DEAD_LETTERED -> QUEUED), which
 * are the only way a human can resurrect work.
 */
export const OPERATOR_REPLAY_EDGES: ReadonlyArray<[TaskRunState, TaskRunState]> = [
  [TaskRunState.FAILED, TaskRunState.QUEUED],
  [TaskRunState.TIMED_OUT, TaskRunState.QUEUED],
  [TaskRunState.DEAD_LETTERED, TaskRunState.QUEUED],
];

export function isOperatorReplay(from: TaskRunState, to: TaskRunState): boolean {
  return OPERATOR_REPLAY_EDGES.some(([f, t]) => f === from && t === to);
}

/**
 * Every task transition the runtime actually performs, and who performs it.
 *
 * This list exists because two production bugs slipped through with the same shape: a
 * call site performed a transition the table did not permit, and nothing connected the
 * two. The unit tests for `advanceRun` asserted the *plan*; the unit tests for
 * `TASK_TRANSITIONS` asserted the *table*; neither noticed they disagreed.
 *
 * `state-machine.test.ts` asserts this list is a subset of `TASK_TRANSITIONS`, so adding
 * a transition to the codebase without declaring it here — or declaring one the table
 * forbids — fails the build rather than a live run.
 */
export const RUNTIME_TASK_TRANSITIONS: ReadonlyArray<{
  from: TaskRunState;
  to: TaskRunState;
  performedBy: string;
}> = [
  // --- scheduler: advanceRun ------------------------------------------------
  { from: TaskRunState.PENDING, to: TaskRunState.BLOCKED, performedBy: 'advanceRun' },
  { from: TaskRunState.PENDING, to: TaskRunState.QUEUED, performedBy: 'advanceRun' },
  { from: TaskRunState.BLOCKED, to: TaskRunState.QUEUED, performedBy: 'advanceRun' },
  { from: TaskRunState.READY, to: TaskRunState.QUEUED, performedBy: 'advanceRun' },
  { from: TaskRunState.RETRYING, to: TaskRunState.QUEUED, performedBy: 'advanceRun (retry due)' },
  { from: TaskRunState.PENDING, to: TaskRunState.SKIPPED, performedBy: 'advanceRun (condition)' },
  { from: TaskRunState.BLOCKED, to: TaskRunState.SKIPPED, performedBy: 'advanceRun (condition)' },
  { from: TaskRunState.PENDING, to: TaskRunState.CANCELLED, performedBy: 'advanceRun' },
  { from: TaskRunState.BLOCKED, to: TaskRunState.CANCELLED, performedBy: 'advanceRun' },
  { from: TaskRunState.READY, to: TaskRunState.CANCELLED, performedBy: 'advanceRun' },
  { from: TaskRunState.QUEUED, to: TaskRunState.CANCELLED, performedBy: 'advanceRun' },
  { from: TaskRunState.RETRYING, to: TaskRunState.CANCELLED, performedBy: 'advanceRun' },
  {
    from: TaskRunState.BLOCKED,
    to: TaskRunState.FAILED,
    performedBy: 'advanceRun (bad condition)',
  },
  {
    from: TaskRunState.PENDING,
    to: TaskRunState.FAILED,
    performedBy: 'advanceRun (bad condition)',
  },
  {
    from: TaskRunState.QUEUED,
    to: TaskRunState.FAILED,
    performedBy: 'applyPlan (input resolution)',
  },

  // --- worker: claimTask ----------------------------------------------------
  { from: TaskRunState.QUEUED, to: TaskRunState.RUNNING, performedBy: 'claimTask' },
  { from: TaskRunState.READY, to: TaskRunState.RUNNING, performedBy: 'claimTask' },

  // --- worker: completeTask / failTask --------------------------------------
  { from: TaskRunState.RUNNING, to: TaskRunState.SUCCEEDED, performedBy: 'completeTask' },
  { from: TaskRunState.RUNNING, to: TaskRunState.RETRYING, performedBy: 'failTask (retry)' },
  { from: TaskRunState.RUNNING, to: TaskRunState.FAILED, performedBy: 'failTask (non-retryable)' },
  {
    from: TaskRunState.RUNNING,
    to: TaskRunState.DEAD_LETTERED,
    performedBy: 'failTask (budget exhausted)',
  },
  {
    from: TaskRunState.RUNNING,
    to: TaskRunState.TIMED_OUT,
    performedBy: 'failTask (timeout, no budget)',
  },

  // --- control plane: reclaimExpiredLeases ----------------------------------
  { from: TaskRunState.RUNNING, to: TaskRunState.QUEUED, performedBy: 'reclaimExpiredLeases' },

  // --- operator: dead-letter replay -----------------------------------------
  { from: TaskRunState.DEAD_LETTERED, to: TaskRunState.QUEUED, performedBy: 'retryDeadLetter' },
  { from: TaskRunState.FAILED, to: TaskRunState.QUEUED, performedBy: 'retryDeadLetter' },
  { from: TaskRunState.TIMED_OUT, to: TaskRunState.QUEUED, performedBy: 'retryDeadLetter' },
];

/** Which states may legally claim a lease and begin an attempt. */
export const CLAIMABLE_TASK_STATES: readonly TaskRunState[] = [
  TaskRunState.QUEUED,
  TaskRunState.READY,
];

export function isClaimable(state: TaskRunState): boolean {
  return CLAIMABLE_TASK_STATES.includes(state);
}

export { isTerminalTaskState, isTerminalWorkflowState };
