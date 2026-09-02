import type {
  DashboardStatsView,
  DeadLetterView,
  Page,
  ScheduleView,
  TaskAttemptView,
  TaskRunView,
  WorkerView,
  WorkflowRunView,
  WorkflowSummaryView,
  WorkflowVersionView,
} from '@forge/contracts';
import type { WorkflowDefinition } from '@forge/contracts';
import { type Prisma, type PrismaClient } from '../client';
import { fleetSummary } from './workers';
import { outboxHealth } from '../outbox';

/**
 * Read models for the API.
 *
 * Deliberately hand-written rather than generated from the schema: every one of these
 * is a single round trip with an explicit `select`, because the console polls them and
 * a lazily-loaded relation here is an N+1 in a hot path. Where a list needs per-row
 * aggregates, they are computed in one grouped query and joined in memory rather than
 * with a correlated subquery per row.
 */

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export async function listWorkflows(prisma: PrismaClient): Promise<WorkflowSummaryView[]> {
  const definitions = await prisma.workflowDefinition.findMany({
    where: { archived: false },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      latestVersion: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { versions: true } },
    },
  });
  if (definitions.length === 0) return [];

  // One grouped query for every workflow's run counts, rather than one per row.
  const stateCounts = await prisma.workflowRun.groupBy({
    by: ['workflowKey', 'state'],
    _count: { _all: true },
    where: { workflowKey: { in: definitions.map((d) => d.key) } },
  });

  const durations = await prisma.workflowRun.groupBy({
    by: ['workflowKey'],
    _avg: { durationMs: true },
    where: { state: 'SUCCEEDED', durationMs: { not: null } },
  });

  const nodeCounts = await prisma.workflowNode.groupBy({
    by: ['versionId'],
    _count: { _all: true },
  });
  const latestVersionIds = await prisma.workflowVersion.findMany({
    where: {
      OR: definitions.map((d) => ({ definitionId: d.id, version: d.latestVersion })),
    },
    select: { id: true, definitionId: true },
  });
  const nodeCountByDefinition = new Map<string, number>();
  for (const v of latestVersionIds) {
    const count = nodeCounts.find((n) => n.versionId === v.id)?._count._all ?? 0;
    nodeCountByDefinition.set(v.definitionId, count);
  }

  return definitions.map((d) => {
    const counts = stateCounts.filter((c) => c.workflowKey === d.key);
    const get = (state: string): number => counts.find((c) => c.state === state)?._count._all ?? 0;
    const succeeded = get('SUCCEEDED');
    const failed = get('FAILED') + get('TIMED_OUT');
    const finished = succeeded + failed;

    return {
      id: d.id,
      key: d.key,
      name: d.name,
      description: d.description,
      latestVersion: d.latestVersion,
      versionCount: d._count.versions,
      nodeCount: nodeCountByDefinition.get(d.id) ?? 0,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      stats: {
        total: counts.reduce((sum, c) => sum + c._count._all, 0),
        running: get('RUNNING') + get('PENDING') + get('QUEUED'),
        succeeded,
        failed,
        successRate: finished === 0 ? null : succeeded / finished,
        p50DurationMs: durations.find((x) => x.workflowKey === d.key)?._avg.durationMs ?? null,
      },
    };
  });
}

