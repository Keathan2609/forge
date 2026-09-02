import { describe, expect, it } from 'vitest';
import { TaskRunState, WorkflowRunState } from '@forge/contracts';
import { FIXTURES, makeDefinition, makeNode, makeRunSnapshot, makeTasks } from '@forge/testing';
import { advanceRun, compileGraph, initialTaskStates } from '../src';

const S = TaskRunState;

describe('initialTaskStates', () => {
  it('marks entry nodes READY and everything else BLOCKED', () => {
    const states = initialTaskStates(compileGraph(FIXTURES.diamond()));
    expect(states.get('root')).toBe(S.READY);
    expect(states.get('left')).toBe(S.BLOCKED);
    expect(states.get('join')).toBe(S.BLOCKED);
  });

  it('marks every node READY when there are no edges', () => {
    const graph = compileGraph(makeDefinition({ nodes: ['a', 'b', 'c'] }));
    const states = initialTaskStates(graph);
    expect([...states.values()]).toEqual([S.READY, S.READY, S.READY]);
  });
});

describe('advanceRun — dispatch', () => {
  it('dispatches READY tasks and moves the run to RUNNING', () => {
    const graph = compileGraph(FIXTURES.linear());
    const run = makeRunSnapshot({ state: WorkflowRunState.PENDING });
    const tasks = makeTasks({ a: S.READY, b: S.BLOCKED, c: S.BLOCKED });

    const plan = advanceRun(graph, run, tasks);

    expect(plan.dispatches.map((d) => d.nodeKey)).toEqual(['a']);
    expect(plan.taskTransitions).toContainEqual(
      expect.objectContaining({ nodeKey: 'a', to: S.QUEUED }),
    );
    expect(plan.runTransition).toEqual(expect.objectContaining({ to: WorkflowRunState.RUNNING }));
  });

  it('does not dispatch a task whose dependency is still running', () => {
    const graph = compileGraph(FIXTURES.linear());
    const run = makeRunSnapshot();
    const plan = advanceRun(graph, run, makeTasks({ a: S.RUNNING, b: S.BLOCKED, c: S.BLOCKED }));
    expect(plan.dispatches).toEqual([]);
  });

  it('carries the queue and handler type into the dispatch', () => {
    const def = makeDefinition({
      nodes: [makeNode('heavy', { queue: 'gpu', type: 'transcode' })],
    });
    const plan = advanceRun(compileGraph(def), makeRunSnapshot(), makeTasks({ heavy: S.READY }));
    expect(plan.dispatches[0]).toMatchObject({ queue: 'gpu', type: 'transcode', attemptNumber: 1 });
  });

  it('is a no-op when nothing has changed', () => {
    const graph = compileGraph(FIXTURES.linear());
    const run = makeRunSnapshot({ state: WorkflowRunState.RUNNING });
    const plan = advanceRun(graph, run, makeTasks({ a: S.RUNNING, b: S.BLOCKED, c: S.BLOCKED }));
    expect(plan.noop).toBe(true);
    expect(plan.taskTransitions).toEqual([]);
  });

  it('produces an identical plan when called twice on the same snapshot', () => {
    const graph = compileGraph(FIXTURES.diamond());
    const run = makeRunSnapshot();
    const tasks = makeTasks({
      root: S.SUCCEEDED,
      left: S.BLOCKED,
      right: S.BLOCKED,
      join: S.BLOCKED,
    });
    const first = advanceRun(graph, run, tasks);
    const second = advanceRun(graph, run, tasks);
    expect(second).toEqual(first);
  });
});

