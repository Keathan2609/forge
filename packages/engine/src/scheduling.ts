import {
  TaskRunState,
  WorkflowRunState,
  type RunSnapshot,
  type TaskSnapshot,
  isDependencyPermanentlyUnsatisfiable,
  isDependencySatisfied,
  isTerminalTaskState,
} from '@forge/contracts';
import type { CompiledGraph } from './graph';
import { buildContext, type ExecutionContext } from './context';
import { evaluateCondition } from './expression';

// Re-exported so consumers keep importing the scheduler's input types from the engine,
// which is where they are conceptually used even though they are declared in contracts.
export type { RunSnapshot, TaskSnapshot };

/**
 * The scheduler: given a snapshot of a run, decide what should happen next.
 *
 * This is the single most important pure function in FORGE. The control plane loads a
 * run and its tasks inside a transaction (with the run row locked), calls `advanceRun`,
 * and applies the returned plan. Because the function has no I/O, the entire
 * orchestration policy — fan-out, fan-in, conditional pruning, failure propagation,
 * completion detection — is testable without a database, a queue or a clock.
 *
 * It is also *idempotent by construction*: calling it twice on the same snapshot
 * produces the same plan, and applying a plan to an already-advanced run yields an
 * empty plan. That property is what makes duplicate `run.advance` messages harmless.
 */

export type TransitionReason =
  | 'dependencies-satisfied'
  | 'dependencies-pending'
  | 'condition-false'
  | 'branch-not-taken'
  | 'upstream-failed'
  | 'retry-due'
  | 'dispatch'
  | 'cancellation-requested'
  | 'run-timeout'
  | 'all-tasks-complete'
  | 'task-failed'
  | 'condition-error';

export interface PlannedTaskTransition {
  nodeKey: string;
  from: TaskRunState;
  to: TaskRunState;
  reason: TransitionReason;
  /** Populated for transitions that carry an explanation into the event log. */
  message?: string;
}

export interface PlannedDispatch {
  nodeKey: string;
  queue: string;
  type: string;
  /** The attempt number this dispatch is for. */
  attemptNumber: number;
}

export interface AdvancePlan {
  taskTransitions: PlannedTaskTransition[];
  dispatches: PlannedDispatch[];
  runTransition: { from: WorkflowRunState; to: WorkflowRunState; reason: TransitionReason } | null;
  /** Present when the run reaches SUCCEEDED and the definition declares an output mapping. */
  runOutput: Record<string, unknown> | null;
  runError: string | null;
  /** True when nothing changed — the caller can skip the write entirely. */
  noop: boolean;
}

export interface AdvanceOptions {
  now?: Date;
  /** Set when an operator has requested cancellation; drains all non-terminal tasks. */
  cancellationRequested?: boolean;
  cancellationReason?: string;
}

const EMPTY_PLAN: AdvancePlan = {
  taskTransitions: [],
  dispatches: [],
  runTransition: null,
  runOutput: null,
  runError: null,
  noop: true,
};

/** Build the context a condition or input mapping is evaluated against. */
export function contextFromSnapshot(
  run: RunSnapshot,
  tasks: readonly TaskSnapshot[],
  node: { key: string; attempt: number },
): ExecutionContext {
  const taskContext: ExecutionContext['tasks'] = {};
  for (const t of tasks) {
    taskContext[t.nodeKey] = {
      state: t.state,
      output: t.output,
      attempts: t.attempts,
      error: t.error,
    };
  }
  return buildContext({
    input: run.input,
    run: {
      id: run.id,
      workflowKey: run.workflowKey,
      version: run.version,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      metadata: run.metadata,
    },
    tasks: taskContext,
    node,
  });
}

/**
 * Is the edge `from -> to` "taken"?
 *
 * An edge is taken when its source SUCCEEDED and its guard (if any) evaluates true.
 * A SKIPPED source produces an untaken edge, which is how a pruned branch propagates
 * downstream without failing anything.
 */
function isEdgeTaken(
  graph: CompiledGraph,
  from: string,
  to: string,
  fromState: TaskRunState,
  context: ExecutionContext,
): { taken: boolean; error?: string } {
  if (fromState !== TaskRunState.SUCCEEDED) return { taken: false };
  const condition = graph.edgeConditions.get(from + '->' + to);
  if (!condition) return { taken: true };
  try {
    return { taken: evaluateCondition(condition, context) };
  } catch (err) {
    return { taken: false, error: (err as Error).message };
  }
}

/**
 * Compute the next set of transitions for a run.
 *
 * The caller is responsible for holding a row lock on the run so that two control-plane
 * instances cannot apply overlapping plans; see `AdvanceService` in the scheduler app.
 */
