import { randomUUID } from 'node:crypto';
import {
  ExecutionEventType,
  OutboxEventType,
  TaskRunState,
  WorkflowRunState,
  isTerminalWorkflowState,
  type TraceContext,
  type WorkflowDefinition,
} from '@forge/contracts';
import {
  advanceRun,
  assertTaskTransition,
  assertWorkflowTransition,
  buildTaskInput,
  compileGraph,
  contextFromSnapshot,
  initialTaskStates,
  type AdvancePlan,
  type CompiledGraph,
  type RunSnapshot,
  type TaskSnapshot,
} from '@forge/engine';
import {
  type Prisma,
  type PrismaClient,
  type Tx,
  isUniqueViolation,
  lockWorkflowRun,
  withTransaction,
} from '../client';
import { requestHash } from '../checksum';
import { enqueueOutbox } from '../outbox';
import { recordEvent } from '../events';
import { resolveVersion, loadVersionById } from './workflows';

/**
 * Run lifecycle: creation, advancement, cancellation and replay.
 *
 * The invariant every function here preserves: a run and its complete task set are
 * created in one transaction, and every subsequent state change is a guarded UPDATE
 * (`WHERE state = <expected>`) written alongside its event and its outbox intent. There
 * is no point at which a run exists in a state the database has not recorded.
 */

export class IdempotencyConflictError extends Error {
  constructor(readonly key: string) {
    super(
      'idempotency key "' +
        key +
        '" was already used with a different request body; reuse the key with the same input or choose a new key',
    );
    this.name = 'IdempotencyConflictError';
  }
}

export class WorkflowNotFoundError extends Error {
  constructor(
    readonly key: string,
    readonly version?: number,
  ) {
    super(
      version
        ? 'workflow "' + key + '" version ' + version + ' does not exist'
        : 'workflow "' + key + '" does not exist',
    );
    this.name = 'WorkflowNotFoundError';
  }
}

export interface CreateRunInput {
  workflowKey: string;
  version?: number;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  triggeredBy?: string;
  idempotencyKey?: string;
  scheduleId?: string;
  traceId?: string;
  trace?: TraceContext;
}