export async function listVersions(
  prisma: PrismaClient,
  key: string,
): Promise<WorkflowVersionView[]> {
  const rows = await prisma.workflowVersion.findMany({
    where: { definitionRef: { key } },
    orderBy: { version: 'desc' },
    take: 50,
    select: {
      id: true,
      version: true,
      changelog: true,
      definition: true,
      checksum: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    changelog: r.changelog,
    definition: r.definition as unknown as WorkflowDefinition,
    checksum: r.checksum,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function emptyCounts(): WorkflowRunView['counts'] {
  return {
    total: 0,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    retrying: 0,
    deadLettered: 0,
    skipped: 0,
  };
}

function foldCounts(rows: Array<{ state: string; count: number }>): WorkflowRunView['counts'] {
  const counts = emptyCounts();
  for (const row of rows) {
    counts.total += row.count;
    switch (row.state) {
      case 'PENDING':
      case 'BLOCKED':
      case 'READY':
      case 'QUEUED':
        counts.pending += row.count;
        break;
      case 'RUNNING':
        counts.running += row.count;
        break;
      case 'RETRYING':
        counts.retrying += row.count;
        break;
      case 'SUCCEEDED':
        counts.succeeded += row.count;
        break;
      case 'DEAD_LETTERED':
        counts.deadLettered += row.count;
        counts.failed += row.count;
        break;
      case 'SKIPPED':
        counts.skipped += row.count;
        break;
      case 'FAILED':
      case 'TIMED_OUT':
      case 'CANCELLED':
        counts.failed += row.count;
        break;
      default:
        break;
    }
  }
  return counts;
}

export interface ListRunsOptions {
  workflowKey?: string;
  state?: string;
  since?: Date;
  limit?: number;
  cursor?: string;
}

/**
 * Keyset pagination on `(createdAt DESC, id DESC)`.
 *
 * OFFSET pagination degrades linearly on a table that is append-heavy and constantly
 * re-sorted; a cursor keeps every page a single index range scan regardless of depth.
 */
export async function listRuns(
  prisma: PrismaClient,
  options: ListRunsOptions = {},
): Promise<Page<WorkflowRunView>> {
  const limit = Math.min(options.limit ?? 25, 100);

  let cursorClause: Prisma.WorkflowRunWhereInput | undefined;
  if (options.cursor) {
    const anchor = await prisma.workflowRun.findUnique({
      where: { id: options.cursor },
      select: { createdAt: true, id: true },
    });
    if (anchor) {
      cursorClause = {
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ],
      };
    }
  }

  const where: Prisma.WorkflowRunWhereInput = {
    ...(options.workflowKey ? { workflowKey: options.workflowKey } : {}),
    ...(options.state ? { state: options.state as never } : {}),
    ...(options.since ? { createdAt: { gte: options.since } } : {}),
    ...(cursorClause ?? {}),
  };

  const rows = await prisma.workflowRun.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      workflowKey: true,
      workflowName: true,
      version: true,
      state: true,
      input: true,
      output: true,
      errorMessage: true,
      triggeredBy: true,
      idempotencyKey: true,
      traceId: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Task counts for the whole page in one grouped query.
  const counts =
    page.length === 0
      ? []
      : await prisma.taskRun.groupBy({
          by: ['workflowRunId', 'state'],
          where: { workflowRunId: { in: page.map((r) => r.id) } },
          _count: { _all: true },
        });

  const items: WorkflowRunView[] = page.map((r) => ({
    id: r.id,
    workflowKey: r.workflowKey,
    workflowName: r.workflowName,
    version: r.version,
    state: r.state as WorkflowRunView['state'],
    input: r.input,
    output: r.output,
    errorMessage: r.errorMessage,
    triggeredBy: r.triggeredBy,
    idempotencyKey: r.idempotencyKey,
    traceId: r.traceId,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    durationMs: r.durationMs,
    counts: foldCounts(
      counts
        .filter((c) => c.workflowRunId === r.id)
        .map((c) => ({ state: c.state as string, count: c._count._all })),
    ),
  }));

  return {
    items,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    hasMore,
  };
}

function toAttemptView(a: {
  id: string;
  attemptNumber: number;
  state: string;
  workerId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorStack: string | null;
  output: unknown;
  traceId: string | null;
}): TaskAttemptView {
  return {
    id: a.id,
    attemptNumber: a.attemptNumber,
    state: a.state as TaskAttemptView['state'],
    workerId: a.workerId,
    startedAt: a.startedAt.toISOString(),
    finishedAt: iso(a.finishedAt),
    durationMs: a.durationMs,
    errorCode: a.errorCode,
    errorMessage: a.errorMessage,
    errorStack: a.errorStack,
    output: a.output,
    traceId: a.traceId,
  };
}

export async function getRun(prisma: PrismaClient, runId: string): Promise<WorkflowRunView | null> {
  const run = await prisma.workflowRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      workflowKey: true,
      workflowName: true,
      version: true,
      versionId: true,
      state: true,
      input: true,
      output: true,
      errorMessage: true,
      triggeredBy: true,
      idempotencyKey: true,
      traceId: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      versionRef: { select: { definition: true } },
    },
  });
  if (!run) return null;

  const tasks = await prisma.taskRun.findMany({
    where: { workflowRunId: runId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      nodeKey: true,
      name: true,
      type: true,
      queue: true,
      state: true,
      attempts: true,
      failures: true,
      recoveries: true,
      maxAttempts: true,
      dependsOn: true,
      input: true,
      output: true,
      errorCode: true,
      errorMessage: true,
      timeoutMs: true,
      queuedAt: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      nextAttemptAt: true,
      workerId: true,
      traceId: true,
      leases: {
        where: { releasedAt: null },
        orderBy: { acquiredAt: 'desc' },
        take: 1,
        select: {
          workerId: true,
          acquiredAt: true,
          expiresAt: true,
          heartbeatAt: true,
          attemptNumber: true,
        },
      },
    },
  });

  const taskViews: TaskRunView[] = tasks.map((t) => ({
    id: t.id,
    nodeKey: t.nodeKey,
    name: t.name,
    type: t.type,
    queue: t.queue,
    state: t.state as TaskRunView['state'],
    attempts: t.attempts,
    maxAttempts: t.maxAttempts,
    dependsOn: t.dependsOn,
    input: t.input,
    output: t.output,
    errorCode: t.errorCode,
    errorMessage: t.errorMessage,
    timeoutMs: t.timeoutMs,
    queuedAt: iso(t.queuedAt),
    startedAt: iso(t.startedAt),
    finishedAt: iso(t.finishedAt),
    durationMs: t.durationMs,
    nextAttemptAt: iso(t.nextAttemptAt),
    workerId: t.workerId,
    traceId: t.traceId,
    lease: t.leases[0]
      ? {
          workerId: t.leases[0].workerId,
          acquiredAt: t.leases[0].acquiredAt.toISOString(),
          expiresAt: t.leases[0].expiresAt.toISOString(),
          heartbeatAt: t.leases[0].heartbeatAt.toISOString(),
          attemptNumber: t.leases[0].attemptNumber,
        }
      : null,
  }));

  return {
    id: run.id,
    workflowKey: run.workflowKey,
    workflowName: run.workflowName,
    version: run.version,
    state: run.state as WorkflowRunView['state'],
    input: run.input,
    output: run.output,
    errorMessage: run.errorMessage,
    triggeredBy: run.triggeredBy,
    idempotencyKey: run.idempotencyKey,
    traceId: run.traceId,
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    durationMs: run.durationMs,
    definition: run.versionRef.definition as unknown as WorkflowDefinition,
    tasks: taskViews,
    counts: foldCounts(tasks.map((t) => ({ state: t.state as string, count: 1 }))),
  };
}

