import {
  ExecutionEventType,
  TaskAttemptState,
  TaskRunState,
  WorkflowRunState,
  type RetryPolicy,
} from '@forge/contracts';
import {
  assertTaskTransition,
  decideRetry,
  redactSecrets,
  truncateForDisplay,
} from '@forge/engine';
import {
  type Prisma,
  type PrismaClient,
  type Tx,
  isUniqueViolation,
  withTransaction,
} from '../client';
import { recordEvent } from '../events';
import { signalAdvance } from './runs';

/**
 * Task claiming, lease management and attempt completion.
 *
 * This module is where FORGE's delivery semantics actually live. The queue guarantees
 * at-least-once *delivery*; these functions turn that into at-most-once *logical
 * execution* per attempt, using two database constraints rather than trust:
 *
 *   1. `task_attempt(task_run_id, attempt_number)` is unique — two workers racing on the
 *      same dispatch cannot both create attempt N; the loser's insert fails and it
 *      discards the message.
 *   2. `worker_lease(task_run_id, attempt_number)` is unique — a completion is only
 *      accepted from the worker that still holds the live lease for that attempt.
 *
 * See docs/adr/005-delivery-semantics.md for the honest version of what that does and
 * does not guarantee.
 */

export interface ClaimRequest {
  taskRunId: string;
  workerId: string;
  leaseTtlMs: number;
  dispatchId?: string;
  traceId?: string;
  spanId?: string;
  now?: Date;
}

export interface ClaimedTask {
  taskRunId: string;
  workflowRunId: string;
  workflowKey: string;
  nodeKey: string;
  name: string;
  type: string;
  attemptId: string;
  attemptNumber: number;
  input: Record<string, unknown>;
  timeoutMs: number;
  leaseExpiresAt: Date;
  retryPolicy: RetryPolicy;
  traceId: string | null;
}

export type ClaimResult =
  | { ok: true; task: ClaimedTask }
  | {
      ok: false;
      /**
       * Why the claim was refused. All of these are normal under at-least-once
       * delivery — the worker logs at debug and moves on.
       */
      reason:
        | 'not-found'
        | 'not-claimable'
        | 'run-terminal'
        | 'cancelled'
        | 'lost-race'
        | 'worker-unknown';
      state?: TaskRunState;
    };

/**
 * Atomically claim a task and open a lease.
 *
 * The task row is locked first so that the state check and the attempt insert cannot be
 * interleaved by another worker. Under contention one worker wins the lock, transitions
 * the row out of QUEUED, and every other worker then observes `not-claimable`.
 */
