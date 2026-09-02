import { randomUUID } from 'node:crypto';
import { ExecutionEventType, TaskRunState, WorkflowRunState } from '@forge/contracts';
import { compileGraph } from '@forge/engine';
import { type Prisma, createPrismaClient, type PrismaClient, type Tx } from './client';
import { saveDefinition } from './repositories/workflows';
import { createSchedule } from './repositories/schedules';
import { DEMO_INPUTS, DEMO_WORKFLOWS } from './demo-workflows';

/**
 * Demo seed.
 *
 * Two distinct jobs, deliberately kept separate:
 *
 *   1. install the demo workflow definitions — these are real, and running them executes
 *      real tasks on real workers
 *   2. backfill ~200 *historical* runs so the dashboard has trend lines and success rates
 *      on a fresh database
 *
 * The backfilled runs are synthetic and clearly marked (`triggeredBy: 'seed'`). They are
 * finished rows only: no PENDING work, no outbox entries, nothing a worker could pick up.
 * Seeding cannot make an unimplemented feature look implemented, because everything a
 * live run does still has to happen for real.
 */

const HISTORY_DAYS = 7;
const RUNS_PER_DAY = 28;

/** Deterministic PRNG so a re-seed produces the same dashboard, not a different one. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

const random = seededRandom(0x5eed);

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function jitter(base: number, spread: number): number {
  return Math.max(1, Math.round(base + (random() - 0.5) * 2 * spread));
}

async function installDefinitions(prisma: PrismaClient): Promise<void> {
  for (const definition of DEMO_WORKFLOWS) {
    const result = await saveDefinition(prisma, definition, {
      changelog: 'seeded demo workflow',
      createdBy: 'seed',
    });

    console.log(
      '  ' +
        (result.created ? 'created' : 'unchanged') +
        '  ' +
        definition.key +
        ' v' +
        result.version +
        '  (' +
        definition.nodes.length +
        ' nodes)',
    );
  }
}

async function installSchedules(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.workflowSchedule.count();
  if (existing > 0) {
    console.log('  schedules already present, skipping');
    return;
  }

  const schedules = [
    {
      workflowKey: 'deployment-pipeline',
      name: 'Nightly staging deploy',
      cron: '0 2 * * *',
      input: { branch: 'develop', commit: 'nightly' },
      // Seeded disabled: a demo database should not start firing runs on its own the
      // first time someone leaves the stack up overnight.
      enabled: false,
    },
    {
      workflowKey: 'media-pipeline',
      name: 'Hourly media sweep',
      cron: '0 * * * *',
      input: { assetId: 'scheduled', filename: 'batch.mov', generatePreview: false },
      enabled: false,
    },
  ];

  for (const schedule of schedules) {
    const created = await createSchedule(prisma, schedule);

    console.log('  schedule  ' + schedule.name + '  (' + schedule.cron + ', disabled by default)');
    void created;
  }
}

interface SyntheticOutcome {
  state: WorkflowRunState;
  failingNode: string | null;
}

/** Roughly 85% success, with the remainder split between failures and cancellations. */
function chooseOutcome(): SyntheticOutcome {
  const roll = random();
  if (roll < 0.85) return { state: WorkflowRunState.SUCCEEDED, failingNode: null };
  if (roll < 0.96) return { state: WorkflowRunState.FAILED, failingNode: null };
  return { state: WorkflowRunState.CANCELLED, failingNode: null };
}

