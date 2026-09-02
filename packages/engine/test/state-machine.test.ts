import { describe, expect, it } from 'vitest';
import {
  TERMINAL_TASK_STATES,
  TERMINAL_WORKFLOW_STATES,
  TaskAttemptState,
  TaskRunState,
  WorkflowRunState,
} from '@forge/contracts';
import {
  ATTEMPT_TRANSITIONS,
  IllegalTransitionError,
  TASK_TRANSITIONS,
  WORKFLOW_TRANSITIONS,
  assertTaskTransition,
  assertWorkflowTransition,
  canTransitionAttempt,
  canTransitionTask,
  isClaimable,
  isOperatorReplay,
} from '../src';

describe('workflow run transitions', () => {
  it('allows the happy path', () => {
    expect(() =>
      assertWorkflowTransition(WorkflowRunState.PENDING, WorkflowRunState.RUNNING),
    ).not.toThrow();
    expect(() =>
      assertWorkflowTransition(WorkflowRunState.RUNNING, WorkflowRunState.SUCCEEDED),
    ).not.toThrow();
  });

  it('rejects resurrection from a terminal state', () => {
    for (const terminal of TERMINAL_WORKFLOW_STATES) {
      expect(WORKFLOW_TRANSITIONS[terminal]).toEqual([]);
      expect(() => assertWorkflowTransition(terminal, WorkflowRunState.RUNNING)).toThrow(
        IllegalTransitionError,
      );
    }
  });

  it('rejects skipping straight from PENDING to SUCCEEDED', () => {
    expect(() =>
      assertWorkflowTransition(WorkflowRunState.PENDING, WorkflowRunState.SUCCEEDED),
    ).toThrow(IllegalTransitionError);
  });

  it('carries the entity and both states on the error', () => {
    try {
      assertWorkflowTransition(WorkflowRunState.SUCCEEDED, WorkflowRunState.FAILED);
    } catch (err) {
      const e = err as IllegalTransitionError;
      expect(e.entity).toBe('workflowRun');
      expect(e.from).toBe('SUCCEEDED');
      expect(e.to).toBe('FAILED');
      expect(e.code).toBe('ILLEGAL_TRANSITION');
    }
  });
});

describe('task run transitions', () => {
  it('allows the full happy path', () => {
    const path: TaskRunState[] = [
      TaskRunState.PENDING,
      TaskRunState.BLOCKED,
      TaskRunState.READY,
      TaskRunState.QUEUED,
      TaskRunState.RUNNING,
      TaskRunState.SUCCEEDED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(() =>
        assertTaskTransition(path[i] as TaskRunState, path[i + 1] as TaskRunState),
      ).not.toThrow();
    }
  });

  it('allows the retry loop', () => {
    expect(canTransitionTask(TaskRunState.RUNNING, TaskRunState.RETRYING)).toBe(true);
    expect(canTransitionTask(TaskRunState.RETRYING, TaskRunState.QUEUED)).toBe(true);
    expect(canTransitionTask(TaskRunState.RETRYING, TaskRunState.DEAD_LETTERED)).toBe(true);
  });

  it('allows lease recovery: RUNNING back to QUEUED', () => {
    // This is what the reaper does when a worker dies mid-attempt.
    expect(canTransitionTask(TaskRunState.RUNNING, TaskRunState.QUEUED)).toBe(true);
  });

  it('makes terminal states absorbing except for operator replay', () => {
    for (const terminal of TERMINAL_TASK_STATES) {
      const allowed = TASK_TRANSITIONS[terminal];
      for (const to of allowed) {
        expect(isOperatorReplay(terminal, to)).toBe(true);
      }
    }
  });

  it('permits dead-letter replay but not arbitrary resurrection', () => {
    expect(canTransitionTask(TaskRunState.DEAD_LETTERED, TaskRunState.QUEUED)).toBe(true);
    expect(canTransitionTask(TaskRunState.DEAD_LETTERED, TaskRunState.RUNNING)).toBe(false);
    expect(canTransitionTask(TaskRunState.SUCCEEDED, TaskRunState.QUEUED)).toBe(false);
    expect(canTransitionTask(TaskRunState.CANCELLED, TaskRunState.QUEUED)).toBe(false);
  });

  it('rejects jumping from BLOCKED straight to RUNNING', () => {
    expect(() => assertTaskTransition(TaskRunState.BLOCKED, TaskRunState.RUNNING)).toThrow(
      IllegalTransitionError,
    );
  });

  it('rejects re-succeeding an already succeeded task', () => {
    expect(() => assertTaskTransition(TaskRunState.SUCCEEDED, TaskRunState.SUCCEEDED)).toThrow(
      IllegalTransitionError,
    );
  });

  it('identifies claimable states', () => {
    expect(isClaimable(TaskRunState.QUEUED)).toBe(true);
    expect(isClaimable(TaskRunState.READY)).toBe(true);
    expect(isClaimable(TaskRunState.RUNNING)).toBe(false);
    expect(isClaimable(TaskRunState.SUCCEEDED)).toBe(false);
  });
});

describe('attempt transitions', () => {
  it('only leaves RUNNING', () => {
    for (const [from, allowed] of Object.entries(ATTEMPT_TRANSITIONS)) {
      if (from === TaskAttemptState.RUNNING) {
        expect(allowed.length).toBeGreaterThan(0);
      } else {
        expect(allowed).toEqual([]);
      }
    }
  });

  it('allows abandonment when a lease expires', () => {
    expect(canTransitionAttempt(TaskAttemptState.RUNNING, TaskAttemptState.ABANDONED)).toBe(true);
  });

  it('rejects reviving a finished attempt', () => {
    expect(canTransitionAttempt(TaskAttemptState.SUCCEEDED, TaskAttemptState.RUNNING)).toBe(false);
    expect(canTransitionAttempt(TaskAttemptState.ABANDONED, TaskAttemptState.SUCCEEDED)).toBe(
      false,
    );
  });
});

describe('table completeness', () => {
  it('defines a transition list for every task state', () => {
    for (const state of Object.values(TaskRunState)) {
      expect(TASK_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('defines a transition list for every workflow state', () => {
    for (const state of Object.values(WorkflowRunState)) {
      expect(WORKFLOW_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('never lists a state as a transition target of itself', () => {
    for (const [from, targets] of Object.entries(TASK_TRANSITIONS)) {
      expect(targets).not.toContain(from);
    }
  });
});
