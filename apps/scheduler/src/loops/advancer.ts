import { type ExecutionEventType, KEYS, QUEUES, WorkflowRunState } from '@forge/contracts';
import { advance, listEvents, type PrismaClient } from '@forge/database';
import type { Logger } from '@forge/logger';
import {
  ATTR,
  injectTraceContext,
  withExtractedContext,
  withSpan,
  type ForgeMetrics,
} from '@forge/observability';
import type { Transport } from '@forge/transport';

/**
 * The run advancer.
 *
 * Consumes `run.advance` messages and applies the engine's plan. Three properties make
 * this safe to run at any concurrency, on any number of replicas:
 *
 *   - the message is a *hint*; the plan is recomputed from PostgreSQL every time
 *   - `advance()` locks the run row, so overlapping advances serialise
 *   - a Redis lock (best effort) de-duplicates the common case cheaply, before the
 *     transaction is even opened — but correctness never depends on it
 *
 * A dropped message is not a stuck run: the retry sweeper, the reaper and the next task
 * completion all produce another advance signal.
 */

export interface AdvancerOptions {
  prisma: PrismaClient;
  transport: Transport;
  logger: Logger;
  metrics: ForgeMetrics;
  blockSeconds: number;
}

export function createAdvancer(options: AdvancerOptions) {
  const { prisma, transport, logger, metrics } = options;

  return async function consumeAdvance(): Promise<number> {
    const received = await transport.pop([QUEUES.runAdvance], options.blockSeconds);
    if (!received || received.message.kind !== 'run.advance') return 0;

    const message = received.message;

    return withExtractedContext(message.trace, async () =>
      withSpan(
        'run.advance',
        { [ATTR.runId]: message.workflowRunId, [ATTR.reason]: message.reason },
        async (): Promise<number> => {
          // Cheap de-duplication. Losing the lock means another replica is already on
          // it, so this message can be dropped — the durable state is unaffected.
          const lockKey = KEYS.runAdvanceLock(message.workflowRunId);
          const token = await transport.tryLock(lockKey, 10_000);
          if (!token) {
            logger.debug({ runId: message.workflowRunId }, 'advance already in progress, skipping');
            return 1;
          }

          const startedAt = process.hrtime.bigint();
          try {
            // Re-inject the *current* context, which is the `run.advance` span above.
            // `advance` writes this onto every task.dispatch row it emits, so the worker
            // that eventually claims the task continues this trace instead of starting a
            // new one. Dropping it here is invisible in tests — the run still executes
            // correctly — and shows up only as task spans orphaned from their trigger.
            const result = await advance(prisma, message.workflowRunId, {
              trace: injectTraceContext(),
            });
            metrics.advanceDuration.observe(
              Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
            );

            if (!result.applied) {
              logger.debug({ runId: message.workflowRunId }, 'advance was a no-op');
              return 1;
            }

            logger.info(
              {
                workflowRunId: message.workflowRunId,
                transitions: result.transitions,
                dispatches: result.dispatches,
                runState: result.runState,
                reason: message.reason,
              },
              'run advanced',
            );

            recordRunMetrics(metrics, result.runState, result.finished);

            // Fan out the events this advance produced. Best effort: subscribers that
            // miss a broadcast recover by replaying from the database by sequence number.
            await broadcastNewEvents(
              prisma,
              transport,
              message.workflowRunId,
              result.events.map((e) => e.seq),
            );

            return 1;
          } finally {
            await transport.releaseLock(lockKey, token).catch(() => undefined);
          }
        },
      ),
    );
  };
}

function recordRunMetrics(metrics: ForgeMetrics, state: WorkflowRunState, finished: boolean): void {
  if (state === WorkflowRunState.RUNNING) {
    metrics.workflowsStarted.inc({ workflow: 'all' });
    return;
  }
  if (!finished) return;
  if (state === WorkflowRunState.SUCCEEDED) {
    metrics.workflowsCompleted.inc({ workflow: 'all' });
  } else {
    metrics.workflowsFailed.inc({ workflow: 'all', reason: state });
  }
}

/**
 * Publish the events an advance just wrote.
 *
 * The events are read back rather than reconstructed from the plan so that what reaches
 * the console is byte-identical to what was persisted — a broadcast that disagrees with
 * the database is worse than no broadcast at all.
 */
async function broadcastNewEvents(
  prisma: PrismaClient,
  transport: Transport,
  workflowRunId: string,
  seqs: number[],
): Promise<void> {
  if (seqs.length === 0) return;
  const from = Math.min(...seqs) - 1;
  const events = await listEvents(prisma, { workflowRunId, afterSeq: from, limit: 200 });
  for (const event of events) {
    await transport.publishEvent({
      id: event.id,
      seq: event.seq,
      type: event.type as ExecutionEventType,
      workflowRunId: event.workflowRunId,
      taskRunId: event.taskRunId,
      nodeKey: event.nodeKey,
      workerId: event.workerId,
      attemptNumber: event.attemptNumber,
      traceId: event.traceId,
      message: event.message,
      payload: (event.payload ?? null) as Record<string, unknown> | null,
      occurredAt: event.occurredAt.toISOString(),
    });
  }
}