async function backfillHistory(prisma: PrismaClient): Promise<number> {
  const existing = await prisma.workflowRun.count({ where: { triggeredBy: 'seed' } });
  if (existing > 0) {
    console.log('  ' + existing + ' seeded runs already present, skipping backfill');
    return 0;
  }

  // Only backfill workflows that do not depend on demo-mode handlers — a history of
  // `resilience-demo` runs would imply the simulation handlers had been enabled.
  const workflows = DEMO_WORKFLOWS.filter((w) => w.metadata.requiresDemoMode !== true);

  const versions = new Map<string, { definitionId: string; versionId: string; version: number }>();
  for (const workflow of workflows) {
    const definition = await prisma.workflowDefinition.findUnique({
      where: { key: workflow.key },
      select: { id: true, latestVersion: true },
    });
    if (!definition) continue;
    const version = await prisma.workflowVersion.findUnique({
      where: {
        definitionId_version: { definitionId: definition.id, version: definition.latestVersion },
      },
      select: { id: true, version: true },
    });
    if (!version) continue;
    versions.set(workflow.key, {
      definitionId: definition.id,
      versionId: version.id,
      version: version.version,
    });
  }

  let created = 0;
  const now = Date.now();

  for (let day = HISTORY_DAYS; day >= 0; day--) {
    // Fewer runs today, since "today" is only partly elapsed.
    const runsToday = day === 0 ? Math.round(RUNS_PER_DAY * 0.4) : jitter(RUNS_PER_DAY, 8);

    for (let i = 0; i < runsToday; i++) {
      const workflow = pick(workflows);
      const resolved = versions.get(workflow.key);
      if (!resolved) continue;

      // Spread across the working day so the hourly throughput chart has a shape.
      const hourOffset = 6 + Math.floor(random() * 14);
      const createdAt = new Date(
        now - day * 86_400_000 - (23 - hourOffset) * 3_600_000 - Math.floor(random() * 3_600_000),
      );
      if (createdAt.getTime() > now) continue;

      const outcome = chooseOutcome();
      await createHistoricalRun(prisma, {
        workflow,
        resolved,
        createdAt,
        outcome,
      });
      created += 1;
    }
  }

  return created;
}

