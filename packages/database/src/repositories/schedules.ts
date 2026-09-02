import parser from 'cron-parser';
import { type Prisma, type PrismaClient, withTransaction } from '../client';

/**
 * Durable schedules.
 *
 * Schedules live in PostgreSQL rather than in an OS cron or an in-memory timer for two
 * reasons: a restart must not lose them, and several control-plane replicas must not
 * each fire the same occurrence. The second is handled by `lastFiredKey` — the ISO
 * timestamp of the occurrence that was fired — combined with a conditional update, so
 * only one replica can claim any given occurrence.
 */

export class InvalidCronError extends Error {
  constructor(
    readonly expression: string,
    cause: string,
  ) {
    super('invalid cron expression "' + expression + '": ' + cause);
    this.name = 'InvalidCronError';
  }
}

export function computeNextRun(cron: string, timezone: string, after: Date = new Date()): Date {
  try {
    const interval = parser.parseExpression(cron, { currentDate: after, tz: timezone });
    return interval.next().toDate();
  } catch (err) {
    throw new InvalidCronError(cron, (err as Error).message);
  }
}

export function validateCron(
  cron: string,
  timezone = 'UTC',
): { ok: true } | { ok: false; message: string } {
  try {
    computeNextRun(cron, timezone);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export interface CreateScheduleInput {
  workflowKey: string;
  name: string;
  cron?: string;
  runAt?: Date;
  timezone?: string;
  input?: Record<string, unknown>;
  enabled?: boolean;
}

export async function createSchedule(
  prisma: PrismaClient,
  input: CreateScheduleInput,
): Promise<{ id: string; nextRunAt: Date | null } | null> {
  const definition = await prisma.workflowDefinition.findUnique({
    where: { key: input.workflowKey },
    select: { id: true },
  });
  if (!definition) return null;

  const timezone = input.timezone ?? 'UTC';
  const nextRunAt = input.cron ? computeNextRun(input.cron, timezone) : (input.runAt ?? null);

  const row = await prisma.workflowSchedule.create({
    data: {
      definitionId: definition.id,
      name: input.name,
      cron: input.cron ?? null,
      runAt: input.runAt ?? null,
      timezone,
      input: (input.input ?? {}) as Prisma.InputJsonValue,
      enabled: input.enabled ?? true,
      nextRunAt,
    },
    select: { id: true, nextRunAt: true },
  });
  return row;
}

export async function setScheduleEnabled(
  prisma: PrismaClient,
  scheduleId: string,
  enabled: boolean,
): Promise<boolean> {
  const schedule = await prisma.workflowSchedule.findUnique({
    where: { id: scheduleId },
    select: { cron: true, timezone: true, runAt: true },
  });
  if (!schedule) return false;

  // Resuming recomputes the next occurrence from now: replaying every occurrence that
  // elapsed while the schedule was paused is almost never the intent, and for a
  // long pause it would be a stampede.
  const nextRunAt = enabled
    ? schedule.cron
      ? computeNextRun(schedule.cron, schedule.timezone)
      : schedule.runAt
    : null;

  await prisma.workflowSchedule.update({
    where: { id: scheduleId },
    data: { enabled, nextRunAt },
  });
  return true;
}

export interface DueSchedule {
  id: string;
  definitionId: string;
  workflowKey: string;
  name: string;
  cron: string | null;
  timezone: string;
  input: Record<string, unknown>;
  occurrence: Date;
}

/** Schedules whose next occurrence has arrived. */
export async function findDueSchedules(
  prisma: PrismaClient,
  now: Date = new Date(),
  limit = 50,
): Promise<DueSchedule[]> {
  const rows = await prisma.workflowSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: 'asc' },
    take: limit,
    select: {
      id: true,
      definitionId: true,
      name: true,
      cron: true,
      timezone: true,
      input: true,
      nextRunAt: true,
      definition: { select: { key: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    definitionId: r.definitionId,
    workflowKey: r.definition.key,
    name: r.name,
    cron: r.cron,
    timezone: r.timezone,
    input: (r.input ?? {}) as Record<string, unknown>,
    occurrence: r.nextRunAt as Date,
  }));
}

/**
 * Claim an occurrence for firing.
 *
 * The conditional `lastFiredKey` predicate is what makes this safe with N schedulers:
 * exactly one update matches, and the losers get `count === 0` and skip. The next
 * occurrence is computed and stored in the same statement, so a scheduler that dies
 * immediately after claiming leaves the schedule correctly advanced rather than stuck.
 */
export async function claimScheduleOccurrence(
  prisma: PrismaClient,
  schedule: DueSchedule,
  now: Date = new Date(),
): Promise<boolean> {
  const occurrenceKey = schedule.occurrence.toISOString();
  const nextRunAt = schedule.cron ? computeNextRun(schedule.cron, schedule.timezone, now) : null;

  const result = await prisma.workflowSchedule.updateMany({
    where: {
      id: schedule.id,
      enabled: true,
      // Whoever writes this key first owns the occurrence.
      OR: [{ lastFiredKey: null }, { lastFiredKey: { not: occurrenceKey } }],
      nextRunAt: schedule.occurrence,
    },
    data: {
      lastFiredKey: occurrenceKey,
      lastRunAt: now,
      nextRunAt,
      // A one-shot schedule disables itself once fired.
      ...(schedule.cron ? {} : { enabled: false }),
    },
  });

  return result.count > 0;
}

export async function recordScheduleRun(
  prisma: PrismaClient,
  scheduleId: string,
  runId: string,
): Promise<void> {
  await prisma.workflowSchedule.updateMany({
    where: { id: scheduleId },
    data: { lastRunId: runId },
  });
}

/** Recompute `nextRunAt` for every enabled cron schedule. Run at scheduler start. */
export async function reconcileSchedules(prisma: PrismaClient): Promise<number> {
  const schedules = await prisma.workflowSchedule.findMany({
    where: { enabled: true, cron: { not: null } },
    select: { id: true, cron: true, timezone: true, nextRunAt: true },
  });

  let updated = 0;
  for (const schedule of schedules) {
    if (schedule.nextRunAt) continue;
    try {
      const nextRunAt = computeNextRun(schedule.cron as string, schedule.timezone);
      await prisma.workflowSchedule.update({ where: { id: schedule.id }, data: { nextRunAt } });
      updated += 1;
    } catch {
      // A schedule with an unparseable cron is disabled rather than crashing the loop.
      await prisma.workflowSchedule.update({
        where: { id: schedule.id },
        data: { enabled: false, nextRunAt: null },
      });
    }
  }
  return updated;
}

/** Delete idempotency records past their TTL. */
export async function pruneIdempotencyRecords(prisma: PrismaClient): Promise<number> {
  const result = await withTransaction(prisma, async (tx) =>
    tx.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
  );
  return result.count;
}