export async function listTaskAttempts(
  prisma: PrismaClient,
  taskRunId: string,
): Promise<TaskAttemptView[]> {
  const rows = await prisma.taskAttempt.findMany({
    where: { taskRunId },
    orderBy: { attemptNumber: 'asc' },
    select: {
      id: true,
      attemptNumber: true,
      state: true,
      workerId: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      errorCode: true,
      errorMessage: true,
      errorStack: true,
      output: true,
      traceId: true,
    },
  });
  return rows.map(toAttemptView);
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export async function listWorkers(
  prisma: PrismaClient,
  livenessMs = 20_000,
): Promise<WorkerView[]> {
  const now = Date.now();
  const workers = await prisma.worker.findMany({
    orderBy: [{ state: 'asc' }, { registeredAt: 'asc' }],
    select: {
      id: true,
      name: true,
      hostname: true,
      pid: true,
      state: true,
      version: true,
      queues: true,
      capabilities: true,
      concurrency: true,
      activeTasks: true,
      tasksCompleted: true,
      tasksFailed: true,
      lastHeartbeatAt: true,
      registeredAt: true,
    },
  });
  if (workers.length === 0) return [];

  const active = await prisma.taskRun.findMany({
    where: { workerId: { in: workers.map((w) => w.id) }, state: 'RUNNING' },
    select: { id: true, nodeKey: true, workflowRunId: true, startedAt: true, workerId: true },
  });

  return workers.map((w) => {
    // Liveness is derived here rather than trusted from the stored state, so a worker
    // that died between sweeps is reported honestly.
    const stale = now - w.lastHeartbeatAt.getTime() > livenessMs;
    const state = w.state === 'ONLINE' && stale ? 'UNRESPONSIVE' : (w.state as WorkerView['state']);

    return {
      id: w.id,
      name: w.name,
      hostname: w.hostname,
      pid: w.pid,
      state,
      version: w.version,
      queues: w.queues,
      capabilities: w.capabilities,
      concurrency: w.concurrency,
      activeTasks: w.activeTasks,
      tasksCompleted: w.tasksCompleted,
      tasksFailed: w.tasksFailed,
      lastHeartbeatAt: w.lastHeartbeatAt.toISOString(),
      uptimeSeconds: Math.max(0, Math.round((now - w.registeredAt.getTime()) / 1000)),
      registeredAt: w.registeredAt.toISOString(),
      currentTasks: active
        .filter((t) => t.workerId === w.id)
        .map((t) => ({
          taskRunId: t.id,
          nodeKey: t.nodeKey,
          workflowRunId: t.workflowRunId,
          startedAt: (t.startedAt ?? new Date()).toISOString(),
        })),
    };
  });
}

// ---------------------------------------------------------------------------
// Dead letters
// ---------------------------------------------------------------------------

export async function listDeadLetters(
  prisma: PrismaClient,
  options: { status?: string; limit?: number; cursor?: string } = {},
): Promise<Page<DeadLetterView>> {
  const limit = Math.min(options.limit ?? 25, 100);
  const rows = await prisma.deadLetter.findMany({
    where: {
      ...(options.status ? { status: options.status as never } : {}),
      ...(options.cursor ? { createdAt: { lt: new Date(options.cursor) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    select: {
      id: true,
      status: true,
      workflowRunId: true,
      workflowKey: true,
      taskRunId: true,
      nodeKey: true,
      type: true,
      attempts: true,
      errorCode: true,
      errorMessage: true,
      input: true,
      lastOutput: true,
      createdAt: true,
      resolvedAt: true,
      resolvedBy: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const attempts =
    page.length === 0
      ? []
      : await prisma.taskAttempt.findMany({
          where: { taskRunId: { in: page.map((r) => r.taskRunId) } },
          orderBy: { attemptNumber: 'asc' },
          select: {
            id: true,
            taskRunId: true,
            attemptNumber: true,
            state: true,
            workerId: true,
            startedAt: true,
            finishedAt: true,
            durationMs: true,
            errorCode: true,
            errorMessage: true,
            errorStack: true,
            output: true,
            traceId: true,
          },
        });

  return {
    items: page.map((r) => ({
      id: r.id,
      status: r.status as DeadLetterView['status'],
      workflowRunId: r.workflowRunId,
      workflowKey: r.workflowKey,
      taskRunId: r.taskRunId,
      nodeKey: r.nodeKey,
      type: r.type,
      attempts: r.attempts,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      input: r.input,
      lastOutput: r.lastOutput,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: iso(r.resolvedAt),
      resolvedBy: r.resolvedBy,
      attemptHistory: attempts.filter((a) => a.taskRunId === r.taskRunId).map(toAttemptView),
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.createdAt.toISOString() ?? null) : null,
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export async function listSchedules(prisma: PrismaClient): Promise<ScheduleView[]> {
  const rows = await prisma.workflowSchedule.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      cron: true,
      runAt: true,
      timezone: true,
      enabled: true,
      input: true,
      lastRunAt: true,
      lastRunId: true,
      nextRunAt: true,
      createdAt: true,
      definition: { select: { key: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    workflowKey: r.definition.key,
    cron: r.cron,
    runAt: iso(r.runAt),
    timezone: r.timezone,
    enabled: r.enabled,
    input: r.input,
    lastRunAt: iso(r.lastRunAt),
    lastRunId: r.lastRunId,
    nextRunAt: iso(r.nextRunAt),
    createdAt: r.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * Everything the console home page needs, in a bounded number of queries.
 *
 * The hourly throughput series is computed by PostgreSQL with `date_trunc` and a
 * generated series rather than in application code: pulling 24 hours of runs into Node
 * to bucket them would move megabytes to count them.
 */
export async function dashboardStats(prisma: PrismaClient): Promise<DashboardStatsView> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [activeRuns, taskStates, last24h, fleet, deadLetters, outbox, throughput, recent] =
    await Promise.all([
      prisma.workflowRun.count({ where: { state: { in: ['PENDING', 'QUEUED', 'RUNNING'] } } }),
      prisma.taskRun.groupBy({
        by: ['state'],
        where: { state: { in: ['QUEUED', 'RUNNING'] } },
        _count: { _all: true },
      }),
      prisma.workflowRun.groupBy({
        by: ['state'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      fleetSummary(prisma),
      prisma.deadLetter.count({ where: { status: 'OPEN' } }),
      outboxHealth(prisma),
      prisma.$queryRaw<Array<{ bucket: Date; started: bigint; succeeded: bigint; failed: bigint }>>`
        SELECT
          date_trunc('hour', series.hour) AS bucket,
          COUNT(r.id) FILTER (WHERE r.id IS NOT NULL)                          AS started,
          COUNT(r.id) FILTER (WHERE r.state = 'SUCCEEDED')                     AS succeeded,
          COUNT(r.id) FILTER (WHERE r.state IN ('FAILED', 'TIMED_OUT'))        AS failed
        FROM generate_series(
               date_trunc('hour', now() - interval '23 hours'),
               date_trunc('hour', now()),
               interval '1 hour'
             ) AS series(hour)
        LEFT JOIN workflow_run r
          ON date_trunc('hour', r."createdAt") = series.hour
        GROUP BY series.hour
        ORDER BY series.hour ASC
      `,
      listRuns(prisma, { limit: 8 }),
    ]);

  const get = (state: string): number => last24h.find((r) => r.state === state)?._count._all ?? 0;
  const succeeded = get('SUCCEEDED');
  const failed = get('FAILED') + get('TIMED_OUT');
  const finished = succeeded + failed;

  return {
    runs: {
      active: activeRuns,
      queuedTasks: taskStates.find((t) => t.state === 'QUEUED')?._count._all ?? 0,
      runningTasks: taskStates.find((t) => t.state === 'RUNNING')?._count._all ?? 0,
      last24h: {
        total: last24h.reduce((sum, r) => sum + r._count._all, 0),
        succeeded,
        failed,
        cancelled: get('CANCELLED'),
      },
      successRate: finished === 0 ? null : succeeded / finished,
    },
    workers: {
      online: fleet.online,
      unresponsive: fleet.unresponsive,
      totalCapacity: fleet.totalCapacity,
      activeTasks: fleet.activeTasks,
    },
    deadLetters: { open: deadLetters },
    outbox: { pending: outbox.pending, failed: outbox.failed },
    throughput: throughput.map((t) => ({
      bucket: t.bucket.toISOString(),
      started: Number(t.started),
      succeeded: Number(t.succeeded),
      failed: Number(t.failed),
    })),
    recentRuns: recent.items,
  };
}
