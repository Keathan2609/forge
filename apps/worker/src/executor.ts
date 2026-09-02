import { ExecutionEventType, type TaskDispatchMessage } from '@forge/contracts';
import {
  claimTask,
  completeTask,
  failTask,
  renewLease,
  recordEvent,
  withTransaction,
  type ClaimedTask,
  type PrismaClient,
} from '@forge/database';
import { withContext, type Logger } from '@forge/logger';
import {
  ATTR,
  currentSpanId,
  currentTraceId,
  withExtractedContext,
  withSpan,
  type ForgeMetrics,
} from '@forge/observability';
import type { Transport } from '@forge/transport';
import { NonRetryableError, UnknownHandlerError, type HandlerRegistry } from './handlers/registry';

/**
 * Task execution.
 *
 * The lifecycle of one attempt, and why each step is where it is:
 *
 *   1. claim         — an atomic DB transaction; losing the race here is normal and cheap
 *   2. heartbeat     — renews the lease on a timer; a failed renewal aborts the work
 *   3. execute       — the handler runs with an AbortSignal bounded by timeout AND lease
 *   4. report        — completion re-checks lease ownership before writing anything
 *
 * Step 4 is the subtle one. A worker that was paused past its lease expiry will find the
 * lease gone and must discard its result, because by then another worker may already
 * have recovered and re-run the task. Trusting the local view instead would let a slow
 * worker overwrite a newer, correct result.
 */

export interface ExecutorOptions {
  prisma: PrismaClient;
  transport: Transport;
  logger: Logger;
  metrics: ForgeMetrics;
  registry: HandlerRegistry;
  workerId: string;
  leaseTtlMs: number;
  heartbeatMs: number;
}

export type ExecutionOutcome =
  | { status: 'succeeded'; durationMs: number }
  | { status: 'failed'; durationMs: number; retrying: boolean }
  | { status: 'skipped'; reason: string }
  | { status: 'lease-lost' };

export class TaskExecutor {
  /** Tasks this worker currently holds, for graceful shutdown and the fleet view. */
  private readonly inFlight = new Map<string, { abort: AbortController; nodeKey: string }>();

  constructor(private readonly options: ExecutorOptions) {}

  get activeCount(): number {
    return this.inFlight.size;
  }

  /** Abort everything in flight — used when shutdown grace expires. */
  abortAll(reason: string): void {
    for (const [, entry] of this.inFlight) entry.abort.abort(new Error(reason));
  }

  async execute(message: TaskDispatchMessage): Promise<ExecutionOutcome> {
    const { options } = this;

    return withExtractedContext(message.trace, async () =>
      withSpan(
        'task.execute',
        {
          [ATTR.taskRunId]: message.taskRunId,
          [ATTR.runId]: message.workflowRunId,
          [ATTR.nodeKey]: message.nodeKey,
          [ATTR.taskType]: message.type,
          [ATTR.queue]: message.queue,
          [ATTR.workerId]: options.workerId,
        },
        async () => this.claimAndRun(message),
      ),
    );
  }