describe('advanceRun — fan-out and fan-in', () => {
  it('dispatches both branches once the root succeeds', () => {
    const graph = compileGraph(FIXTURES.diamond());
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ root: S.SUCCEEDED, left: S.BLOCKED, right: S.BLOCKED, join: S.BLOCKED }),
    );
    expect(plan.dispatches.map((d) => d.nodeKey).sort()).toEqual(['left', 'right']);
    expect(plan.taskTransitions.find((t) => t.nodeKey === 'join')).toBeUndefined();
  });

  it('holds the join until every branch has succeeded', () => {
    const graph = compileGraph(FIXTURES.diamond());
    const partial = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ root: S.SUCCEEDED, left: S.SUCCEEDED, right: S.RUNNING, join: S.BLOCKED }),
    );
    expect(partial.dispatches).toEqual([]);

    const complete = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ root: S.SUCCEEDED, left: S.SUCCEEDED, right: S.SUCCEEDED, join: S.BLOCKED }),
    );
    expect(complete.dispatches.map((d) => d.nodeKey)).toEqual(['join']);
  });

  it('cascades through a whole chain in one pass when everything is satisfied', () => {
    // A single advance resolves skips transitively because nodes are walked in
    // topological order rather than in definition order.
    const def = makeDefinition({
      nodes: [makeNode('a'), makeNode('b', { condition: 'false' }), makeNode('c')],
      edges: ['a->b', 'b->c'],
    });
    const plan = advanceRun(
      compileGraph(def),
      makeRunSnapshot(),
      makeTasks({ a: S.SUCCEEDED, b: S.BLOCKED, c: S.BLOCKED }),
    );
    expect(plan.taskTransitions.find((t) => t.nodeKey === 'b')?.to).toBe(S.SKIPPED);
    // `c`'s only incoming edge originates at a SKIPPED node, so the branch is pruned.
    expect(plan.taskTransitions.find((t) => t.nodeKey === 'c')?.to).toBe(S.SKIPPED);
  });
});

describe('advanceRun — conditions', () => {
  it('skips a node whose condition is false', () => {
    const def = makeDefinition({
      nodes: [makeNode('a'), makeNode('b', { condition: '$.input.premium == true' })],
      edges: ['a->b'],
    });
    const plan = advanceRun(
      compileGraph(def),
      makeRunSnapshot({ input: { premium: false } }),
      makeTasks({ a: S.SUCCEEDED, b: S.BLOCKED }),
    );
    expect(plan.taskTransitions).toContainEqual(
      expect.objectContaining({ nodeKey: 'b', to: S.SKIPPED, reason: 'condition-false' }),
    );
    expect(plan.dispatches).toEqual([]);
  });

  it('runs a node whose condition is true', () => {
    const def = makeDefinition({
      nodes: [makeNode('a'), makeNode('b', { condition: '$.input.premium == true' })],
      edges: ['a->b'],
    });
    const plan = advanceRun(
      compileGraph(def),
      makeRunSnapshot({ input: { premium: true } }),
      makeTasks({ a: S.SUCCEEDED, b: S.BLOCKED }),
    );
    expect(plan.dispatches.map((d) => d.nodeKey)).toEqual(['b']);
  });

  it('reads upstream output in an edge condition', () => {
    const def = makeDefinition({
      nodes: ['check', 'escalate'],
      edges: [{ from: 'check', to: 'escalate', condition: '$.tasks.check.output.risk > 0.8' }],
    });
    const graph = compileGraph(def);

    const lowRisk = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ check: S.SUCCEEDED, escalate: S.BLOCKED }, { check: { output: { risk: 0.2 } } }),
    );
    expect(lowRisk.taskTransitions.find((t) => t.nodeKey === 'escalate')?.to).toBe(S.SKIPPED);

    const highRisk = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ check: S.SUCCEEDED, escalate: S.BLOCKED }, { check: { output: { risk: 0.9 } } }),
    );
    expect(highRisk.dispatches.map((d) => d.nodeKey)).toEqual(['escalate']);
  });

  it('runs a join when at least one incoming edge is taken', () => {
    const def = makeDefinition({
      nodes: ['root', 'left', 'right', 'join'],
      edges: [
        'root->left',
        'root->right',
        { from: 'left', to: 'join', condition: 'false' },
        { from: 'right', to: 'join' },
      ],
    });
    const plan = advanceRun(
      compileGraph(def),
      makeRunSnapshot(),
      makeTasks({ root: S.SUCCEEDED, left: S.SUCCEEDED, right: S.SUCCEEDED, join: S.BLOCKED }),
    );
    expect(plan.dispatches.map((d) => d.nodeKey)).toEqual(['join']);
  });

  it('fails the node when a condition cannot be evaluated', () => {
    const def = makeDefinition({
      nodes: [makeNode('a'), makeNode('b', { condition: "$.input.n > 'text'" })],
      edges: ['a->b'],
    });
    const plan = advanceRun(
      compileGraph(def),
      makeRunSnapshot({ input: { n: 5 } }),
      makeTasks({ a: S.SUCCEEDED, b: S.BLOCKED }),
    );
    const transition = plan.taskTransitions.find((t) => t.nodeKey === 'b');
    expect(transition?.to).toBe(S.FAILED);
    expect(transition?.reason).toBe('condition-error');
  });
});

