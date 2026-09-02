import { OutboxEventType, QUEUES, QueueMessageSchema } from '@forge/contracts';
import {
  claimOutboxBatch,
  markOutboxFailed,
  markOutboxPublished,
  withTransaction,
  type PrismaClient,
} from '@forge/database';
import type { Logger } from '@forge/logger';
import type { ForgeMetrics } from '@forge/observability';
import { ATTR, withSpan } from '@forge/observability';
import type { Transport } from '@forge/transport';

/**
 * The outbox publisher.
 *
 * Moves committed intents from PostgreSQL to Redis. The ordering here is the entire
 * point and is deliberately *not* the obvious one:
 *
 *   1. claim rows with `FOR UPDATE SKIP LOCKED` (no write yet)
 *   2. push to Redis
 *   3. mark PUBLISHED and commit
 *
 * Marking before pushing would lose messages whenever the push failed. Doing it this way
 * means a crash between (2) and (3) republishes on the next tick — a duplicate, which
 * every consumer already tolerates because it re-reads the durable state before acting.
 * Duplicate delivery is a cost we can absorb; a lost dispatch is a stuck workflow.
 */

export interface OutboxPublisherOptions {
  prisma: PrismaClient;
  transport: Transport;
  logger: Logger;
  metrics: ForgeMetrics;
  batchSize: number;
  maxAttempts: number;
}

export function createOutboxPublisher(options: OutboxPublisherOptions) {
  const { prisma, transport, logger, metrics } = options;

  return async function publishBatch(): Promise<number> {
    return withTransaction(
      prisma,
      async (tx) => {
        const rows = await claimOutboxBatch(tx, options.batchSize);
        if (rows.length === 0) return 0;

        return withSpan(
          'outbox.publish',
          { [ATTR.batchSize]: rows.length },
          async (): Promise<number> => {
            const published: string[] = [];

            for (const row of rows) {
              try {
                // Validate on the way out. A payload that cannot be parsed would be
                // rejected by the consumer anyway; failing it here keeps the poison
                // message out of the queue and records why.
                const message = QueueMessageSchema.parse(row.payload);

                const queue =
                  row.type === OutboxEventType.TASK_DISPATCH && message.kind === 'task.dispatch'
                    ? QUEUES.taskDispatch(message.queue)
                    : QUEUES.runAdvance;

                await transport.push(queue, message);
                published.push(row.id);
                metrics.outboxPublished.inc({ type: row.type });
              } catch (err) {
                metrics.outboxFailures.inc({ type: row.type });
                logger.warn(
                  {
                    outboxId: row.id,
                    type: row.type,
                    aggregateId: row.aggregateId,
                    attempts: row.attempts,
                    err: (err as Error).message,
                  },
                  'outbox publish failed',
                );
                await markOutboxFailed(
                  tx,
                  row.id,
                  (err as Error).message,
                  row.attempts,
                  options.maxAttempts,
                );
              }
            }

            await markOutboxPublished(tx, published);

            if (published.length > 0) {
              logger.debug({ count: published.length }, 'outbox batch published');
            }
            return published.length;
          },
        );
      },
      // A large batch that has to reach Redis for every row needs longer than the
      // default; the claim holds row locks for the whole window, so it is also kept
      // deliberately bounded rather than unlimited.
      { timeout: 30_000 },
    );
  };
}