  private async claimAndRun(message: TaskDispatchMessage): Promise<ExecutionOutcome> {
    const { prisma, logger, metrics, registry, workerId } = this.options;

    const claim = await claimTask(prisma, {
      taskRunId: message.taskRunId,
      workerId,
      leaseTtlMs: this.options.leaseTtlMs,
      dispatchId: message.dispatchId,
      ...(currentTraceId() ? { traceId: currentTraceId() as string } : {}),
      ...(currentSpanId() ? { spanId: currentSpanId() as string } : {}),
    });

    metrics.claimAttempts.inc({ result: claim.ok ? 'claimed' : claim.reason });

    if (!claim.ok) {
      // Every one of these is normal under at-least-once delivery: a duplicate message,
      // a task another worker already took, or a run that finished in the meantime.
      logger.debug(
        { taskRunId: message.taskRunId, nodeKey: message.nodeKey, reason: claim.reason },
        'dispatch not claimable, discarding',
      );
      return { status: 'skipped', reason: claim.reason };
    }

    const task = claim.task;
    const taskLogger = withContext(logger, {
      workflowRunId: task.workflowRunId,
      taskRunId: task.taskRunId,
      nodeKey: task.nodeKey,
      workerId,
      attempt: task.attemptNumber,
      ...(task.traceId ? { traceId: task.traceId } : {}),
    });

    metrics.tasksStarted.inc({
      workflow: task.workflowKey,
      node: task.nodeKey,
      type: task.type,
    });

    taskLogger.info(
      { type: task.type, timeoutMs: task.timeoutMs },
      'claimed ' + task.nodeKey + ' (attempt ' + task.attemptNumber + ')',
    );

    const abort = new AbortController();
    this.inFlight.set(task.taskRunId, { abort, nodeKey: task.nodeKey });

    const startedAt = Date.now();
    let cancelled = false;

    // --- lease heartbeat --------------------------------------------------
    // Renews on a timer well inside the TTL. A renewal that fails means the lease is
    // gone: the work is aborted immediately rather than continuing on borrowed time.
    const heartbeat = setInterval(() => {
      void (async (): Promise<void> => {
        try {
          const result = await renewLease(this.options.prisma, {
            taskRunId: task.taskRunId,
            attemptNumber: task.attemptNumber,
            workerId,
            ttlMs: this.options.leaseTtlMs,
          });
          if (!result.renewed) {
            taskLogger.warn('lease lost; aborting in-flight work');
            abort.abort(new Error('lease lost'));
            return;
          }
          metrics.leaseRenewals.inc();
          if (result.cancelRequested && !cancelled) {
            cancelled = true;
            taskLogger.info('cancellation requested; signalling the handler to stop');
            abort.abort(new Error('run cancelled'));
          }
        } catch (err) {
          // A transient database blip must not abort the task: the lease outlives
          // several missed renewals by design.
          taskLogger.warn({ err: (err as Error).message }, 'lease renewal failed, will retry');
        }
      })();
    }, this.options.heartbeatMs);

    // --- timeout ----------------------------------------------------------
    const timeout = setTimeout(() => {
      abort.abort(new Error('task timeout of ' + task.timeoutMs + 'ms exceeded'));
    }, task.timeoutMs);

    try {
      const handler = registry.get(task.type);

      const output = await handler.handler(task.input, {
        workflowRunId: task.workflowRunId,
        taskRunId: task.taskRunId,
        workflowKey: task.workflowKey,
        nodeKey: task.nodeKey,
        attempt: task.attemptNumber,
        workerId,
        logger: taskLogger,
        signal: abort.signal,
        isCancelled: () => cancelled,
        progress: (percent, progressMessage) => {
          void this.recordProgress(task, percent, progressMessage).catch(() => undefined);
        },
      });

      clearInterval(heartbeat);
      clearTimeout(timeout);

      const durationMs = Date.now() - startedAt;
      const result = await completeTask(this.options.prisma, {
        taskRunId: task.taskRunId,
        attemptNumber: task.attemptNumber,
        workerId,
        output,
      });

      if (!result.ok) {
        // The lease was reclaimed while the handler ran. Discarding is the correct and
        // only safe action: another worker may already have produced a result.
        taskLogger.warn(
          { reason: result.reason, durationMs },
          'completed work discarded — the lease was no longer ours',
        );
        metrics.taskDuration.observe(
          { workflow: task.workflowKey, node: task.nodeKey, type: task.type, outcome: 'discarded' },
          durationMs / 1000,
        );
        return { status: 'lease-lost' };
      }

      metrics.tasksCompleted.inc({
        workflow: task.workflowKey,
        node: task.nodeKey,
        type: task.type,
      });
      metrics.taskDuration.observe(
        { workflow: task.workflowKey, node: task.nodeKey, type: task.type, outcome: 'succeeded' },
        durationMs / 1000,
      );
      taskLogger.info({ durationMs }, task.nodeKey + ' completed');
      return { status: 'succeeded', durationMs };
    } catch (err) {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      return this.reportFailure(task, err, startedAt, abort, cancelled, taskLogger);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      this.inFlight.delete(task.taskRunId);
    }
  }