describe('advanceRun — failure propagation', () => {
  it('cancels downstream tasks when an upstream task fails', () => {
    const graph = compileGraph(FIXTURES.linear());
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks(
        { a: S.FAILED, b: S.BLOCKED, c: S.BLOCKED },
        { a: { error: { code: 'BOOM', message: 'boom' } } },
      ),
    );
    expect(plan.taskTransitions.find((t) => t.nodeKey === 'b')?.to).toBe(S.CANCELLED);
    expect(plan.taskTransitions.find((t) => t.nodeKey === 'c')?.to).toBe(S.CANCELLED);
    expect(plan.runTransition?.to).toBe(WorkflowRunState.FAILED);
    expect(plan.runError).toContain('a');
  });

  it('propagates from a dead-lettered task the same way', () => {
    const graph = compileGraph(FIXTURES.linear());
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks(
        { a: S.DEAD_LETTERED, b: S.BLOCKED, c: S.BLOCKED },
        { a: { error: { code: 'EXHAUSTED', message: 'retries exhausted' } } },
      ),
    );
    expect(plan.runTransition?.to).toBe(WorkflowRunState.FAILED);
  });

  it('lets a healthy parallel branch finish before failing the run', () => {
    const graph = compileGraph(FIXTURES.diamond());
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ root: S.SUCCEEDED, left: S.FAILED, right: S.RUNNING, join: S.BLOCKED }),
    );
    // `join` is poisoned immediately, but the run stays open while `right` is in flight.
    expect(plan.taskTransitions.find((t) => t.nodeKey === 'join')?.to).toBe(S.CANCELLED);
    expect(plan.runTransition).toBeNull();
  });
});

describe('advanceRun — completion', () => {
  it('succeeds when every task succeeded', () => {
    const graph = compileGraph(FIXTURES.linear());
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ a: S.SUCCEEDED, b: S.SUCCEEDED, c: S.SUCCEEDED }),
    );
    expect(plan.runTransition?.to).toBe(WorkflowRunState.SUCCEEDED);
  });

  it('succeeds when the remaining tasks were skipped', () => {
    const graph = compileGraph(FIXTURES.linear());
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ a: S.SUCCEEDED, b: S.SKIPPED, c: S.SKIPPED }),
    );
    expect(plan.runTransition?.to).toBe(WorkflowRunState.SUCCEEDED);
  });

  it('does nothing for an already-terminal run', () => {
    const graph = compileGraph(FIXTURES.linear());
    const plan = advanceRun(
      graph,
      makeRunSnapshot({ state: WorkflowRunState.SUCCEEDED }),
      makeTasks({ a: S.SUCCEEDED, b: S.SUCCEEDED, c: S.SUCCEEDED }),
    );
    expect(plan.noop).toBe(true);
    expect(plan.runTransition).toBeNull();
  });
});