export async function claimTask(prisma: PrismaClient, request: ClaimRequest): Promise<ClaimResult> {
  const now = request.now ?? new Date();

  try {
    return await withTransaction(prisma, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM task_run WHERE id = ${request.taskRunId}::uuid FOR UPDATE
      `;
      if (locked.length === 0) return { ok: false, reason: 'not-found' } as ClaimResult;

      const task = await tx.taskRun.findUnique({
        where: { id: request.taskRunId },
        select: {
          id: true,
          workflowRunId: true,
          nodeKey: true,
          name: true,
          type: true,
          state: true,
          attempts: true,
          input: true,
          timeoutMs: true,
          retryPolicy: true,
          run: {
            select: { state: true, cancelRequested: true, workflowKey: true, traceId: true },
          },
        },
      });
      if (!task) return { ok: false, reason: 'not-found' } as ClaimResult;

      if (task.run.cancelRequested) return { ok: false, reason: 'cancelled' } as ClaimResult;
      if (
        task.run.state === WorkflowRunState.SUCCEEDED ||
        task.run.state === WorkflowRunState.FAILED ||
        task.run.state === WorkflowRunState.CANCELLED ||
        task.run.state === WorkflowRunState.TIMED_OUT
      ) {
        return { ok: false, reason: 'run-terminal' } as ClaimResult;
      }

      const state = task.state as TaskRunState;
      if (state !== TaskRunState.QUEUED && state !== TaskRunState.READY) {
        // The overwhelmingly common case: a duplicate delivery for work already done.
        return { ok: false, reason: 'not-claimable', state } as ClaimResult;
      }

      const worker = await tx.worker.findUnique({
        where: { id: request.workerId },
        select: { id: true },
      });
      if (!worker) return { ok: false, reason: 'worker-unknown' } as ClaimResult;

      const attemptNumber = task.attempts + 1;
      const leaseExpiresAt = new Date(now.getTime() + request.leaseTtlMs);

      // Unique on (taskRunId, attemptNumber): the durable guard against double
      // execution. A concurrent claimer that got past the state check loses here.
      const attempt = await tx.taskAttempt.create({
        data: {
          taskRunId: task.id,
          attemptNumber,
          state: TaskAttemptState.RUNNING,
          workerId: request.workerId,
          dispatchId: request.dispatchId ?? null,
          input: (task.input ?? {}) as Prisma.InputJsonValue,
          traceId: request.traceId ?? task.run.traceId ?? null,
          spanId: request.spanId ?? null,
          startedAt: now,
        },
        select: { id: true },
      });

      await tx.workerLease.create({
        data: {
          taskRunId: task.id,
          attemptNumber,
          workerId: request.workerId,
          acquiredAt: now,
          expiresAt: leaseExpiresAt,
          heartbeatAt: now,
        },
      });

      assertTaskTransition(state, TaskRunState.RUNNING);
      const updated = await tx.taskRun.updateMany({
        where: { id: task.id, state },
        data: {
          state: TaskRunState.RUNNING,
          attempts: attemptNumber,
          workerId: request.workerId,
          startedAt: task.attempts === 0 ? now : undefined,
          traceId: request.traceId ?? task.run.traceId ?? null,
        },
      });
      if (updated.count === 0) return { ok: false, reason: 'lost-race' } as ClaimResult;

      await tx.worker.update({
        where: { id: request.workerId },
        data: { activeTasks: { increment: 1 }, lastHeartbeatAt: now },
      });

      await recordEvent(tx, {
        workflowRunId: task.workflowRunId,
        type: ExecutionEventType.TASK_STARTED,
        taskRunId: task.id,
        nodeKey: task.nodeKey,
        workerId: request.workerId,
        attemptNumber,
        traceId: request.traceId ?? null,
        message: 'worker ' + request.workerId.slice(0, 8) + ' acquired ' + task.nodeKey,
        payload: { attempt: attemptNumber, leaseExpiresAt: leaseExpiresAt.toISOString() },
      });

      return {
        ok: true,
        task: {
          taskRunId: task.id,
          workflowRunId: task.workflowRunId,
          workflowKey: task.run.workflowKey,
          nodeKey: task.nodeKey,
          name: task.name,
          type: task.type,
          attemptId: attempt.id,
          attemptNumber,
          input: (task.input ?? {}) as Record<string, unknown>,
          timeoutMs: task.timeoutMs,
          leaseExpiresAt,
          retryPolicy: task.retryPolicy as unknown as RetryPolicy,
          traceId: request.traceId ?? task.run.traceId ?? null,
        },
      } as ClaimResult;
    });
  } catch (err) {
    // Two workers reached `create` for the same attempt number. Expected; not an error.
    if (isUniqueViolation(err)) return { ok: false, reason: 'lost-race' };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Lease renewal
// ---------------------------------------------------------------------------

export interface RenewResult {
  renewed: boolean;
  expiresAt: Date | null;
  /** True when the run has been cancelled and the worker should stop. */
  cancelRequested: boolean;
}

/**
 * Renew a lease.
 *
 * The `releasedAt IS NULL` and `workerId` predicates are the point: a worker that was
 * paused past its expiry and had its task reclaimed will fail to renew and must abandon
 * its in-flight work rather than finish and overwrite the recovery.
 */
export async function renewLease(
  prisma: PrismaClient,
  params: { taskRunId: string; attemptNumber: number; workerId: string; ttlMs: number },
): Promise<RenewResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + params.ttlMs);

  const result = await prisma.workerLease.updateMany({
    where: {
      taskRunId: params.taskRunId,
      attemptNumber: params.attemptNumber,
      workerId: params.workerId,
      releasedAt: null,
    },
    data: { expiresAt, heartbeatAt: now, renewals: { increment: 1 } },
  });

  if (result.count === 0) return { renewed: false, expiresAt: null, cancelRequested: false };

  const task = await prisma.taskRun.findUnique({
    where: { id: params.taskRunId },
    select: { run: { select: { cancelRequested: true } } },
  });

  return {
    renewed: true,
    expiresAt,
    cancelRequested: task?.run.cancelRequested ?? false,
  };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export interface CompleteRequest {
  taskRunId: string;
  attemptNumber: number;
  workerId: string;
  output: unknown;
  now?: Date;
}

export type CompletionOutcome =
  | { ok: true; runFinished: boolean }
  /** The lease was lost (expired and reclaimed): the result must be discarded. */
  | { ok: false; reason: 'lease-lost' | 'not-running' | 'not-found' };

/**
 * Record a successful attempt.
 *
 * Ownership is re-verified inside the transaction rather than trusted from the worker's
 * own view of the world. A worker whose lease expired mid-task will land here and be
 * told to drop its result, which is what prevents a slow worker from clobbering the
 * output of the worker that recovered its task.
 */
export async function completeTask(
  prisma: PrismaClient,
  request: CompleteRequest,
): Promise<CompletionOutcome> {
  const now = request.now ?? new Date();

  return withTransaction(prisma, async (tx) => {
    await tx.$queryRaw`SELECT id FROM task_run WHERE id = ${request.taskRunId}::uuid FOR UPDATE`;

    const task = await tx.taskRun.findUnique({
      where: { id: request.taskRunId },
      select: {
        id: true,
        workflowRunId: true,
        nodeKey: true,
        state: true,
        startedAt: true,
        attempts: true,
      },
    });
    if (!task) return { ok: false, reason: 'not-found' };

    const released = await releaseLeaseIfOwned(tx, request, now, 'completed');
    if (!released) return { ok: false, reason: 'lease-lost' };

    if ((task.state as TaskRunState) !== TaskRunState.RUNNING) {
      return { ok: false, reason: 'not-running' };
    }

    const attempt = await tx.taskAttempt.findUnique({
      where: {
        taskRunId_attemptNumber: {
          taskRunId: request.taskRunId,
          attemptNumber: request.attemptNumber,
        },
      },
      select: { id: true, startedAt: true },
    });

    const output = truncateForDisplay(redactSecrets(request.output), 64 * 1024);

    if (attempt) {
      await tx.taskAttempt.update({
        where: { id: attempt.id },
        data: {
          state: TaskAttemptState.SUCCEEDED,
          output: output as Prisma.InputJsonValue,
          finishedAt: now,
          durationMs: now.getTime() - attempt.startedAt.getTime(),
        },
      });
    }

    assertTaskTransition(TaskRunState.RUNNING, TaskRunState.SUCCEEDED);
    const updated = await tx.taskRun.updateMany({
      where: { id: request.taskRunId, state: TaskRunState.RUNNING },
      data: {
        state: TaskRunState.SUCCEEDED,
        output: output as Prisma.InputJsonValue,
        finishedAt: now,
        durationMs: task.startedAt ? now.getTime() - task.startedAt.getTime() : null,
        errorCode: null,
        errorMessage: null,
        nextAttemptAt: null,
      },
    });
    if (updated.count === 0) return { ok: false, reason: 'not-running' };

    await tx.worker.update({
      where: { id: request.workerId },
      data: {
        activeTasks: { decrement: 1 },
        tasksCompleted: { increment: 1 },
        lastHeartbeatAt: now,
      },
    });

    await recordEvent(tx, {
      workflowRunId: task.workflowRunId,
      type: ExecutionEventType.TASK_COMPLETED,
      taskRunId: task.id,
      nodeKey: task.nodeKey,
      workerId: request.workerId,
      attemptNumber: request.attemptNumber,
      message: task.nodeKey + ' completed',
      payload: { output: output as Record<string, unknown> },
    });

    await signalAdvance(tx, task.workflowRunId, 'task-completed');
    return { ok: true, runFinished: false };
  });
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

export interface FailRequest {
  taskRunId: string;
  attemptNumber: number;
  workerId: string;
  errorCode: string;
  errorMessage: string;
  errorStack?: string;
  /** Marks the attempt TIMED_OUT rather than FAILED; retry policy still applies. */
  timedOut?: boolean;
  now?: Date;
  rng?: () => number;
}

export type FailureOutcome =
  | {
      ok: true;
      decision: 'retry' | 'dead-letter' | 'failed';
      nextAttemptAt: Date | null;
      attemptsUsed: number;
    }
  | { ok: false; reason: 'lease-lost' | 'not-running' | 'not-found' };

/**
 * Record a failed attempt and decide what happens next.
 *
 * The retry budget is measured against `failures` (application failures) rather than
 * `attempts` (physical attempts), so an attempt lost to a worker crash does not consume
 * a retry the application never got to use.
 */
export async function failTask(
  prisma: PrismaClient,
  request: FailRequest,
): Promise<FailureOutcome> {
  const now = request.now ?? new Date();

  return withTransaction(prisma, async (tx) => {
    await tx.$queryRaw`SELECT id FROM task_run WHERE id = ${request.taskRunId}::uuid FOR UPDATE`;

    const task = await tx.taskRun.findUnique({
      where: { id: request.taskRunId },
      select: {
        id: true,
        workflowRunId: true,
        nodeKey: true,
        type: true,
        state: true,
        failures: true,
        attempts: true,
        startedAt: true,
        input: true,
        retryPolicy: true,
        run: { select: { workflowKey: true, cancelRequested: true } },
      },
    });
    if (!task) return { ok: false, reason: 'not-found' };

    const released = await releaseLeaseIfOwned(tx, request, now, 'failed');
    if (!released) return { ok: false, reason: 'lease-lost' };

    if ((task.state as TaskRunState) !== TaskRunState.RUNNING) {
      return { ok: false, reason: 'not-running' };
    }

    const attempt = await tx.taskAttempt.findUnique({
      where: {
        taskRunId_attemptNumber: {
          taskRunId: request.taskRunId,
          attemptNumber: request.attemptNumber,
        },
      },
      select: { id: true, startedAt: true },
    });
    if (attempt) {
      await tx.taskAttempt.update({
        where: { id: attempt.id },
        data: {
          state: request.timedOut ? TaskAttemptState.TIMED_OUT : TaskAttemptState.FAILED,
          errorCode: request.errorCode,
          errorMessage: request.errorMessage.slice(0, 2000),
          errorStack: request.errorStack?.slice(0, 8000) ?? null,
          finishedAt: now,
          durationMs: now.getTime() - attempt.startedAt.getTime(),
        },
      });
    }

    const policy = task.retryPolicy as unknown as RetryPolicy;
    const failures = task.failures + 1;
    const decision = decideRetry({
      policy,
      attemptsUsed: failures,
      errorCode: request.errorCode,
      cancelled: task.run.cancelRequested,
      now,
      ...(request.rng ? { rng: request.rng } : {}),
    });

    await tx.worker.update({
      where: { id: request.workerId },
      data: { activeTasks: { decrement: 1 }, tasksFailed: { increment: 1 }, lastHeartbeatAt: now },
    });

    if (decision.shouldRetry) {
      assertTaskTransition(TaskRunState.RUNNING, TaskRunState.RETRYING);
      await tx.taskRun.updateMany({
        where: { id: task.id, state: TaskRunState.RUNNING },
        data: {
          state: TaskRunState.RETRYING,
          failures,
          errorCode: request.errorCode,
          errorMessage: request.errorMessage.slice(0, 2000),
          nextAttemptAt: decision.nextAttemptAt,
          workerId: null,
        },
      });

      await recordEvent(tx, {
        workflowRunId: task.workflowRunId,
        type: request.timedOut ? ExecutionEventType.TASK_TIMED_OUT : ExecutionEventType.TASK_FAILED,
        taskRunId: task.id,
        nodeKey: task.nodeKey,
        workerId: request.workerId,
        attemptNumber: request.attemptNumber,
        message:
          task.nodeKey + ' attempt ' + request.attemptNumber + ' failed: ' + request.errorMessage,
        payload: { errorCode: request.errorCode },
      });

      await recordEvent(tx, {
        workflowRunId: task.workflowRunId,
        type: ExecutionEventType.TASK_RETRY_SCHEDULED,
        taskRunId: task.id,
        nodeKey: task.nodeKey,
        attemptNumber: decision.nextAttemptNumber,
        message:
          'retry ' +
          decision.nextAttemptNumber +
          '/' +
          policy.maxAttempts +
          ' in ' +
          decision.delayMs +
          'ms',
        payload: { delayMs: decision.delayMs, nextAttemptAt: decision.nextAttemptAt.toISOString() },
      });

      // The retry sweeper polls `state = RETRYING AND nextAttemptAt <= now()`; the
      // advance signal covers the case where the delay is effectively zero.
      await signalAdvance(tx, task.workflowRunId, 'retry-scheduled');
      return {
        ok: true,
        decision: 'retry',
        nextAttemptAt: decision.nextAttemptAt,
        attemptsUsed: failures,
      };
    }

    // --- terminal for this task ---------------------------------------------
    const terminalState =
      request.timedOut && decision.reason === 'budget-exhausted'
        ? TaskRunState.TIMED_OUT
        : decision.reason === 'budget-exhausted'
          ? TaskRunState.DEAD_LETTERED
          : TaskRunState.FAILED;

    assertTaskTransition(TaskRunState.RUNNING, terminalState);
    await tx.taskRun.updateMany({
      where: { id: task.id, state: TaskRunState.RUNNING },
      data: {
        state: terminalState,
        failures,
        errorCode: request.errorCode,
        errorMessage: request.errorMessage.slice(0, 2000),
        finishedAt: now,
        durationMs: task.startedAt ? now.getTime() - task.startedAt.getTime() : null,
        nextAttemptAt: null,
        workerId: null,
      },
    });

    if (terminalState === TaskRunState.DEAD_LETTERED || terminalState === TaskRunState.TIMED_OUT) {
      await tx.deadLetter.upsert({
        where: { taskRunId: task.id },
        create: {
          workflowRunId: task.workflowRunId,
          taskRunId: task.id,
          workflowKey: task.run.workflowKey,
          nodeKey: task.nodeKey,
          type: task.type,
          attempts: failures,
          errorCode: request.errorCode,
          errorMessage: request.errorMessage.slice(0, 2000),
          input: (task.input ?? {}) as Prisma.InputJsonValue,
        },
        update: {
          attempts: failures,
          errorCode: request.errorCode,
          errorMessage: request.errorMessage.slice(0, 2000),
          status: 'OPEN',
          resolvedAt: null,
        },
      });

      await recordEvent(tx, {
        workflowRunId: task.workflowRunId,
        type: ExecutionEventType.TASK_DEAD_LETTERED,
        taskRunId: task.id,
        nodeKey: task.nodeKey,
        attemptNumber: request.attemptNumber,
        message:
          task.nodeKey + ' exhausted its retry budget after ' + failures + ' failed attempts',
        payload: { errorCode: request.errorCode, attempts: failures },
      });
    } else {
      await recordEvent(tx, {
        workflowRunId: task.workflowRunId,
        type: ExecutionEventType.TASK_FAILED,
        taskRunId: task.id,
        nodeKey: task.nodeKey,
        workerId: request.workerId,
        attemptNumber: request.attemptNumber,
        message: task.nodeKey + ' failed: ' + request.errorMessage,
        payload: { errorCode: request.errorCode, reason: decision.reason },
      });
    }

    await signalAdvance(tx, task.workflowRunId, 'task-failed');
    return {
      ok: true,
      decision: terminalState === TaskRunState.FAILED ? 'failed' : 'dead-letter',
      nextAttemptAt: null,
      attemptsUsed: failures,
    };
  });
}

/** Release the lease if — and only if — this worker still holds it. */
async function releaseLeaseIfOwned(
  tx: Tx,
  params: { taskRunId: string; attemptNumber: number; workerId: string },
  now: Date,
  reason: string,
): Promise<boolean> {
  const result = await tx.workerLease.updateMany({
    where: {
      taskRunId: params.taskRunId,
      attemptNumber: params.attemptNumber,
      workerId: params.workerId,
      releasedAt: null,
      // A lease that has already expired is not the worker's to release: the reaper may
      // be mid-recovery, and accepting the result would race with it.
      expiresAt: { gt: now },
    },
    data: { releasedAt: now, releaseReason: reason },
  });
  return result.count > 0;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface ReclaimedTask {
  taskRunId: string;
  workflowRunId: string;
  nodeKey: string;
  workerId: string;
  attemptNumber: number;
  requeued: boolean;
}

/**
 * Reclaim tasks whose worker stopped renewing.
 *
 * This is the function that makes a `kill -9` on a worker a non-event. It runs on a
 * timer in the control plane, finds leases past their expiry plus a grace period, marks
 * the attempt ABANDONED and returns the task to QUEUED so any worker can pick it up.
 *
 * The grace period exists because the alternative — reclaiming the instant a lease
 * expires — turns ordinary clock skew between the worker and the control plane into
 * duplicate execution.
 */
export async function reclaimExpiredLeases(
  prisma: PrismaClient,
  options: { graceMs?: number; limit?: number; now?: Date } = {},
): Promise<ReclaimedTask[]> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.graceMs ?? 3_000));
  const limit = options.limit ?? 50;

  const expired = await prisma.workerLease.findMany({
    where: { releasedAt: null, expiresAt: { lt: cutoff } },
    orderBy: { expiresAt: 'asc' },
    take: limit,
    select: { id: true, taskRunId: true, attemptNumber: true, workerId: true },
  });

  const reclaimed: ReclaimedTask[] = [];

  for (const lease of expired) {
    const result = await withTransaction(prisma, async (tx) => {
      await tx.$queryRaw`SELECT id FROM task_run WHERE id = ${lease.taskRunId}::uuid FOR UPDATE`;

      // Re-check under the lock: the worker may have completed in the interim.
      const stillExpired = await tx.workerLease.updateMany({
        where: { id: lease.id, releasedAt: null, expiresAt: { lt: cutoff } },
        data: { releasedAt: now, releaseReason: 'lease-expired' },
      });
      if (stillExpired.count === 0) return null;

      const task = await tx.taskRun.findUnique({
        where: { id: lease.taskRunId },
        select: {
          id: true,
          workflowRunId: true,
          nodeKey: true,
          state: true,
          attempts: true,
          run: { select: { state: true, cancelRequested: true } },
        },
      });
      if (!task) return null;

      await tx.taskAttempt.updateMany({
        where: {
          taskRunId: lease.taskRunId,
          attemptNumber: lease.attemptNumber,
          state: TaskAttemptState.RUNNING,
        },
        data: {
          state: TaskAttemptState.ABANDONED,
          errorCode: 'LEASE_EXPIRED',
          errorMessage: 'worker stopped renewing its lease; attempt reclaimed by the control plane',
          finishedAt: now,
        },
      });

      // Decrement the worker's active count so the fleet view stays honest even for a
      // process that will never report again.
      await tx.worker
        .update({
          where: { id: lease.workerId },
          data: { activeTasks: { decrement: 1 } },
        })
        .catch(() => undefined);

      await recordEvent(tx, {
        workflowRunId: task.workflowRunId,
        type: ExecutionEventType.LEASE_EXPIRED,
        taskRunId: task.id,
        nodeKey: task.nodeKey,
        workerId: lease.workerId,
        attemptNumber: lease.attemptNumber,
        message:
          'lease for ' +
          task.nodeKey +
          ' attempt ' +
          lease.attemptNumber +
          ' expired (worker ' +
          lease.workerId.slice(0, 8) +
          ')',
      });

      // Only requeue if the task is still RUNNING this attempt and the run is live.
      const runLive =
        !task.run.cancelRequested &&
        task.run.state !== WorkflowRunState.SUCCEEDED &&
        task.run.state !== WorkflowRunState.FAILED &&
        task.run.state !== WorkflowRunState.CANCELLED &&
        task.run.state !== WorkflowRunState.TIMED_OUT;

      if ((task.state as TaskRunState) !== TaskRunState.RUNNING || !runLive) {
        return {
          taskRunId: task.id,
          workflowRunId: task.workflowRunId,
          nodeKey: task.nodeKey,
          workerId: lease.workerId,
          attemptNumber: lease.attemptNumber,
          requeued: false,
        };
      }

      assertTaskTransition(TaskRunState.RUNNING, TaskRunState.QUEUED);
      await tx.taskRun.updateMany({
        where: { id: task.id, state: TaskRunState.RUNNING },
        data: {
          state: TaskRunState.QUEUED,
          workerId: null,
          recoveries: { increment: 1 },
          queuedAt: now,
        },
      });

      await recordEvent(tx, {
        workflowRunId: task.workflowRunId,
        type: ExecutionEventType.TASK_RECOVERED,
        taskRunId: task.id,
        nodeKey: task.nodeKey,
        attemptNumber: lease.attemptNumber,
        message: task.nodeKey + ' returned to the queue for another worker',
        payload: { previousWorkerId: lease.workerId },
      });

      // Re-dispatch through the outbox so recovery uses exactly the same delivery path
      // as an ordinary dispatch — one code path, one set of guarantees.
      await signalAdvance(tx, task.workflowRunId, 'lease-recovered');
      await requeueTaskDispatch(tx, task.id);

      return {
        taskRunId: task.id,
        workflowRunId: task.workflowRunId,
        nodeKey: task.nodeKey,
        workerId: lease.workerId,
        attemptNumber: lease.attemptNumber,
        requeued: true,
      };
    });

    if (result) reclaimed.push(result);
  }

  return reclaimed;
}

/** Emit a dispatch intent for a task that is already in QUEUED. */
export async function requeueTaskDispatch(tx: Tx, taskRunId: string): Promise<void> {
  const task = await tx.taskRun.findUnique({
    where: { id: taskRunId },
    select: {
      id: true,
      workflowRunId: true,
      nodeKey: true,
      type: true,
      queue: true,
      attempts: true,
    },
  });
  if (!task) return;

  const { randomUUID } = await import('node:crypto');
  const { enqueueOutbox } = await import('../outbox');
  await enqueueOutbox(tx, {
    type: 'TASK_DISPATCH',
    aggregateType: 'task_run',
    aggregateId: task.id,
    payload: {
      kind: 'task.dispatch',
      taskRunId: task.id,
      workflowRunId: task.workflowRunId,
      nodeKey: task.nodeKey,
      type: task.type,
      queue: task.queue,
      expectedAttempt: task.attempts + 1,
      dispatchId: randomUUID(),
    },
  });
}

/**
 * Tasks whose retry backoff has elapsed. Swept on a short interval; the advance path
 * also picks these up, so a missed sweep costs latency rather than correctness.
 */
export async function findDueRetries(prisma: PrismaClient, limit = 100): Promise<string[]> {
  const rows = await prisma.taskRun.findMany({
    where: { state: TaskRunState.RETRYING, nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
    select: { workflowRunId: true },
    distinct: ['workflowRunId'],
  });
  return rows.map((r) => r.workflowRunId);
}

/** Queue depth by logical queue, straight from the durable state. */
export async function queueDepths(prisma: PrismaClient): Promise<Record<string, number>> {
  const rows = await prisma.taskRun.groupBy({
    by: ['queue'],
    where: { state: TaskRunState.QUEUED },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.queue, r._count._all]));
}