export function advanceRun(
  graph: CompiledGraph,
  run: RunSnapshot,
  tasks: readonly TaskSnapshot[],
  options: AdvanceOptions = {},
): AdvancePlan {
  const now = options.now ?? new Date();
  const byKey = new Map(tasks.map((t) => [t.nodeKey, t]));
  const transitions: PlannedTaskTransition[] = [];
  const dispatches: PlannedDispatch[] = [];

  // Working copy of state so a single pass can cascade (e.g. a node becomes SKIPPED,
  // and its dependents can be evaluated against that in the same plan).
  const effective = new Map<string, TaskRunState>(tasks.map((t) => [t.nodeKey, t.state]));

  const plan = (t: PlannedTaskTransition): void => {
    transitions.push(t);
    effective.set(t.nodeKey, t.to);
  };

  // ---- terminal run: nothing to do ---------------------------------------
  if (
    run.state === WorkflowRunState.SUCCEEDED ||
    run.state === WorkflowRunState.FAILED ||
    run.state === WorkflowRunState.CANCELLED ||
    run.state === WorkflowRunState.TIMED_OUT
  ) {
    return EMPTY_PLAN;
  }

  // ---- cancellation drains every non-terminal task ------------------------
  if (options.cancellationRequested) {
    for (const task of tasks) {
      if (isTerminalTaskState(task.state)) continue;
      // RUNNING tasks are left alone here: the worker observes the cancel flag,
      // stops, and reports back. Force-cancelling the row would race with its write.
      if (task.state === TaskRunState.RUNNING) continue;
      plan({
        nodeKey: task.nodeKey,
        from: task.state,
        to: TaskRunState.CANCELLED,
        reason: 'cancellation-requested',
        message: options.cancellationReason ?? 'run cancelled',
      });
    }
    const stillRunning = tasks.some((t) => t.state === TaskRunState.RUNNING);
    return {
      taskTransitions: transitions,
      dispatches: [],
      runTransition: stillRunning
        ? null
        : {
            from: run.state,
            to: WorkflowRunState.CANCELLED,
            reason: 'cancellation-requested',
          },
      runOutput: null,
      runError: options.cancellationReason ?? 'run cancelled',
      noop: transitions.length === 0 && stillRunning,
    };
  }

  // ---- run-level timeout --------------------------------------------------
  // Checked before scheduling, but only while work is genuinely outstanding: a run
  // whose tasks have all finished should be recorded by its actual outcome even if the
  // control plane got to it after the deadline. Timing out a run that already succeeded
  // would turn a late sweep into a false failure.
  const deadline = (run.startedAt ?? run.createdAt).getTime() + run.timeoutMs;
  const hasOutstandingWork = tasks.some((t) => !isTerminalTaskState(t.state));
  if (hasOutstandingWork && now.getTime() > deadline) {
    for (const task of tasks) {
      if (isTerminalTaskState(task.state) || task.state === TaskRunState.RUNNING) continue;
      plan({
        nodeKey: task.nodeKey,
        from: task.state,
        to: TaskRunState.CANCELLED,
        reason: 'run-timeout',
        message: 'workflow timeout of ' + run.timeoutMs + 'ms exceeded',
      });
    }
    return {
      taskTransitions: transitions,
      dispatches: [],
      runTransition: { from: run.state, to: WorkflowRunState.TIMED_OUT, reason: 'run-timeout' },
      runOutput: null,
      runError: 'workflow timeout of ' + run.timeoutMs + 'ms exceeded',
      noop: false,
    };
  }

  // ---- per-node readiness, walked in topological order --------------------
  // Topological order matters: evaluating a node after its dependencies means a
  // cascade of SKIPPED nodes resolves in a single pass rather than needing N passes.
  for (const nodeKey of graph.topologicalOrder) {
    const task = byKey.get(nodeKey);
    const node = graph.nodesByKey.get(nodeKey);
    if (!task || !node) continue;
    const state = effective.get(nodeKey) as TaskRunState;

    // A retry whose backoff has elapsed becomes dispatchable again.
    if (state === TaskRunState.RETRYING) {
      if (task.nextAttemptAt && task.nextAttemptAt.getTime() <= now.getTime()) {
        plan({ nodeKey, from: state, to: TaskRunState.QUEUED, reason: 'retry-due' });
        dispatches.push({
          nodeKey,
          queue: node.queue,
          type: node.type,
          attemptNumber: task.attempts + 1,
        });
      }
      continue;
    }

    if (state === TaskRunState.READY) {
      plan({ nodeKey, from: state, to: TaskRunState.QUEUED, reason: 'dispatch' });
      dispatches.push({
        nodeKey,
        queue: node.queue,
        type: node.type,
        attemptNumber: task.attempts + 1,
      });
      continue;
    }

    if (state !== TaskRunState.PENDING && state !== TaskRunState.BLOCKED) continue;

    const deps = graph.dependencies.get(nodeKey) ?? [];

    // 1. Any dependency that can never succeed poisons this node.
    const poisoned = deps.find((d) => {
      const depState = effective.get(d);
      return depState !== undefined && isDependencyPermanentlyUnsatisfiable(depState);
    });
    if (poisoned) {
      plan({
        nodeKey,
        from: state,
        to: TaskRunState.CANCELLED,
        reason: 'upstream-failed',
        message: 'upstream task "' + poisoned + '" did not succeed',
      });
      continue;
    }

    // 2. Still waiting on someone.
    const unresolved = deps.filter((d) => {
      const depState = effective.get(d);
      return depState === undefined || !isDependencySatisfied(depState);
    });
    if (unresolved.length > 0) {
      if (state !== TaskRunState.BLOCKED) {
        plan({ nodeKey, from: state, to: TaskRunState.BLOCKED, reason: 'dependencies-pending' });
      }
      continue;
    }

    // 3. All dependencies resolved — decide whether this branch was taken.
    const context = contextFromSnapshot(run, tasks, { key: nodeKey, attempt: task.attempts + 1 });

    if (deps.length > 0) {
      let anyTaken = false;
      let conditionError: string | undefined;
      for (const dep of deps) {
        const result = isEdgeTaken(
          graph,
          dep,
          nodeKey,
          effective.get(dep) as TaskRunState,
          context,
        );
        if (result.error) conditionError = result.error;
        if (result.taken) anyTaken = true;
      }
      if (conditionError) {
        plan({
          nodeKey,
          from: state,
          to: TaskRunState.FAILED,
          reason: 'condition-error',
          message: 'edge condition failed to evaluate: ' + conditionError,
        });
        continue;
      }
      if (!anyTaken) {
        plan({
          nodeKey,
          from: state,
          to: TaskRunState.SKIPPED,
          reason: 'branch-not-taken',
          message: 'no incoming edge was taken',
        });
        continue;
      }
    }

    // 4. Node-level guard.
    if (node.condition) {
      let passes: boolean;
      try {
        passes = evaluateCondition(node.condition, context);
      } catch (err) {
        plan({
          nodeKey,
          from: state,
          to: TaskRunState.FAILED,
          reason: 'condition-error',
          message: 'condition failed to evaluate: ' + (err as Error).message,
        });
        continue;
      }
      if (!passes) {
        plan({
          nodeKey,
          from: state,
          to: TaskRunState.SKIPPED,
          reason: 'condition-false',
          message: 'condition "' + node.condition + '" evaluated false',
        });
        continue;
      }
    }

    // 5. Ready -> queued in one step; a separate READY write would just be a
    //    second round trip with no observable benefit. The READY state still exists
    //    because the reaper and the replay path both land tasks there.
    plan({ nodeKey, from: state, to: TaskRunState.QUEUED, reason: 'dependencies-satisfied' });
    dispatches.push({
      nodeKey,
      queue: node.queue,
      type: node.type,
      attemptNumber: task.attempts + 1,
    });
  }

  // ---- run-level outcome --------------------------------------------------
  const finalStates = [...effective.values()];
  const allTerminal = finalStates.every((s) => isTerminalTaskState(s));
  let runTransition: AdvancePlan['runTransition'] = null;
  let runError: string | null = null;

  if (allTerminal) {
    const failed = tasks.filter((t) => {
      const s = effective.get(t.nodeKey) as TaskRunState;
      return (
        s === TaskRunState.FAILED ||
        s === TaskRunState.DEAD_LETTERED ||
        s === TaskRunState.TIMED_OUT
      );
    });
    const cancelled = finalStates.some((s) => s === TaskRunState.CANCELLED);

    if (failed.length > 0) {
      const first = failed[0] as TaskSnapshot;
      runError =
        'task "' + first.nodeKey + '" failed: ' + (first.error?.message ?? 'no error recorded');
      runTransition = { from: run.state, to: WorkflowRunState.FAILED, reason: 'task-failed' };
    } else if (cancelled) {
      // Downstream nodes cancelled by a poisoned dependency are covered above; a
      // cancellation reaching here without a failure means an operator cancel raced in.
      runTransition = {
        from: run.state,
        to: WorkflowRunState.CANCELLED,
        reason: 'cancellation-requested',
      };
    } else {
      runTransition = {
        from: run.state,
        to: WorkflowRunState.SUCCEEDED,
        reason: 'all-tasks-complete',
      };
    }
  } else if (run.state === WorkflowRunState.PENDING || run.state === WorkflowRunState.QUEUED) {
    runTransition = {
      from: run.state,
      to: WorkflowRunState.RUNNING,
      reason: 'dependencies-satisfied',
    };
  }

  const noop = transitions.length === 0 && dispatches.length === 0 && runTransition === null;

  return {
    taskTransitions: transitions,
    dispatches,
    runTransition,
    runOutput: null,
    runError,
    noop,
  };
}

/**
 * Initial task states for a fresh run: entry nodes are READY, everything else BLOCKED.
 * Computed up front so a run is fully materialised in the same transaction that
 * creates it — there is no window in which a run exists without its tasks.
 */
export function initialTaskStates(graph: CompiledGraph): Map<string, TaskRunState> {
  const out = new Map<string, TaskRunState>();
  for (const key of graph.topologicalOrder) {
    const deps = graph.dependencies.get(key) ?? [];
    out.set(key, deps.length === 0 ? TaskRunState.READY : TaskRunState.BLOCKED);
  }
  return out;
}