describe('advanceRun — retries', () => {
  it('re-queues a RETRYING task once its backoff has elapsed', () => {
    const graph = compileGraph(FIXTURES.linear());
    const now = new Date('2026-01-01T00:00:10.000Z');
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks(
        { a: S.RETRYING, b: S.BLOCKED, c: S.BLOCKED },
        { a: { attempts: 1, nextAttemptAt: new Date('2026-01-01T00:00:05.000Z') } },
      ),
      { now },
    );
    expect(plan.dispatches).toEqual([expect.objectContaining({ nodeKey: 'a', attemptNumber: 2 })]);
    expect(plan.taskTransitions).toContainEqual(
      expect.objectContaining({ nodeKey: 'a', to: S.QUEUED, reason: 'retry-due' }),
    );
  });

  it('leaves a RETRYING task alone while its backoff is still running', () => {
    const graph = compileGraph(FIXTURES.linear());
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks(
        { a: S.RETRYING, b: S.BLOCKED, c: S.BLOCKED },
        { a: { attempts: 1, nextAttemptAt: new Date('2026-01-01T00:05:00.000Z') } },
      ),
      { now: new Date('2026-01-01T00:00:10.000Z') },
    );
    expect(plan.dispatches).toEqual([]);
  });
});

describe('advanceRun — cancellation', () => {
  it('cancels every non-running task and leaves RUNNING to the worker', () => {
    const graph = compileGraph(FIXTURES.diamond());
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ root: S.SUCCEEDED, left: S.RUNNING, right: S.QUEUED, join: S.BLOCKED }),
      { cancellationRequested: true, cancellationReason: 'operator cancelled' },
    );
    expect(plan.taskTransitions.find((t) => t.nodeKey === 'right')?.to).toBe(S.CANCELLED);
    expect(plan.taskTransitions.find((t) => t.nodeKey === 'join')?.to).toBe(S.CANCELLED);
    expect(plan.taskTransitions.find((t) => t.nodeKey === 'left')).toBeUndefined();
    // The run stays open until the in-flight worker reports back.
    expect(plan.runTransition).toBeNull();
  });

  it('cancels the run once nothing is running', () => {
    const graph = compileGraph(FIXTURES.diamond());
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ root: S.SUCCEEDED, left: S.QUEUED, right: S.QUEUED, join: S.BLOCKED }),
      { cancellationRequested: true },
    );
    expect(plan.runTransition?.to).toBe(WorkflowRunState.CANCELLED);
  });

  it('does not dispatch anything while cancelling', () => {
    const graph = compileGraph(FIXTURES.diamond());
    const plan = advanceRun(
      graph,
      makeRunSnapshot(),
      makeTasks({ root: S.SUCCEEDED, left: S.BLOCKED, right: S.BLOCKED, join: S.BLOCKED }),
      { cancellationRequested: true },
    );
    expect(plan.dispatches).toEqual([]);
  });
});

describe('advanceRun — run timeout', () => {
  it('times the run out once the workflow budget is exceeded', () => {
    const graph = compileGraph(FIXTURES.linear());
    const run = makeRunSnapshot({
      timeoutMs: 1_000,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const plan = advanceRun(graph, run, makeTasks({ a: S.QUEUED, b: S.BLOCKED, c: S.BLOCKED }), {
      now: new Date('2026-01-01T00:00:05.000Z'),
    });
    expect(plan.runTransition?.to).toBe(WorkflowRunState.TIMED_OUT);
    expect(plan.taskTransitions.every((t) => t.to === S.CANCELLED)).toBe(true);
  });

  it('does not time out a run inside its budget', () => {
    const graph = compileGraph(FIXTURES.linear());
    const run = makeRunSnapshot({ timeoutMs: 60_000 });
    const plan = advanceRun(graph, run, makeTasks({ a: S.RUNNING, b: S.BLOCKED, c: S.BLOCKED }), {
      now: new Date('2026-01-01T00:00:05.000Z'),
    });
    expect(plan.runTransition).toBeNull();
  });
});
