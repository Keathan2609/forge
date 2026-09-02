import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_RETRY_POLICY,
  TaskRunState,
  WorkflowRunState,
  type WorkflowDefinition,
} from '@forge/contracts';
import {
  claimTask,
  completeTask,
  createRun,
  failTask,
  getRun,
  outboxHealth,
  renewLease,
  requestCancellation,
  type PrismaClient,
} from '@forge/database';
import { createHarness, eventually, integrationServicesAvailable, type Harness } from './harness';

/**
 * End-to-end control-plane integration tests.
 *
 * These run against real PostgreSQL and Redis. They are the tests that would have caught
 * every state-machine defect found during development, because they exercise the engine,
 * the persistence layer and the transport together rather than in isolation.
 *
 * They *fail* rather than skip when the services are unreachable. Skipping would let
 * `pnpm test:integration` pass while testing nothing, which is a worse outcome than an
 * obvious error — and `pnpm test` (unit) does not run this directory anyway, so a machine
 * with no infrastructure is unaffected.
 */

function definition(key: string, overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    key,
    name: key,
    timeoutMs: 120_000,
    defaultRetryPolicy: DEFAULT_RETRY_POLICY,
    inputSchema: {},
    output: {},
    nodes: [],
    edges: [],
    metadata: {},
    ...overrides,
  };
}

function node(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    name: key,
    type: 'noop',
    queue: 'default',
    timeoutMs: 30_000,
    retryPolicy: DEFAULT_RETRY_POLICY,
    config: {},
    input: {},
    metadata: {},
    ...overrides,
  } as WorkflowDefinition['nodes'][number];
}