export interface CreateRunResult {
  runId: string;
  version: number;
  /** False when an existing run was returned because of an idempotency key. */
  created: boolean;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Create a run and materialise every task in the same transaction.
 *
 * Tasks are created up front rather than lazily as dependencies resolve. That costs one
 * bulk insert but means the run's full shape is durable from the first millisecond: a
 * crash immediately after commit leaves a complete, advanceable run rather than a
 * half-expanded graph that nothing knows how to finish.
 */
export async function createRun(
  prisma: PrismaClient,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  const resolved = await resolveVersion(prisma, input.workflowKey, input.version);
  if (!resolved) throw new WorkflowNotFoundError(input.workflowKey, input.version);

  const definition = resolved.definition;
  const graph = compileGraph(definition);
  const scope = 'run:trigger:' + resolved.workflowKey;
  const hash = requestHash({ input: input.input, version: resolved.version });

  return withTransaction(prisma, async (tx) => {
    const runId = randomUUID();
    const now = new Date();

    if (input.idempotencyKey) {
      const existing = await tx.idempotencyRecord.findUnique({
        where: { scope_key: { scope, key: input.idempotencyKey } },
        select: { resourceId: true, requestHash: true },
      });
      if (existing) {
        // Same key, same body: return the original run — that is the whole point.
        // Same key, different body: the caller has a bug, and silently returning an
        // unrelated run would hide it.
        if (existing.requestHash !== hash) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { runId: existing.resourceId, version: resolved.version, created: false };
      }

      // Claim the key *before* doing the work.
      //
      // The `findUnique` above only settles the sequential case. Two concurrent triggers
      // — a client retrying a request that timed out, or two API replicas handling a
      // duplicate — both see no record and both proceed. Inserting here makes the unique
      // index the arbiter: exactly one transaction wins, the losers raise a unique
      // violation, roll back (taking their half-built run with them) and are resolved
      // against the winner's record by the handler below.
      //
      // Claiming first also means the losers abandon before writing a run and N task
      // rows, rather than after.
      await tx.idempotencyRecord.create({
        data: {
          scope,
          key: input.idempotencyKey,
          requestHash: hash,
          resourceType: 'workflow_run',
          resourceId: runId,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        },
      });
    }

    await tx.workflowRun.create({
      data: {
        id: runId,
        definitionId: resolved.definitionId,
        versionId: resolved.versionId,
        workflowKey: resolved.workflowKey,
        workflowName: resolved.workflowName,
        version: resolved.version,
        state: WorkflowRunState.PENDING,
        input: input.input as Prisma.InputJsonValue,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        triggeredBy: input.triggeredBy ?? 'api',
        idempotencyKey: input.idempotencyKey ?? null,
        scheduleId: input.scheduleId ?? null,
        timeoutMs: definition.timeoutMs,
        traceId: input.traceId ?? null,
        createdAt: now,
      },
    });

    const states = initialTaskStates(graph);
    await tx.taskRun.createMany({
      data: definition.nodes.map((node) => ({
        workflowRunId: runId,
        nodeKey: node.key,
        name: node.name ?? node.key,
        type: node.type,
        queue: node.queue,
        state: states.get(node.key) ?? TaskRunState.BLOCKED,
        attempts: 0,
        maxAttempts: node.retryPolicy.maxAttempts,
        dependsOn: [...(graph.dependencies.get(node.key) ?? [])],
        retryPolicy: node.retryPolicy as unknown as Prisma.InputJsonValue,
        timeoutMs: node.timeoutMs,
      })),
    });

    await recordEvent(tx, {
      workflowRunId: runId,
      type: ExecutionEventType.WORKFLOW_CREATED,
      traceId: input.traceId ?? null,
      message: 'run created for ' + resolved.workflowKey + ' v' + resolved.version,
      payload: { triggeredBy: input.triggeredBy ?? 'api', nodeCount: definition.nodes.length },
    });

    // The run is durable now; the advance signal is an intent, published after commit.
    await enqueueOutbox(tx, {
      type: OutboxEventType.RUN_ADVANCE,
      aggregateType: 'workflow_run',
      aggregateId: runId,
      payload: {
        kind: 'run.advance',
        workflowRunId: runId,
        reason: 'run-created',
        ...(input.trace ? { trace: input.trace } : {}),
      },
    });

    return { runId, version: resolved.version, created: true };
  }).catch(async (err: unknown) => {
    // Lost the race for the idempotency key. The winner's transaction has committed (or
    // is about to), so re-read its record and return that run — which is exactly the
    // behaviour a caller asked for by supplying the key.
    if (input.idempotencyKey && isUniqueViolation(err, 'key')) {
      const winner = await prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope, key: input.idempotencyKey } },
        select: { resourceId: true, requestHash: true },
      });
      if (winner) {
        if (winner.requestHash !== hash) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { runId: winner.resourceId, version: resolved.version, created: false };
      }
    }
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Advancement
// ---------------------------------------------------------------------------

export interface AdvanceResult {
  applied: boolean;
  transitions: number;
  dispatches: number;
  runState: WorkflowRunState;
  finished: boolean;
  events: Array<{ seq: number; type: string; nodeKey: string | null }>;
}

async function loadSnapshot(
  tx: Tx,
  runId: string,
): Promise<{
  run: RunSnapshot;
  tasks: TaskSnapshot[];
  definition: WorkflowDefinition;
  cancelRequested: boolean;
  cancelReason: string | null;
  traceId: string | null;
} | null> {
  const run = await tx.workflowRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      workflowKey: true,
      version: true,
      versionId: true,
      state: true,
      input: true,
      metadata: true,
      startedAt: true,
      createdAt: true,
      timeoutMs: true,
      cancelRequested: true,
      cancelReason: true,
      traceId: true,
    },
  });
  if (!run) return null;

  const version = await loadVersionById(tx, run.versionId);
  if (!version) return null;

  const tasks = await tx.taskRun.findMany({
    where: { workflowRunId: runId },
    select: {
      nodeKey: true,
      state: true,
      output: true,
      attempts: true,
      errorCode: true,
      errorMessage: true,
      nextAttemptAt: true,
    },
  });

  return {
    run: {
      id: run.id,
      workflowKey: run.workflowKey,
      version: run.version,
      state: run.state as WorkflowRunState,
      input: (run.input ?? {}) as Record<string, unknown>,
      metadata: (run.metadata ?? {}) as Record<string, unknown>,
      startedAt: run.startedAt,
      createdAt: run.createdAt,
      timeoutMs: run.timeoutMs,
    },
    tasks: tasks.map((t) => ({
      nodeKey: t.nodeKey,
      state: t.state as TaskRunState,
      output: t.output,
      attempts: t.attempts,
      error: t.errorMessage ? { code: t.errorCode, message: t.errorMessage } : null,
      nextAttemptAt: t.nextAttemptAt,
    })),
    definition: version.definition,
    cancelRequested: run.cancelRequested,
    cancelReason: run.cancelReason,
    traceId: run.traceId,
  };
}

