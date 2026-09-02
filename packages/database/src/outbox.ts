import { type OutboxEventType, type QueueMessage } from '@forge/contracts';
import { type Prisma, type PrismaClient, type Tx } from './client';

/**
 * Transactional outbox.
 *
 * The failure this exists to prevent:
 *
 *   1. BEGIN; UPDATE task_run SET state='QUEUED'; COMMIT;
 *   2. process crashes
 *   3. redis.lpush(...) never happens
 *   4. the task sits QUEUED forever with nothing to deliver it
 *
 * Writing the intent to `outbox_event` inside the same transaction makes the state
 * change and the intent-to-publish atomic. A separate publisher then moves rows to
 * Redis and marks them PUBLISHED. If the publisher crashes between the push and the
 * mark, the row is republished — which is why every consumer must tolerate duplicates.
 * That is the honest at-least-once boundary; see docs/adr/005-delivery-semantics.md.
 */

export interface OutboxWrite {
  type: (typeof OutboxEventType)[keyof typeof OutboxEventType];
  aggregateType: 'workflow_run' | 'task_run' | 'schedule';
  aggregateId: string;
  payload: QueueMessage | Record<string, unknown>;
  /** Delay publication, e.g. for a scheduled retry. */
  availableAt?: Date;
}

/** Enqueue one outbox row. MUST be called with the same `tx` as the state change. */
export async function enqueueOutbox(tx: Tx, write: OutboxWrite): Promise<string> {
  const row = await tx.outboxEvent.create({
    data: {
      type: write.type,
      aggregateType: write.aggregateType,
      aggregateId: write.aggregateId,
      payload: write.payload as Prisma.InputJsonValue,
      availableAt: write.availableAt ?? new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

export async function enqueueOutboxMany(tx: Tx, writes: OutboxWrite[]): Promise<number> {
  if (writes.length === 0) return 0;
  const result = await tx.outboxEvent.createMany({
    data: writes.map((w) => ({
      type: w.type,
      aggregateType: w.aggregateType,
      aggregateId: w.aggregateId,
      payload: w.payload as Prisma.InputJsonValue,
      availableAt: w.availableAt ?? new Date(),
    })),
  });
  return result.count;
}

export interface ClaimedOutboxRow {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
}

/**
 * Claim a batch of publishable rows.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets N publisher replicas run concurrently without
 * coordination: each grabs a disjoint set of rows, and a publisher that dies mid-batch
 * releases its locks on disconnect so another picks the rows up on the next tick.
 *
 * The claim marks nothing — rows stay PENDING until the push to Redis actually
 * succeeds. Marking first would silently drop messages whenever the push failed.
 */
export async function claimOutboxBatch(
  tx: Tx,
  limit: number,
  now: Date = new Date(),
): Promise<ClaimedOutboxRow[]> {
  return tx.$queryRaw<ClaimedOutboxRow[]>`
    SELECT id, type::text AS type, "aggregateType", "aggregateId", payload, attempts
    FROM outbox_event
    WHERE status = 'PENDING' AND "availableAt" <= ${now}
    ORDER BY "createdAt" ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `;
}

export async function markOutboxPublished(tx: Tx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await tx.outboxEvent.updateMany({
    where: { id: { in: ids } },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });
  return result.count;
}

/**
 * Record a failed publish and schedule a retry.
 *
 * After `maxAttempts` the row is parked as FAILED rather than retried forever: a row
 * that has failed ten times is a bug or a poison payload, and hammering it starves the
 * rows behind it.
 */
export async function markOutboxFailed(
  tx: Tx,
  id: string,
  error: string,
  attempts: number,
  maxAttempts: number,
): Promise<void> {
  const exhausted = attempts + 1 >= maxAttempts;
  const backoffMs = Math.min(30_000, 250 * Math.pow(2, attempts));
  await tx.outboxEvent.update({
    where: { id },
    data: {
      attempts: attempts + 1,
      lastError: error.slice(0, 1000),
      status: exhausted ? 'FAILED' : 'PENDING',
      availableAt: new Date(Date.now() + backoffMs),
    },
  });
}

export interface OutboxHealth {
  pending: number;
  failed: number;
  oldestPendingAgeMs: number | null;
}

/**
 * Outbox lag is the single best indicator that the control plane is unhealthy: if
 * `oldestPendingAgeMs` grows, dispatches are not reaching workers regardless of what
 * every other metric says.
 */
export async function outboxHealth(prisma: PrismaClient): Promise<OutboxHealth> {
  const [pending, failed, oldest] = await Promise.all([
    prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
    prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
    prisma.outboxEvent.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  return {
    pending,
    failed,
    oldestPendingAgeMs: oldest ? Date.now() - oldest.createdAt.getTime() : null,
  };
}

/** Requeue rows parked as FAILED. Exposed through the CLI for operator recovery. */
export async function requeueFailedOutbox(prisma: PrismaClient, limit = 500): Promise<number> {
  const rows = await prisma.outboxEvent.findMany({
    where: { status: 'FAILED' },
    select: { id: true },
    take: limit,
  });
  if (rows.length === 0) return 0;
  const result = await prisma.outboxEvent.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: 'PENDING', attempts: 0, availableAt: new Date(), lastError: null },
  });
  return result.count;
}

/**
 * Delete published rows older than the retention window.
 *
 * The outbox is a queue, not a log — `execution_event` is the audit trail. Left
 * unpruned this table becomes the largest in the database and slows the publisher's
 * index scan for no benefit.
 */
export async function pruneOutbox(prisma: PrismaClient, olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await prisma.outboxEvent.deleteMany({
    where: { status: 'PUBLISHED', publishedAt: { lt: cutoff } },
  });
  return result.count;
}