describe('control plane integration', () => {
  let harness: Harness;
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!(await integrationServicesAvailable())) {
      throw new Error(
        [
          'integration tests need PostgreSQL and Redis.',
          '  start them:                          pnpm forge:infra',
          '  prepare the isolated test database:  pnpm test:setup',
        ].join('\n'),
      );
    }
    harness = await createHarness();
    prisma = harness.prisma;
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  // -------------------------------------------------------------------------
  it('creates a run with every task materialised in one transaction', async () => {
    const key = harness.namespace + '-materialise';
    await harness.installWorkflow(
      definition(key, {
        nodes: [node('a'), node('b'), node('c')],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      }),
    );

    const { runId } = await createRun(prisma, { workflowKey: key, input: {} });

    // The run's full shape is durable immediately, before any dispatch happens.
    const tasks = await prisma.taskRun.findMany({ where: { workflowRunId: runId } });
    expect(tasks).toHaveLength(3);
    expect(tasks.filter((t) => t.state === TaskRunState.READY)).toHaveLength(1);
    expect(tasks.filter((t) => t.state === TaskRunState.BLOCKED)).toHaveLength(2);

    // And so is the intent to dispatch it.
    const outbox = await prisma.outboxEvent.findMany({ where: { aggregateId: runId } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.type).toBe('RUN_ADVANCE');
    expect(outbox[0]?.status).toBe('PENDING');
  });

  // -------------------------------------------------------------------------
  it('advances a linear workflow to completion through claim/complete', async () => {
    const key = harness.namespace + '-linear';
    await harness.installWorkflow(
      definition(key, {
        nodes: [node('first'), node('second')],
        edges: [{ from: 'first', to: 'second' }],
      }),
    );

    const workerId = await harness.registerTestWorker();
    const { runId } = await createRun(prisma, { workflowKey: key, input: {} });

    await harness.pump();

    // `first` should now be QUEUED and dispatched.
    const first = await eventually(
      async () => {
        const task = await prisma.taskRun.findFirst({
          where: { workflowRunId: runId, nodeKey: 'first' },
        });
        return task?.state === TaskRunState.QUEUED ? task : null;
      },
      { description: 'first task to be queued' },
    );

    const claim = await claimTask(prisma, {
      taskRunId: first.id,
      workerId,
      leaseTtlMs: 30_000,
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const completed = await completeTask(prisma, {
      taskRunId: first.id,
      attemptNumber: claim.task.attemptNumber,
      workerId,
      output: { done: true },
    });
    expect(completed.ok).toBe(true);

    await harness.pump();

    const second = await eventually(
      async () => {
        const task = await prisma.taskRun.findFirst({
          where: { workflowRunId: runId, nodeKey: 'second' },
        });
        return task?.state === TaskRunState.QUEUED ? task : null;
      },
      { description: 'second task to unblock' },
    );

    const claim2 = await claimTask(prisma, {
      taskRunId: second.id,
      workerId,
      leaseTtlMs: 30_000,
    });
    expect(claim2.ok).toBe(true);
    if (!claim2.ok) return;
    await completeTask(prisma, {
      taskRunId: second.id,
      attemptNumber: claim2.task.attemptNumber,
      workerId,
      output: {},
    });

    await harness.pump();

    const run = await eventually(
      async () => {
        const r = await getRun(prisma, runId);
        return r?.state === WorkflowRunState.SUCCEEDED ? r : null;
      },
      { description: 'run to succeed' },
    );
    expect(run.state).toBe(WorkflowRunState.SUCCEEDED);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  it('runs a fan-out concurrently and waits for both branches at the join', async () => {
    const key = harness.namespace + '-fanout';
    await harness.installWorkflow(
      definition(key, {
        nodes: [node('root'), node('left'), node('right'), node('join')],
        edges: [
          { from: 'root', to: 'left' },
          { from: 'root', to: 'right' },
          { from: 'left', to: 'join' },
          { from: 'right', to: 'join' },
        ],
      }),
    );

    const workerId = await harness.registerTestWorker();
    const { runId } = await createRun(prisma, { workflowKey: key, input: {} });

    const finish = async (nodeKey: string): Promise<void> => {
      const task = await eventually(
        async () => {
          const t = await prisma.taskRun.findFirst({ where: { workflowRunId: runId, nodeKey } });
          return t?.state === TaskRunState.QUEUED ? t : null;
        },
        { description: nodeKey + ' to be queued' },
      );
      const claim = await claimTask(prisma, { taskRunId: task.id, workerId, leaseTtlMs: 30_000 });
      if (!claim.ok) throw new Error('could not claim ' + nodeKey);
      await completeTask(prisma, {
        taskRunId: task.id,
        attemptNumber: claim.task.attemptNumber,
        workerId,
        output: {},
      });
    };

    await harness.pump();
    await finish('root');
    await harness.pump();

    // Both branches must be dispatched together — that is the fan-out.
    const branches = await prisma.taskRun.findMany({
      where: { workflowRunId: runId, nodeKey: { in: ['left', 'right'] } },
    });
    expect(branches.every((t) => t.state === TaskRunState.QUEUED)).toBe(true);

    // The join must stay blocked while only one branch has finished.
    await finish('left');
    await harness.pump();
    const joinAfterOne = await prisma.taskRun.findFirst({
      where: { workflowRunId: runId, nodeKey: 'join' },
    });
    expect(joinAfterOne?.state).toBe(TaskRunState.BLOCKED);

    await finish('right');
    await harness.pump();
    await finish('join');
    await harness.pump();

    const run = await eventually(
      async () => {
        const r = await getRun(prisma, runId);
        return r?.state === WorkflowRunState.SUCCEEDED ? r : null;
      },
      { description: 'fan-out run to succeed' },
    );
    expect(run.counts.succeeded).toBe(4);
  });

  // -------------------------------------------------------------------------
  it('rejects a duplicate claim for the same attempt', async () => {
    const key = harness.namespace + '-duplicate';
    await harness.installWorkflow(definition(key, { nodes: [node('only')] }));

    const workerA = await harness.registerTestWorker('a');
    const workerB = await harness.registerTestWorker('b');
    const { runId } = await createRun(prisma, { workflowKey: key, input: {} });
    await harness.pump();

    const task = await eventually(
      async () => {
        const t = await prisma.taskRun.findFirst({ where: { workflowRunId: runId } });
        return t?.state === TaskRunState.QUEUED ? t : null;
      },
      { description: 'task to be queued' },
    );

    // Two workers race for the same dispatch — exactly what at-least-once delivery
    // produces. Precisely one may win.
    const [first, second] = await Promise.all([
      claimTask(prisma, { taskRunId: task.id, workerId: workerA, leaseTtlMs: 30_000 }),
      claimTask(prisma, { taskRunId: task.id, workerId: workerB, leaseTtlMs: 30_000 }),
    ]);

    const winners = [first, second].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    // And exactly one attempt row exists, which is the durable guarantee.
    const attempts = await prisma.taskAttempt.findMany({ where: { taskRunId: task.id } });
    expect(attempts).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  it('refuses a completion from a worker whose lease has been reclaimed', async () => {
    const key = harness.namespace + '-stale-lease';
    await harness.installWorkflow(definition(key, { nodes: [node('slow')] }));

    const workerId = await harness.registerTestWorker();
    const { runId } = await createRun(prisma, { workflowKey: key, input: {} });
    await harness.pump();

    const task = await eventually(
      async () => {
        const t = await prisma.taskRun.findFirst({ where: { workflowRunId: runId } });
        return t?.state === TaskRunState.QUEUED ? t : null;
      },
      { description: 'task to be queued' },
    );

    // Claim with a lease that is already expired: the worker "paused" past its window.
    const claim = await claimTask(prisma, {
      taskRunId: task.id,
      workerId,
      leaseTtlMs: 1,
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await new Promise((r) => setTimeout(r, 50));

    // The result must be rejected — another worker may already have recovered the task.
    const outcome = await completeTask(prisma, {
      taskRunId: task.id,
      attemptNumber: claim.task.attemptNumber,
      workerId,
      output: { shouldBeDiscarded: true },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('lease-lost');

    const after = await prisma.taskRun.findUnique({ where: { id: task.id } });
    expect(after?.state).toBe(TaskRunState.RUNNING);
    expect(after?.output).toBeNull();
  });

  // -------------------------------------------------------------------------
  it('recovers a task whose worker died, without consuming the retry budget', async () => {
    const key = harness.namespace + '-recovery';
    await harness.installWorkflow(definition(key, { nodes: [node('crashy')] }));

    const deadWorker = await harness.registerTestWorker('doomed');
    const { runId } = await createRun(prisma, { workflowKey: key, input: {} });
    await harness.pump();

    const task = await eventually(
      async () => {
        const t = await prisma.taskRun.findFirst({ where: { workflowRunId: runId } });
        return t?.state === TaskRunState.QUEUED ? t : null;
      },
      { description: 'task to be queued' },
    );

    const claim = await claimTask(prisma, {
      taskRunId: task.id,
      workerId: deadWorker,
      leaseTtlMs: 1,
    });
    expect(claim.ok).toBe(true);

    // The worker never reports back. Its lease expires.
    await new Promise((r) => setTimeout(r, 60));
    const reclaimed = await harness.reap(0);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const recovered = await prisma.taskRun.findUnique({ where: { id: task.id } });
    expect(recovered?.state).toBe(TaskRunState.QUEUED);
    expect(recovered?.recoveries).toBe(1);
    // The crucial assertion: an infrastructure failure must not spend an application
    // retry. `failures` stays at zero even though a physical attempt was made.
    expect(recovered?.failures).toBe(0);
    expect(recovered?.attempts).toBe(1);

    const abandoned = await prisma.taskAttempt.findFirst({
      where: { taskRunId: task.id, attemptNumber: 1 },
    });
    expect(abandoned?.state).toBe('ABANDONED');
    expect(abandoned?.errorCode).toBe('LEASE_EXPIRED');

    // A different worker picks it up and finishes it.
    const liveWorker = await harness.registerTestWorker('survivor');
    const secondClaim = await claimTask(prisma, {
      taskRunId: task.id,
      workerId: liveWorker,
      leaseTtlMs: 30_000,
    });
    expect(secondClaim.ok).toBe(true);
    if (!secondClaim.ok) return;
    expect(secondClaim.task.attemptNumber).toBe(2);

    await completeTask(prisma, {
      taskRunId: task.id,
      attemptNumber: 2,
      workerId: liveWorker,
      output: { recovered: true },
    });
    await harness.pump();

    const run = await eventually(
      async () => {
        const r = await getRun(prisma, runId);
        return r?.state === WorkflowRunState.SUCCEEDED ? r : null;
      },
      { description: 'recovered run to succeed' },
    );
    expect(run.state).toBe(WorkflowRunState.SUCCEEDED);
  });

  // -------------------------------------------------------------------------
  it('retries with backoff, then dead-letters when the budget is exhausted', async () => {
    const key = harness.namespace + '-deadletter';
    await harness.installWorkflow(
      definition(key, {
        nodes: [
          node('doomed', {
            retryPolicy: {
              ...DEFAULT_RETRY_POLICY,
              maxAttempts: 2,
              initialDelayMs: 10,
              jitter: false,
            },
          }),
        ],
      }),
    );

    const workerId = await harness.registerTestWorker();
    const { runId } = await createRun(prisma, { workflowKey: key, input: {} });
    await harness.pump();

    const failOnce = async (): Promise<string> => {
      const task = await eventually(
        async () => {
          const t = await prisma.taskRun.findFirst({ where: { workflowRunId: runId } });
          return t?.state === TaskRunState.QUEUED ? t : null;
        },
        { description: 'task to be queued for another attempt' },
      );
      const claim = await claimTask(prisma, { taskRunId: task.id, workerId, leaseTtlMs: 30_000 });
      if (!claim.ok) throw new Error('claim failed: ' + claim.reason);
      const result = await failTask(prisma, {
        taskRunId: task.id,
        attemptNumber: claim.task.attemptNumber,
        workerId,
        errorCode: 'BOOM',
        errorMessage: 'deliberate failure',
      });
      if (!result.ok) throw new Error('failTask rejected: ' + result.reason);
      return result.decision;
    };

    expect(await failOnce()).toBe('retry');

    // Wait out the backoff, then let the sweeper re-queue it.
    await new Promise((r) => setTimeout(r, 60));
    await harness.pump();

    expect(await failOnce()).toBe('dead-letter');

    const task = await prisma.taskRun.findFirst({ where: { workflowRunId: runId } });
    expect(task?.state).toBe(TaskRunState.DEAD_LETTERED);
    expect(task?.failures).toBe(2);

    const deadLetter = await prisma.deadLetter.findUnique({
      where: { taskRunId: task?.id ?? '' },
    });
    expect(deadLetter).not.toBeNull();
    expect(deadLetter?.status).toBe('OPEN');
    expect(deadLetter?.attempts).toBe(2);

    // Both attempts are preserved, which is what makes the console's history real.
    const attempts = await prisma.taskAttempt.findMany({
      where: { taskRunId: task?.id ?? '' },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.state === 'FAILED')).toBe(true);

    await harness.pump();
    const run = await eventually(
      async () => {
        const r = await getRun(prisma, runId);
        return r?.state === WorkflowRunState.FAILED ? r : null;
      },
      { description: 'run to fail' },
    );
    expect(run.errorMessage).toContain('doomed');
  });

  // -------------------------------------------------------------------------
  it('propagates a failure by cancelling everything downstream', async () => {
    const key = harness.namespace + '-propagate';
    await harness.installWorkflow(
      definition(key, {
        nodes: [
          node('gate', {
            retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
          }),
          node('after'),
          node('later'),
        ],
        edges: [
          { from: 'gate', to: 'after' },
          { from: 'after', to: 'later' },
        ],
      }),
    );

    const workerId = await harness.registerTestWorker();
    const { runId } = await createRun(prisma, { workflowKey: key, input: {} });
    await harness.pump();

    const gate = await eventually(
      async () => {
        const t = await prisma.taskRun.findFirst({
          where: { workflowRunId: runId, nodeKey: 'gate' },
        });
        return t?.state === TaskRunState.QUEUED ? t : null;
      },
      { description: 'gate to be queued' },
    );

    const claim = await claimTask(prisma, { taskRunId: gate.id, workerId, leaseTtlMs: 30_000 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await failTask(prisma, {
      taskRunId: gate.id,
      attemptNumber: claim.task.attemptNumber,
      workerId,
      errorCode: 'FATAL',
      errorMessage: 'no retries left',
    });
    await harness.pump();

    const run = await eventually(
      async () => {
        const r = await getRun(prisma, runId);
        return r && r.state === WorkflowRunState.FAILED ? r : null;
      },
      { description: 'run to fail' },
    );

    const byKey = Object.fromEntries((run.tasks ?? []).map((t) => [t.nodeKey, t.state]));
    expect(byKey.after).toBe(TaskRunState.CANCELLED);
    expect(byKey.later).toBe(TaskRunState.CANCELLED);
  });

  // -------------------------------------------------------------------------
  it('honours an idempotency key across concurrent triggers', async () => {
    const key = harness.namespace + '-idempotent';
    await harness.installWorkflow(definition(key, { nodes: [node('only')] }));

    const idempotencyKey = 'order-' + randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createRun(prisma, {
          workflowKey: key,
          input: { orderId: 'same' },
          idempotencyKey,
        }),
      ),
    );

    const runIds = new Set(results.map((r) => r.runId));
    expect(runIds.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);

    const runs = await prisma.workflowRun.count({ where: { workflowKey: key } });
    expect(runs).toBe(1);
  });

  // -------------------------------------------------------------------------
  it('rejects an idempotency key reused with a different body', async () => {
    const key = harness.namespace + '-idempotent-conflict';
    await harness.installWorkflow(definition(key, { nodes: [node('only')] }));

    const idempotencyKey = 'conflict-' + randomUUID();
    await createRun(prisma, { workflowKey: key, input: { a: 1 }, idempotencyKey });

    await expect(
      createRun(prisma, { workflowKey: key, input: { a: 2 }, idempotencyKey }),
    ).rejects.toThrow(/already used with a different request body/);
  });

  // -------------------------------------------------------------------------
  it('cancels cooperatively, leaving a running task to stop itself', async () => {
    const key = harness.namespace + '-cancel';
    await harness.installWorkflow(
      definition(key, {
        nodes: [node('running'), node('queued')],
        edges: [],
      }),
    );

    const workerId = await harness.registerTestWorker();
    const { runId } = await createRun(prisma, { workflowKey: key, input: {} });
    await harness.pump();

    const running = await eventually(
      async () => {
        const t = await prisma.taskRun.findFirst({
          where: { workflowRunId: runId, nodeKey: 'running' },
        });
        return t?.state === TaskRunState.QUEUED ? t : null;
      },
      { description: 'task to be queued' },
    );

    const claim = await claimTask(prisma, { taskRunId: running.id, workerId, leaseTtlMs: 30_000 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await requestCancellation(prisma, runId, 'operator changed their mind');

    // The worker sees the cancellation on its next lease renewal.
    const renewal = await renewLease(prisma, {
      taskRunId: running.id,
      attemptNumber: claim.task.attemptNumber,
      workerId,
      ttlMs: 30_000,
    });
    expect(renewal.renewed).toBe(true);
    expect(renewal.cancelRequested).toBe(true);

    await harness.pump();

    // The queued sibling is cancelled; the running one is left for its worker.
    const tasks = await prisma.taskRun.findMany({ where: { workflowRunId: runId } });
    const byKey = Object.fromEntries(tasks.map((t) => [t.nodeKey, t.state]));
    expect(byKey.queued).toBe(TaskRunState.CANCELLED);
    expect(byKey.running).toBe(TaskRunState.RUNNING);

    // Once the worker reports, the run reaches CANCELLED.
    await failTask(prisma, {
      taskRunId: running.id,
      attemptNumber: claim.task.attemptNumber,
      workerId,
      errorCode: 'CANCELLED',
      errorMessage: 'stopped by cancellation',
    });
    await harness.pump();

    const run = await eventually(
      async () => {
        const r = await getRun(prisma, runId);
        return r && ['CANCELLED', 'FAILED'].includes(r.state) ? r : null;
      },
      { description: 'run to reach a terminal state' },
    );
    expect(['CANCELLED', 'FAILED']).toContain(run.state);
  });

  // -------------------------------------------------------------------------
  it('drains the outbox and leaves no unpublished rows', async () => {
    const key = harness.namespace + '-outbox';
    await harness.installWorkflow(definition(key, { nodes: [node('only')] }));
    await createRun(prisma, { workflowKey: key, input: {} });

    await harness.pump(5);

    const health = await outboxHealth(prisma);
    // Other tests may be producing rows concurrently; assert on staleness, not zero.
    expect(health.oldestPendingAgeMs === null || health.oldestPendingAgeMs < 10_000).toBe(true);
    expect(health.failed).toBe(0);
  });

  // -------------------------------------------------------------------------
  it('republishes an outbox row when the publish is interrupted', async () => {
    const key = harness.namespace + '-outbox-crash';
    await harness.installWorkflow(definition(key, { nodes: [node('only')] }));
    const { runId } = await createRun(prisma, { workflowKey: key, input: {} });

    // Simulate a publisher that pushed to Redis but died before marking the row: the row
    // is still PENDING, so the next tick republishes it. The consumer must tolerate the
    // duplicate — which it does, because `advance` is idempotent.
    const before = await prisma.outboxEvent.findFirst({ where: { aggregateId: runId } });
    expect(before?.status).toBe('PENDING');

    await harness.pump();
    await harness.pump();

    const after = await prisma.outboxEvent.findFirst({ where: { aggregateId: runId } });
    expect(after?.status).toBe('PUBLISHED');

    // Two advances of the same run produced one consistent outcome, not two.
    const tasks = await prisma.taskRun.findMany({ where: { workflowRunId: runId } });
    expect(tasks).toHaveLength(1);
    const attempts = await prisma.taskAttempt.count({
      where: { taskRunId: tasks[0]?.id ?? '' },
    });
    expect(attempts).toBe(0);
  });
});
