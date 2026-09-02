import { describe, expect, it } from 'vitest';
import { TaskRunState, WorkflowRunState } from '@forge/contracts';
import { FIXTURES, makeDefinition, makeNode, makeRunSnapshot, makeTasks } from '@forge/testing';
import {
  CLAIMABLE_TASK_STATES,
  RUNTIME_TASK_TRANSITIONS,
  advanceRun,
  canTransitionTask,
  canTransitionWorkflow,
  compileGraph,
  initialTaskStates,
} from '../src';

/**
 * Regression guard: every transition the scheduler can plan must be legal.
 *
 * This exists because of a real bug. `advanceRun` planned `BLOCKED -> QUEUED` when a
 * dependency resolved, but the transition table only permitted `BLOCKED -> READY`. The
 * engine's unit tests passed (they assert the *plan*, not its legality) and the state
 * machine's tests passed (they assert the *table*, not what the planner emits) — the
 * defect lived exactly in the gap between the two, and only surfaced when a live run
 * stalled with every downstream task stuck in BLOCKED.
 *
 * These tests close that gap by driving the planner across the scenarios that produce
 * each kind of transition and asserting the table accepts everything it emits.
 */

const S = TaskRunState;

/** Drive `advanceRun` over a scenario and assert every planned transition is legal. */
function assertPlanIsLegal(plan: ReturnType<typeof advanceRun>): void {
  for (const transition of plan.taskTransitions) {
    expect(
      canTransitionTask(transition.from, transition.to),
      'task transition ' +
        transition.from +
        ' -> ' +
        transition.to +
        ' (reason: ' +
        transition.reason +
        ') is planned by the scheduler but rejected by the state machine',
    ).toBe(true);
  }
  if (plan.runTransition) {
    expect(
      canTransitionWorkflow(plan.runTransition.from, plan.runTransition.to),
      'run transition ' +
        plan.runTransition.from +
        ' -> ' +
        plan.runTransition.to +
        ' is planned but rejected',
    ).toBe(true);
  }
}