  private async reportFailure(
    task: ClaimedTask,
    err: unknown,
    startedAt: number,
    abort: AbortController,
    cancelled: boolean,
    taskLogger: Logger,
  ): Promise<ExecutionOutcome> {
    const { metrics, workerId } = this.options;
    const durationMs = Date.now() - startedAt;
    const error = err as Error & { code?: string };

    // Distinguish the three ways an abort can happen — they have different meanings and
    // different retry semantics, and collapsing them would make the timeline lie.
    const abortReason = (abort.signal.reason as Error | undefined)?.message ?? '';
    const timedOut = abortReason.includes('timeout');
    const leaseLost = abortReason.includes('lease lost');

    if (leaseLost) {
      taskLogger.warn(
        { durationMs },
        'aborted because the lease was lost; leaving recovery to the reaper',
      );
      return { status: 'lease-lost' };
    }

    const errorCode =
      err instanceof UnknownHandlerError
        ? err.code
        : err instanceof NonRetryableError
          ? err.code
          : timedOut
            ? 'TASK_TIMEOUT'
            : cancelled
              ? 'CANCELLED'
              : (error.code ?? 'TASK_FAILED');

    const errorMessage = timedOut
      ? 'task exceeded its ' + task.timeoutMs + 'ms timeout'
      : (error.message ?? String(err));

    const result = await failTask(this.options.prisma, {
      taskRunId: task.taskRunId,
      attemptNumber: task.attemptNumber,
      workerId,
      errorCode,
      errorMessage,
      ...(error.stack ? { errorStack: error.stack } : {}),
      timedOut,
    });

    metrics.tasksFailed.inc({
      workflow: task.workflowKey,
      node: task.nodeKey,
      type: task.type,
      code: errorCode,
    });
    metrics.taskDuration.observe(
      {
        workflow: task.workflowKey,
        node: task.nodeKey,
        type: task.type,
        outcome: timedOut ? 'timed_out' : 'failed',
      },
      durationMs / 1000,
    );

    if (!result.ok) {
      taskLogger.warn({ reason: result.reason }, 'failure report discarded — lease no longer ours');
      return { status: 'lease-lost' };
    }

    if (result.decision === 'retry') {
      metrics.taskRetries.inc({ workflow: task.workflowKey, node: task.nodeKey });
      taskLogger.warn(
        { errorCode, durationMs, nextAttemptAt: result.nextAttemptAt?.toISOString() },
        task.nodeKey + ' failed, retry scheduled',
      );
    } else if (result.decision === 'dead-letter') {
      metrics.deadLetters.inc({ workflow: task.workflowKey, node: task.nodeKey });
      taskLogger.error(
        { errorCode, attempts: result.attemptsUsed },
        task.nodeKey + ' dead-lettered after exhausting its retry budget',
      );
    } else {
      taskLogger.error({ errorCode }, task.nodeKey + ' failed permanently');
    }

    return { status: 'failed', durationMs, retrying: result.decision === 'retry' };
  }

  /**
   * Persist a progress update.
   *
   * Written to the event log rather than mutating the task row: progress is a stream of
   * observations, and overwriting a column would lose the shape of a task that stalled
   * at 60% before failing.
   */
  private async recordProgress(
    task: ClaimedTask,
    percent: number,
    message?: string,
  ): Promise<void> {
    await withTransaction(this.options.prisma, async (tx) => {
      await recordEvent(tx, {
        workflowRunId: task.workflowRunId,
        type: ExecutionEventType.TASK_PROGRESS,
        taskRunId: task.taskRunId,
        nodeKey: task.nodeKey,
        workerId: this.options.workerId,
        attemptNumber: task.attemptNumber,
        message: message ?? task.nodeKey + ' ' + percent + '%',
        payload: { percent },
      });
    });
  }
}