const EVENT_FOR_TASK_STATE: Partial<Record<TaskRunState, ExecutionEventType>> = {
  [TaskRunState.BLOCKED]: ExecutionEventType.TASK_BLOCKED,
  [TaskRunState.READY]: ExecutionEventType.TASK_READY,
  [TaskRunState.QUEUED]: ExecutionEventType.TASK_QUEUED,
  [TaskRunState.SKIPPED]: ExecutionEventType.TASK_SKIPPED,
  [TaskRunState.CANCELLED]: ExecutionEventType.TASK_CANCELLED,
  [TaskRunState.FAILED]: ExecutionEventType.TASK_FAILED,
};

const EVENT_FOR_RUN_STATE: Partial<Record<WorkflowRunState, ExecutionEventType>> = {
  [WorkflowRunState.RUNNING]: ExecutionEventType.WORKFLOW_STARTED,
  [WorkflowRunState.SUCCEEDED]: ExecutionEventType.WORKFLOW_COMPLETED,
  [WorkflowRunState.FAILED]: ExecutionEventType.WORKFLOW_FAILED,
  [WorkflowRunState.CANCELLED]: ExecutionEventType.WORKFLOW_CANCELLED,
  [WorkflowRunState.TIMED_OUT]: ExecutionEventType.WORKFLOW_TIMED_OUT,
};

/**
 * Compute and apply the next set of transitions for a run.
 *
 * The run row is locked for the duration, so concurrent advances (a completing worker, a
 * retry sweep and a reaper can all trigger one within the same tick) serialise instead
 * of applying overlapping plans. Every UPDATE additionally carries a `state = <from>`
 * guard, so even a bug in the locking would degrade to a lost update rather than an
 * illegal transition.
 */
export async function advance(
  prisma: PrismaClient,
  runId: string,
  options: { now?: Date; trace?: TraceContext } = {},
): Promise<AdvanceResult> {
  return withTransaction(prisma, async (tx) => {
    const locked = await lockWorkflowRun(tx, runId);
    if (!locked) {
      return {
        applied: false,
        transitions: 0,
        dispatches: 0,
        runState: WorkflowRunState.PENDING,
        finished: false,
        events: [],
      };
    }

    const snapshot = await loadSnapshot(tx, runId);
    if (!snapshot) {
      return {
        applied: false,
        transitions: 0,
        dispatches: 0,
        runState: WorkflowRunState.PENDING,
        finished: false,
        events: [],
      };
    }

    const graph = compileGraph(snapshot.definition);
    const plan = advanceRun(graph, snapshot.run, snapshot.tasks, {
      ...(options.now ? { now: options.now } : {}),
      cancellationRequested: snapshot.cancelRequested,
      ...(snapshot.cancelReason ? { cancellationReason: snapshot.cancelReason } : {}),
    });

    if (plan.noop) {
      return {
        applied: false,
        transitions: 0,
        dispatches: 0,
        runState: snapshot.run.state,
        finished: false,
        events: [],
      };
    }

    return applyPlan(tx, {
      runId,
      plan,
      graph,
      snapshot,
      trace: options.trace,
    });
  });
}