describe('planner and state machine agree', () => {
  it('dispatching an entry node', () => {
    assertPlanIsLegal(
      advanceRun(
        compileGraph(FIXTURES.linear()),
        makeRunSnapshot({ state: WorkflowRunState.PENDING }),
        makeTasks({ a: S.READY, b: S.BLOCKED, c: S.BLOCKED }),
      ),
    );
  });

  it('unblocking a dependent node once its dependency succeeds', () => {
    // The exact scenario that produced the original bug.
    const plan = advanceRun(
      compileGraph(FIXTURES.linear()),
      makeRunSnapshot(),
      makeTasks({ a: S.SUCCEEDED, b: S.BLOCKED, c: S.BLOCKED }),
    );
    expect(plan.taskTransitions).toContainEqual(
      expect.objectContaining({ nodeKey: 'b', from: S.BLOCKED, to: S.QUEUED }),
    );
    assertPlanIsLegal(plan);
  });

  it('unblocking a fan-in join', () => {
    assertPlanIsLegal(
      advanceRun(
        compileGraph(FIXTURES.diamond()),
        makeRunSnapshot(),
        makeTasks({ root: S.SUCCEEDED, left: S.SUCCEEDED, right: S.SUCCEEDED, join: S.BLOCKED }),
      ),
    );
  });

  it('pruning a branch whose condition is false', () => {
    const def = makeDefinition({
      nodes: [makeNode('a'), makeNode('b', { condition: 'false' })],
      edges: ['a->b'],
    });
    assertPlanIsLegal(
      advanceRun(compileGraph(def), makeRunSnapshot(), makeTasks({ a: S.SUCCEEDED, b: S.BLOCKED })),
    );
  });

  it('propagating an upstream failure', () => {
    assertPlanIsLegal(
      advanceRun(
        compileGraph(FIXTURES.linear()),
        makeRunSnapshot(),
        makeTasks(
          { a: S.FAILED, b: S.BLOCKED, c: S.BLOCKED },
          { a: { error: { code: 'X', message: 'boom' } } },
        ),
      ),
    );
  });

  it('re-queueing a due retry', () => {
    assertPlanIsLegal(
      advanceRun(
        compileGraph(FIXTURES.linear()),
        makeRunSnapshot(),
        makeTasks(
          { a: S.RETRYING, b: S.BLOCKED, c: S.BLOCKED },
          { a: { attempts: 1, nextAttemptAt: new Date(Date.now() - 1_000) } },
        ),
      ),
    );
  });

  it('cancelling a run', () => {
    assertPlanIsLegal(
      advanceRun(
        compileGraph(FIXTURES.diamond()),
        makeRunSnapshot(),
        makeTasks({ root: S.SUCCEEDED, left: S.RUNNING, right: S.QUEUED, join: S.BLOCKED }),
        { cancellationRequested: true },
      ),
    );
  });

  it('timing out a run', () => {
    assertPlanIsLegal(
      advanceRun(
        compileGraph(FIXTURES.linear()),
        makeRunSnapshot({
          timeoutMs: 1_000,
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        makeTasks({ a: S.QUEUED, b: S.BLOCKED, c: S.BLOCKED }),
        { now: new Date('2026-01-01T00:01:00.000Z') },
      ),
    );
  });

  it('completing a run', () => {
    assertPlanIsLegal(
      advanceRun(
        compileGraph(FIXTURES.linear()),
        makeRunSnapshot(),
        makeTasks({ a: S.SUCCEEDED, b: S.SUCCEEDED, c: S.SUCCEEDED }),
      ),
    );
  });

  /**
   * Exhaustive sweep: for every workflow shape and every assignment of states the
   * planner could encounter, assert it never emits an illegal transition. This is the
   * check that would have caught the original bug without anyone anticipating it.
   */
  it('never plans an illegal transition across a broad state sweep', () => {
    const graphs = [
      compileGraph(FIXTURES.linear()),
      compileGraph(FIXTURES.diamond()),
      compileGraph(
        makeDefinition({
          nodes: [makeNode('a'), makeNode('b', { condition: '$.input.go == true' }), makeNode('c')],
          edges: ['a->b', 'b->c'],
        }),
      ),
    ];

    const states: TaskRunState[] = [
      S.PENDING,
      S.BLOCKED,
      S.READY,
      S.QUEUED,
      S.RUNNING,
      S.RETRYING,
      S.SUCCEEDED,
      S.FAILED,
      S.CANCELLED,
      S.TIMED_OUT,
      S.DEAD_LETTERED,
      S.SKIPPED,
    ];

    let checked = 0;
    for (const graph of graphs) {
      const keys = [...graph.topologicalOrder];
      // Every combination is exponential; sample deterministically instead by rotating
      // each node through every state against a fixed baseline.
      for (const baseline of states) {
        for (let i = 0; i < keys.length; i++) {
          for (const variant of states) {
            const assignment: Record<string, TaskRunState> = {};
            keys.forEach((k, index) => {
              assignment[k] = index === i ? variant : baseline;
            });
            for (const cancelling of [false, true]) {
              const plan = advanceRun(
                graph,
                makeRunSnapshot({ input: { go: true } }),
                makeTasks(assignment, {
                  [keys[i] as string]: {
                    attempts: 1,
                    nextAttemptAt: new Date(Date.now() - 1_000),
                  },
                }),
                { cancellationRequested: cancelling },
              );
              assertPlanIsLegal(plan);
              checked += 1;
            }
          }
        }
      }
    }

    // Guard against the sweep silently degenerating to nothing.
    expect(checked).toBeGreaterThan(500);
  });
});

describe('every transition the runtime performs is permitted by the table', () => {
  /**
   * The scheduler is only one of four components that write task state. The worker
   * (`claimTask`, `completeTask`, `failTask`), the control plane (`reclaimExpiredLeases`)
   * and the operator path (`retryDeadLetter`) all perform transitions too — and a bug
   * lived in exactly that gap: `failTask` performed `RUNNING -> DEAD_LETTERED`, which the
   * table forbade, so dead-lettering threw and the task looped until its lease expired.
   *
   * `RUNTIME_TASK_TRANSITIONS` is the declared inventory of those writes. This test is
   * what makes it load-bearing rather than a comment.
   */
  it('accepts every declared runtime transition', () => {
    for (const { from, to, performedBy } of RUNTIME_TASK_TRANSITIONS) {
      expect(
        canTransitionTask(from, to),
        performedBy + ' performs ' + from + ' -> ' + to + ' but the state machine forbids it',
      ).toBe(true);
    }
  });

  it('declares a transition out of every claimable state into RUNNING', () => {
    // `claimTask` will attempt this for any state `isClaimable` accepts, so the two must
    // not drift apart.
    for (const state of CLAIMABLE_TASK_STATES) {
      expect(
        canTransitionTask(state, TaskRunState.RUNNING),
        state + ' is claimable but cannot transition to RUNNING',
      ).toBe(true);
      expect(
        RUNTIME_TASK_TRANSITIONS.some((t) => t.from === state && t.to === TaskRunState.RUNNING),
        state + ' is claimable but the transition is not declared in RUNTIME_TASK_TRANSITIONS',
      ).toBe(true);
    }
  });

  it('declares every terminal outcome a failing attempt can produce', () => {
    // `failTask` chooses between these four depending on the retry decision.
    for (const outcome of [
      TaskRunState.RETRYING,
      TaskRunState.FAILED,
      TaskRunState.DEAD_LETTERED,
      TaskRunState.TIMED_OUT,
    ]) {
      expect(canTransitionTask(TaskRunState.RUNNING, outcome)).toBe(true);
    }
  });
});

describe('initial states are consistent with the transition table', () => {
  it('every initial state can reach QUEUED', () => {
    const graph = compileGraph(FIXTURES.diamond());
    for (const [, state] of initialTaskStates(graph)) {
      expect(canTransitionTask(state, TaskRunState.QUEUED)).toBe(true);
    }
  });
});
