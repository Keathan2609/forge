import {
  createRun,
  findDueRetries,
  findTimedOutRuns,
  advance,
  claimScheduleOccurrence,
  findDueSchedules,
  markUnresponsiveWorkers,
  pruneDeadWorkers,
  pruneIdempotencyRecords,
  pruneOutbox,
  recordScheduleRun,
  reclaimExpiredLeases,
  type PrismaClient,
} from '@forge/database';
import type { Logger } from '@forge/logger';
import { ATTR, withSpan, type ForgeMetrics } from '@forge/observability';

/**
 * The sweepers.
 *
 * These are the loops that make FORGE self-healing rather than merely event-driven. Each
 * one exists because there is a failure mode where no event will ever arrive:
 *
 *   reaper        a worker died, so nothing will report the task's outcome
 *   retry sweeper a backoff elapsed, and nothing is watching the clock but us
 *   run timeout   a run is stuck on work no worker can execute
 *   liveness      a worker stopped heartbeating
 *   maintenance   published outbox rows and expired idempotency keys accumulate forever
 *
 * They are all idempotent and safe to run on several replicas at once.
 */

export interface SweeperDeps {
  prisma: PrismaClient;
  logger: Logger;
  metrics: ForgeMetrics;
}

// ---------------------------------------------------------------------------
// Lease reaper
// ---------------------------------------------------------------------------

export function createLeaseReaper(deps: SweeperDeps & { graceMs: number; batchSize?: number }) {
  return async function reap(): Promise<number> {
    const reclaimed = await reclaimExpiredLeases(deps.prisma, {
      graceMs: deps.graceMs,
      limit: deps.batchSize ?? 50,
    });
    if (reclaimed.length === 0) return 0;

    for (const task of reclaimed) {
      deps.metrics.leaseRecoveries.inc({ workflow: 'all', node: task.nodeKey });
      deps.logger.warn(
        {
          workflowRunId: task.workflowRunId,
          taskRunId: task.taskRunId,
          nodeKey: task.nodeKey,
          workerId: task.workerId,
          attempt: task.attemptNumber,
          requeued: task.requeued,
        },
        task.requeued
          ? 'lease expired; task returned to the queue for another worker'
          : 'lease expired; task was already resolved, nothing to recover',
      );
    }
    return reclaimed.length;
  };
}

// ---------------------------------------------------------------------------
// Retry sweeper
// ---------------------------------------------------------------------------

export function createRetrySweeper(deps: SweeperDeps & { batchSize?: number }) {
  return async function sweepRetries(): Promise<number> {
    const runIds = await findDueRetries(deps.prisma, deps.batchSize ?? 100);
    if (runIds.length === 0) return 0;

    let advanced = 0;
    for (const runId of runIds) {
      // Advancing is what actually re-queues the task; this loop only decides *when*.
      const result = await advance(deps.prisma, runId);
      if (result.applied) {
        advanced += 1;
        deps.metrics.taskRetries.inc({ workflow: 'all', node: 'all' }, result.dispatches);
      }
    }
    if (advanced > 0) deps.logger.info({ runs: advanced }, 'retries dispatched');
    return advanced;
  };
}

// ---------------------------------------------------------------------------
// Run timeout sweeper
// ---------------------------------------------------------------------------

export function createRunTimeoutSweeper(deps: SweeperDeps) {
  return async function sweepTimeouts(): Promise<number> {
    const runIds = await findTimedOutRuns(deps.prisma, 25);
    if (runIds.length === 0) return 0;

    let timedOut = 0;
    for (const runId of runIds) {
      const result = await advance(deps.prisma, runId);
      if (result.finished) {
        timedOut += 1;
        deps.logger.warn(
          { workflowRunId: runId, state: result.runState },
          'run exceeded its timeout',
        );
      }
    }
    return timedOut;
  };
}

// ---------------------------------------------------------------------------
// Worker liveness
// ---------------------------------------------------------------------------

export function createLivenessSweeper(
  deps: SweeperDeps & { livenessMs: number; pruneAfterMs: number },
) {
  return async function sweepWorkers(): Promise<number> {
    const marked = await markUnresponsiveWorkers(deps.prisma, deps.livenessMs);
    if (marked > 0) deps.logger.warn({ workers: marked }, 'workers marked unresponsive');
    const pruned = await pruneDeadWorkers(deps.prisma, deps.pruneAfterMs);
    if (pruned > 0) deps.logger.info({ workers: pruned }, 'stale worker records pruned');
    return marked + pruned;
  };
}

// ---------------------------------------------------------------------------
// Cron scheduler
// ---------------------------------------------------------------------------

/**
 * Fire due schedules.
 *
 * Runs on every replica; `claimScheduleOccurrence` uses a conditional update on the
 * occurrence key so exactly one replica wins each occurrence. There is deliberately no
 * leader election: a conditional UPDATE is simpler, has no failover window, and cannot
 * produce a split brain.
 */
export function createCronScheduler(deps: SweeperDeps) {
  return async function fireSchedules(): Promise<number> {
    const due = await findDueSchedules(deps.prisma, new Date(), 25);
    if (due.length === 0) return 0;

    let fired = 0;
    for (const schedule of due) {
      const claimed = await claimScheduleOccurrence(deps.prisma, schedule);
      if (!claimed) continue;

      try {
        const result = await withSpan(
          'schedule.fire',
          { [ATTR.workflowKey]: schedule.workflowKey, 'forge.schedule.id': schedule.id },
          async () =>
            createRun(deps.prisma, {
              workflowKey: schedule.workflowKey,
              input: schedule.input,
              triggeredBy: 'schedule:' + schedule.name,
              scheduleId: schedule.id,
              // Occurrence-scoped key: a duplicate claim (or a manual re-fire of the
              // same occurrence) can never create a second run.
              idempotencyKey: 'schedule:' + schedule.id + ':' + schedule.occurrence.toISOString(),
            }),
        );
        await recordScheduleRun(deps.prisma, schedule.id, result.runId);
        fired += 1;
        deps.logger.info(
          {
            scheduleId: schedule.id,
            name: schedule.name,
            workflowKey: schedule.workflowKey,
            workflowRunId: result.runId,
            occurrence: schedule.occurrence.toISOString(),
          },
          'schedule fired',
        );
      } catch (err) {
        // The occurrence is already claimed and `nextRunAt` advanced, so a failure here
        // skips one occurrence rather than wedging the schedule. Loudly logged because
        // it means a workflow that should have run did not.
        deps.logger.error(
          { scheduleId: schedule.id, err: (err as Error).message },
          'schedule fired but the run could not be created',
        );
      }
    }
    return fired;
  };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export function createMaintenanceSweeper(deps: SweeperDeps & { outboxRetentionMs: number }) {
  return async function maintain(): Promise<number> {
    const [outbox, idempotency] = await Promise.all([
      pruneOutbox(deps.prisma, deps.outboxRetentionMs),
      pruneIdempotencyRecords(deps.prisma),
    ]);
    if (outbox + idempotency > 0) {
      deps.logger.info(
        { outboxRows: outbox, idempotencyRecords: idempotency },
        'maintenance pruned rows',
      );
    }
    // Maintenance always sleeps its full interval; returning 0 prevents the loop from
    // treating a big prune as a reason to immediately run again.
    return 0;
  };
}