interface ApplyPlanArgs {
  runId: string;
  plan: AdvancePlan;
  graph: CompiledGraph;
  snapshot: NonNullable<Awaited<ReturnType<typeof loadSnapshot>>>;
  trace?: TraceContext | undefined;
}

async function applyPlan(tx: Tx, args: ApplyPlanArgs): Promise<AdvanceResult> {
  const { runId, plan, graph, snapshot } = args;
  const now = new Date();
  const events: AdvanceResult['events'] = [];
  const appliedKeys = new Set<string>();
  let transitionCount = 0;

  for (const transition of plan.taskTransitions) {
    // Fails loudly on a plan the state machine forbids — that would be an engine bug,
    // and writing it would corrupt the run rather than merely fail it.
    assertTaskTransition(transition.from, transition.to);

    const result = await tx.taskRun.updateMany({
      where: { workflowRunId: runId, nodeKey: transition.nodeKey, state: transition.from },
      data: {
        state: transition.to,
        ...(transition.to === TaskRunState.QUEUED ? { queuedAt: now } : {}),
        ...(transition.to === TaskRunState.SKIPPED ||
        transition.to === TaskRunState.CANCELLED ||
        transition.to === TaskRunState.FAILED
          ? { finishedAt: now }
          : {}),
        ...(transition.message && transition.to !== TaskRunState.QUEUED
          ? { errorMessage: transition.message }
          : {}),
      },
    });

    // Zero rows means another writer moved the task first. That is expected under
    // concurrency and is exactly why the plan is recomputed rather than replayed.
    if (result.count === 0) continue;
    transitionCount += 1;
    appliedKeys.add(transition.nodeKey);

    const eventType = EVENT_FOR_TASK_STATE[transition.to];
    if (eventType) {
      const task = await tx.taskRun.findUnique({
        where: { workflowRunId_nodeKey: { workflowRunId: runId, nodeKey: transition.nodeKey } },
        select: { id: true },
      });
      const event = await recordEvent(tx, {
        workflowRunId: runId,
        type: eventType,
        taskRunId: task?.id ?? null,
        nodeKey: transition.nodeKey,
        traceId: snapshot.traceId,
        message: transition.message ?? transition.reason,
        payload: { reason: transition.reason },
      });
      events.push({ seq: event.seq, type: event.type, nodeKey: transition.nodeKey });
    }
  }

  // Only dispatch nodes whose transition actually landed.
  for (const dispatch of plan.dispatches) {
    if (!appliedKeys.has(dispatch.nodeKey)) continue;

    const task = await tx.taskRun.findUnique({
      where: { workflowRunId_nodeKey: { workflowRunId: runId, nodeKey: dispatch.nodeKey } },
      select: { id: true, attempts: true },
    });
    if (!task) continue;

    // Resolve the node's input now, from persisted upstream outputs, and store it on
    // the task. The worker then executes from a materialised input rather than
    // re-deriving it — which keeps replay honest and makes the console's "input" panel
    // show exactly what ran.
    const node = graph.nodesByKey.get(dispatch.nodeKey);
    if (node) {
      const context = contextFromSnapshot(snapshot.run, snapshot.tasks, {
        key: dispatch.nodeKey,
        attempt: task.attempts + 1,
      });
      let resolvedInput: Record<string, unknown>;
      try {
        resolvedInput = buildTaskInput(node.config, node.input, context);
      } catch (err) {
        // An unresolvable mapping is a definition bug, not a transient failure: fail
        // the node immediately instead of burning its retry budget on a certainty.
        await tx.taskRun.updateMany({
          where: { workflowRunId: runId, nodeKey: dispatch.nodeKey, state: TaskRunState.QUEUED },
          data: {
            state: TaskRunState.FAILED,
            errorCode: 'INPUT_RESOLUTION_FAILED',
            errorMessage: (err as Error).message,
            finishedAt: now,
          },
        });
        await recordEvent(tx, {
          workflowRunId: runId,
          type: ExecutionEventType.TASK_FAILED,
          taskRunId: task.id,
          nodeKey: dispatch.nodeKey,
          traceId: snapshot.traceId,
          message: 'input resolution failed: ' + (err as Error).message,
        });
        continue;
      }

      await tx.taskRun.update({
        where: { id: task.id },
        data: { input: resolvedInput as Prisma.InputJsonValue },
      });
    }

    await enqueueOutbox(tx, {
      type: OutboxEventType.TASK_DISPATCH,
      aggregateType: 'task_run',
      aggregateId: task.id,
      payload: {
        kind: 'task.dispatch',
        taskRunId: task.id,
        workflowRunId: runId,
        nodeKey: dispatch.nodeKey,
        type: dispatch.type,
        queue: dispatch.queue,
        expectedAttempt: dispatch.attemptNumber,
        dispatchId: randomUUID(),
        ...(args.trace ? { trace: args.trace } : {}),
      },
    });
  }

  // --- run-level transition -------------------------------------------------
  let runState = snapshot.run.state;
  let finished = false;

  if (plan.runTransition) {
    assertWorkflowTransition(plan.runTransition.from, plan.runTransition.to);
    const to = plan.runTransition.to;
    const isTerminal =
      to === WorkflowRunState.SUCCEEDED ||
      to === WorkflowRunState.FAILED ||
      to === WorkflowRunState.CANCELLED ||
      to === WorkflowRunState.TIMED_OUT;

    const output = isTerminal ? await buildRunOutput(tx, runId, graph) : null;

    const result = await tx.workflowRun.updateMany({
      where: { id: runId, state: plan.runTransition.from },
      data: {
        state: to,
        ...(to === WorkflowRunState.RUNNING && !snapshot.run.startedAt ? { startedAt: now } : {}),
        ...(isTerminal
          ? {
              finishedAt: now,
              durationMs:
                now.getTime() - (snapshot.run.startedAt ?? snapshot.run.createdAt).getTime(),
              ...(plan.runError ? { errorMessage: plan.runError } : {}),
              ...(output ? { output: output as Prisma.InputJsonValue } : {}),
            }
          : {}),
      },
    });

    if (result.count > 0) {
      runState = to;
      finished = isTerminal;
      const eventType = EVENT_FOR_RUN_STATE[to];
      if (eventType) {
        const event = await recordEvent(tx, {
          workflowRunId: runId,
          type: eventType,
          traceId: snapshot.traceId,
          message: plan.runError ?? plan.runTransition.reason,
          payload: { reason: plan.runTransition.reason },
        });
        events.push({ seq: event.seq, type: event.type, nodeKey: null });
      }
    }
  }

  return {
    applied: transitionCount > 0 || plan.dispatches.length > 0 || plan.runTransition !== null,
    transitions: transitionCount,
    dispatches: plan.dispatches.filter((d) => appliedKeys.has(d.nodeKey)).length,
    runState,
    finished,
    events,
  };
}