async function createHistoricalRun(
  prisma: PrismaClient,
  args: {
    workflow: (typeof DEMO_WORKFLOWS)[number];
    resolved: { definitionId: string; versionId: string; version: number };
    createdAt: Date;
    outcome: SyntheticOutcome;
  },
): Promise<void> {
  const { workflow, resolved, createdAt, outcome } = args;
  const graph = compileGraph(workflow);
  const order = [...graph.topologicalOrder];

  // For a failed run, pick which node failed so the task states are internally
  // consistent: everything before it succeeded, everything after was cancelled.
  const failIndex =
    outcome.state === WorkflowRunState.SUCCEEDED
      ? -1
      : Math.max(1, Math.floor(random() * order.length));

  const runId = randomUUID();
  const startedAt = new Date(createdAt.getTime() + jitter(120, 80));
  let cursor = startedAt.getTime();

  await prisma.$transaction(async (tx: Tx) => {
    const taskRows: Array<{
      nodeKey: string;
      state: TaskRunState;
      attempts: number;
      failures: number;
      startedAt: Date | null;
      finishedAt: Date | null;
      durationMs: number | null;
    }> = [];

    for (let index = 0; index < order.length; index++) {
      const nodeKey = order[index] as string;
      const node = graph.nodesByKey.get(nodeKey);
      if (!node) continue;

      const baseDuration = Number(node.config.durationMs ?? node.config.latencyMs ?? 300);
      const duration = jitter(baseDuration, baseDuration * 0.3);

      if (failIndex === -1 || index < failIndex) {
        const taskStarted = new Date(cursor);
        cursor += duration;
        taskRows.push({
          nodeKey,
          state: TaskRunState.SUCCEEDED,
          // Occasionally a task succeeded on its second attempt — otherwise the seeded
          // attempt history would imply retries never happen.
          attempts: random() < 0.12 ? 2 : 1,
          failures: random() < 0.12 ? 1 : 0,
          startedAt: taskStarted,
          finishedAt: new Date(cursor),
          durationMs: duration,
        });
      } else if (index === failIndex) {
        const taskStarted = new Date(cursor);
        cursor += duration;
        taskRows.push({
          nodeKey,
          state:
            outcome.state === WorkflowRunState.CANCELLED
              ? TaskRunState.CANCELLED
              : TaskRunState.FAILED,
          attempts: outcome.state === WorkflowRunState.CANCELLED ? 1 : 3,
          failures: outcome.state === WorkflowRunState.CANCELLED ? 0 : 3,
          startedAt: taskStarted,
          finishedAt: new Date(cursor),
          durationMs: duration,
        });
      } else {
        taskRows.push({
          nodeKey,
          state: TaskRunState.CANCELLED,
          attempts: 0,
          failures: 0,
          startedAt: null,
          finishedAt: new Date(cursor),
          durationMs: null,
        });
      }
    }

    const finishedAt = new Date(cursor);

    await tx.workflowRun.create({
      data: {
        id: runId,
        definitionId: resolved.definitionId,
        versionId: resolved.versionId,
        workflowKey: workflow.key,
        workflowName: workflow.name,
        version: resolved.version,
        state: outcome.state,
        input: (DEMO_INPUTS[workflow.key] ?? {}) as Prisma.InputJsonValue,
        metadata: { seeded: true } as Prisma.InputJsonValue,
        triggeredBy: 'seed',
        timeoutMs: workflow.timeoutMs,
        createdAt,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        ...(outcome.state === WorkflowRunState.FAILED
          ? { errorMessage: 'task "' + (order[failIndex] ?? 'unknown') + '" failed' }
          : {}),
        eventSeq: taskRows.length * 2 + 2,
      },
    });

    await tx.taskRun.createMany({
      data: taskRows.map((row) => {
        const node = graph.nodesByKey.get(row.nodeKey);
        return {
          workflowRunId: runId,
          nodeKey: row.nodeKey,
          name: node?.name ?? row.nodeKey,
          type: node?.type ?? 'noop',
          queue: node?.queue ?? 'default',
          state: row.state,
          attempts: row.attempts,
          failures: row.failures,
          maxAttempts: node?.retryPolicy.maxAttempts ?? 3,
          dependsOn: [...(graph.dependencies.get(row.nodeKey) ?? [])],
          retryPolicy: (node?.retryPolicy ?? {}) as unknown as Prisma.InputJsonValue,
          timeoutMs: node?.timeoutMs ?? 30_000,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          durationMs: row.durationMs,
          createdAt,
          ...(row.state === TaskRunState.FAILED
            ? { errorCode: 'SEEDED_FAILURE', errorMessage: 'simulated historical failure' }
            : {}),
        };
      }),
    });

    // A couple of run-level events so the timeline is not empty when someone opens a
    // historical run out of curiosity.
    await tx.executionEvent.createMany({
      data: [
        {
          workflowRunId: runId,
          seq: 1,
          type: ExecutionEventType.WORKFLOW_CREATED,
          message: 'run created (seeded history)',
          occurredAt: createdAt,
        },
        {
          workflowRunId: runId,
          seq: 2,
          type: ExecutionEventType.WORKFLOW_STARTED,
          message: 'run started',
          occurredAt: startedAt,
        },
        {
          workflowRunId: runId,
          seq: taskRows.length * 2 + 2,
          type:
            outcome.state === WorkflowRunState.SUCCEEDED
              ? ExecutionEventType.WORKFLOW_COMPLETED
              : outcome.state === WorkflowRunState.CANCELLED
                ? ExecutionEventType.WORKFLOW_CANCELLED
                : ExecutionEventType.WORKFLOW_FAILED,
          message: 'run ' + outcome.state.toLowerCase(),
          occurredAt: finishedAt,
        },
      ],
    });
  });
}

async function main(): Promise<void> {
  const prisma = createPrismaClient();

  console.log('\nFORGE demo seed\n');

  try {
    console.log('workflow definitions:');
    await installDefinitions(prisma);

    console.log('\nschedules:');
    await installSchedules(prisma);

    console.log('\nhistorical runs (synthetic, for dashboard trends):');
    const backfilled = await backfillHistory(prisma);

    console.log('  ' + backfilled + ' runs backfilled across the last ' + HISTORY_DAYS + ' days');

    console.log(
      '\ndone. Trigger a live run with:\n' +
        '  pnpm demo:run\n' +
        '  forge run order-fulfilment --example --watch\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err: unknown) => {
  console.error('seed failed:', err);
  process.exit(1);
});