/** Materialise the run's output document from the definition's output mapping. */
async function buildRunOutput(
  tx: Tx,
  runId: string,
  graph: CompiledGraph,
): Promise<Record<string, unknown> | null> {
  const mapping = graph.definition.output;
  if (!mapping || Object.keys(mapping).length === 0) return null;

  const run = await tx.workflowRun.findUnique({
    where: { id: runId },
    select: { input: true, metadata: true, startedAt: true, workflowKey: true, version: true },
  });
  if (!run) return null;

  const tasks = await tx.taskRun.findMany({
    where: { workflowRunId: runId },
    select: {
      nodeKey: true,
      state: true,
      output: true,
      attempts: true,
      errorCode: true,
      errorMessage: true,
    },
  });

  const context = contextFromSnapshot(
    {
      id: runId,
      workflowKey: run.workflowKey,
      version: run.version,
      state: WorkflowRunState.RUNNING,
      input: (run.input ?? {}) as Record<string, unknown>,
      metadata: (run.metadata ?? {}) as Record<string, unknown>,
      startedAt: run.startedAt,
      createdAt: new Date(),
      timeoutMs: 0,
    },
    tasks.map((t) => ({
      nodeKey: t.nodeKey,
      state: t.state as TaskRunState,
      output: t.output,
      attempts: t.attempts,
      error: t.errorMessage ? { code: t.errorCode, message: t.errorMessage } : null,
      nextAttemptAt: null,
    })),
    { key: '$output', attempt: 0 },
  );

  // Lenient: a mapping that points at a skipped branch should yield `undefined`, not
  // fail a run that otherwise succeeded.
  const { resolveInputMapping } = await import('@forge/engine');
  return resolveInputMapping(mapping, context, { lenient: true });
}

// ---------------------------------------------------------------------------
// Cancellation and replay
// ---------------------------------------------------------------------------

/**
 * Request cancellation.
 *
 * Cooperative by design: this sets a flag and signals an advance. Running tasks observe
 * the flag and stop; queued tasks are cancelled by the advance. Forcing a RUNNING row to
 * CANCELLED here would race with the worker's own completion write.
 */
export async function requestCancellation(
  prisma: PrismaClient,
  runId: string,
  reason?: string,
): Promise<{ cancelled: boolean; alreadyFinished: boolean }> {
  return withTransaction(prisma, async (tx) => {
    const run = await tx.workflowRun.findUnique({
      where: { id: runId },
      select: { state: true, cancelRequested: true },
    });
    if (!run) return { cancelled: false, alreadyFinished: false };

    const terminal = isTerminalWorkflowState(run.state as WorkflowRunState);
    if (terminal) return { cancelled: false, alreadyFinished: true };

    await tx.workflowRun.update({
      where: { id: runId },
      data: { cancelRequested: true, cancelReason: reason ?? 'cancelled by operator' },
    });

    await recordEvent(tx, {
      workflowRunId: runId,
      type: ExecutionEventType.WORKFLOW_CANCELLED,
      message: reason ?? 'cancellation requested',
      payload: { phase: 'requested' },
    });

    await enqueueOutbox(tx, {
      type: OutboxEventType.RUN_ADVANCE,
      aggregateType: 'workflow_run',
      aggregateId: runId,
      payload: { kind: 'run.advance', workflowRunId: runId, reason: 'cancellation-requested' },
    });

    return { cancelled: true, alreadyFinished: false };
  });
}

/**
 * Replay a finished run as a new run.
 *
 * A replay is a fresh run, never a mutation of the original: rewriting history would
 * destroy the evidence of what actually happened, which is the main reason to keep an
 * execution log at all. By default the replay pins the same version so it reproduces
 * the original behaviour.
 */
export async function replayRun(
  prisma: PrismaClient,
  runId: string,
  options: {
    useLatestVersion?: boolean;
    input?: Record<string, unknown>;
    triggeredBy?: string;
  } = {},
): Promise<CreateRunResult> {
  const original = await prisma.workflowRun.findUnique({
    where: { id: runId },
    select: { workflowKey: true, version: true, input: true, metadata: true },
  });
  if (!original) throw new WorkflowNotFoundError(runId);

  return createRun(prisma, {
    workflowKey: original.workflowKey,
    ...(options.useLatestVersion ? {} : { version: original.version }),
    input: (options.input ?? original.input ?? {}) as Record<string, unknown>,
    metadata: { ...((original.metadata ?? {}) as Record<string, unknown>), replayOf: runId },
    triggeredBy: options.triggeredBy ?? 'replay',
  });
}

/** Signal that a run may have new work, without computing anything. */
export async function signalAdvance(
  tx: Tx,
  runId: string,
  reason: string,
  trace?: TraceContext,
): Promise<void> {
  await enqueueOutbox(tx, {
    type: OutboxEventType.RUN_ADVANCE,
    aggregateType: 'workflow_run',
    aggregateId: runId,
    payload: {
      kind: 'run.advance',
      workflowRunId: runId,
      reason: reason.slice(0, 120),
      ...(trace ? { trace } : {}),
    },
  });
}

/**
 * Runs whose wall-clock budget has elapsed while work is still outstanding.
 * Swept periodically because nothing else would notice a run stalled on a task that
 * no worker can execute.
 */
export async function findTimedOutRuns(prisma: PrismaClient, limit = 50): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM workflow_run
    WHERE state IN ('PENDING', 'QUEUED', 'RUNNING')
      AND COALESCE("startedAt", "createdAt") + ("timeoutMs" || ' milliseconds')::interval < now()
    ORDER BY "createdAt" ASC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}
