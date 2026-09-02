import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  TaskRunState,
  type TaskDispatchMessage,
  type WorkflowDefinition,
} from '@forge/contracts';
import {
  advance,
  createPrismaClient,
  createRun,
  registerWorker,
  resetTestDatabase,
  saveDefinition,
  type PrismaClient,
} from '@forge/database';
import { createSilentLogger } from '@forge/logger';
import { createMetrics } from '@forge/observability';
import { Transport } from '@forge/transport';
import { TaskExecutor } from '../../src/executor';
import { HandlerRegistry, type HandlerDefinition } from '../../src/handlers/registry';
import { BUILTIN_HANDLERS } from '../../src/handlers/builtin';

/**
 * The worker executor, against real PostgreSQL and Redis.
 *
 * The scheduler's integration suite covers the persistence primitives
 * (`claimTask` / `completeTask` / `failTask`) directly. This one covers the *executor* —
 * the code that ties them to a handler, a lease heartbeat, an abort signal and a timeout.
 * That wiring is where a worker either honours its lease or quietly does the wrong thing,
 * and it cannot be verified without a database.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://forge:forge@localhost:5435/forge_test?schema=public';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6381/1';

const namespace = 'wx-' + randomUUID().slice(0, 8);

function definition(key: string, node: Partial<WorkflowDefinition['nodes'][number]>) {
  return {
    key,
    name: key,
    timeoutMs: 120_000,
    defaultRetryPolicy: DEFAULT_RETRY_POLICY,
    inputSchema: {},
    output: {},
    edges: [],
    metadata: {},
    nodes: [
      {
        key: 'only',
        name: 'only',
        type: 'noop',
        queue: 'default',
        timeoutMs: 30_000,
        retryPolicy: DEFAULT_RETRY_POLICY,
        config: {},
        input: {},
        metadata: {},
        ...node,
      },
    ],
  } as WorkflowDefinition;
}

describe('worker executor', () => {
  let prisma: PrismaClient;
  let transport: Transport;
  let workerId: string;

  const logger = createSilentLogger();
  const metrics = createMetrics({ service: 'worker', defaultMetrics: false });

  /** Build an executor whose registry contains the built-ins plus any test handlers. */
  function executor(extra: HandlerDefinition[] = [], leaseTtlMs = 30_000): TaskExecutor {
    const registry = new HandlerRegistry({ demoMode: true, logger });
    registry.registerAll(BUILTIN_HANDLERS);
    registry.registerAll(extra);

    return new TaskExecutor({
      prisma,
      transport,
      logger,
      metrics,
      registry,
      workerId,
      leaseTtlMs,
      // Fast heartbeat so lease-loss detection happens within the test's lifetime.
      heartbeatMs: Math.max(200, Math.floor(leaseTtlMs / 4)),
    });
  }

  /** Create a run, advance it to QUEUED, and return the dispatch message for its task. */
  async function queueTask(
    key: string,
    node: Partial<WorkflowDefinition['nodes'][number]>,
    input: Record<string, unknown> = {},
  ): Promise<{ runId: string; taskId: string; message: TaskDispatchMessage }> {
    await saveDefinition(prisma, definition(key, node), { createdBy: 'worker-integration' });
    const { runId } = await createRun(prisma, { workflowKey: key, input });
    await advance(prisma, runId);

    const task = await prisma.taskRun.findFirstOrThrow({ where: { workflowRunId: runId } });
    expect(task.state).toBe(TaskRunState.QUEUED);

    return {
      runId,
      taskId: task.id,
      message: {
        kind: 'task.dispatch',
        taskRunId: task.id,
        workflowRunId: runId,
        nodeKey: task.nodeKey,
        type: task.type,
        queue: task.queue,
        expectedAttempt: 1,
        dispatchId: randomUUID(),
      },
    };
  }

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: TEST_DATABASE_URL });
    transport = new Transport({ url: TEST_REDIS_URL, logger });

    try {
      await prisma.$queryRaw`SELECT 1`;
      await transport.ping();
    } catch {
      throw new Error(
        [
          'worker integration tests need PostgreSQL and Redis.',
          '  start them:                          pnpm forge:infra',
          '  prepare the isolated test database:  pnpm test:setup',
        ].join('\n'),
      );
    }

    // Clean slate, for the same reason as the scheduler harness: a previous suite's
    // pending outbox rows and queued messages would otherwise be consumed by this one.
    await resetTestDatabase(prisma);
    await transport.redis.flushdb();

    workerId = randomUUID();
    await registerWorker(prisma, {
      id: workerId,
      name: 'executor-test',
      hostname: 'test',
      pid: process.pid,
      version: '0.0.0-test',
      queues: ['default'],
      capabilities: ['noop', 'delay', 'compute'],
      concurrency: 4,
    });
  }, 30_000);

  afterAll(async () => {
    await transport?.close();
    await prisma?.$disconnect();
  });

  it('claims, executes and commits a successful task', async () => {
    const { taskId, message } = await queueTask(namespace + '-ok', {
      type: 'compute',
      config: { operation: 'sum', values: [1, 2, 3] },
    });

    const outcome = await executor().execute(message);
    expect(outcome.status).toBe('succeeded');

    const task = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.state).toBe(TaskRunState.SUCCEEDED);
    expect(task.output).toMatchObject({ result: 6 });
    expect(task.workerId).toBe(workerId);

    // The lease is released, not left dangling for the reaper to clean up.
    const lease = await prisma.workerLease.findFirstOrThrow({ where: { taskRunId: taskId } });
    expect(lease.releasedAt).not.toBeNull();
    expect(lease.releaseReason).toBe('completed');
  });

  it('discards a duplicate dispatch instead of executing twice', async () => {
    const { taskId, message } = await queueTask(namespace + '-dup', { type: 'noop' });

    const first = await executor().execute(message);
    expect(first.status).toBe('succeeded');

    // At-least-once delivery: the same message arrives again.
    const second = await executor().execute(message);
    expect(second.status).toBe('skipped');

    const attempts = await prisma.taskAttempt.count({ where: { taskRunId: taskId } });
    expect(attempts).toBe(1);
  });

  it('records a failure and schedules a retry', async () => {
    const { taskId, message } = await queueTask(namespace + '-retry', {
      type: 'compute',
      // An unknown operation raises NonRetryableError inside the handler…
      config: { operation: 'sum', values: [1] },
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3, initialDelayMs: 50 },
    });

    // …so use a handler that fails transiently instead.
    const failing: HandlerDefinition = {
      type: 'compute',
      description: 'always fails',
      handler: async () => {
        throw new Error('downstream unavailable');
      },
    };
    const registry = new HandlerRegistry({ demoMode: false, logger });
    registry.register(failing);

    const exec = new TaskExecutor({
      prisma,
      transport,
      logger,
      metrics,
      registry,
      workerId,
      leaseTtlMs: 30_000,
      heartbeatMs: 5_000,
    });

    const outcome = await exec.execute(message);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.retrying).toBe(true);

    const task = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.state).toBe(TaskRunState.RETRYING);
    expect(task.failures).toBe(1);
    expect(task.nextAttemptAt).not.toBeNull();
    expect(task.errorMessage).toContain('downstream unavailable');
  });

  it('aborts and records a timeout when a handler overruns its budget', async () => {
    const { taskId, message } = await queueTask(namespace + '-timeout', {
      type: 'delay',
      // The handler is asked to wait far longer than the node's timeout.
      config: { durationMs: 30_000 },
      timeoutMs: 400,
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
    });

    const outcome = await executor().execute(message);
    expect(outcome.status).toBe('failed');

    const task = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskId } });
    // maxAttempts is 1, so a timeout with no budget left is terminal.
    expect(task.state).toBe(TaskRunState.TIMED_OUT);
    expect(task.errorCode).toBe('TASK_TIMEOUT');

    const attempt = await prisma.taskAttempt.findFirstOrThrow({ where: { taskRunId: taskId } });
    expect(attempt.state).toBe('TIMED_OUT');
  }, 30_000);

  it('discards its result when the lease was reclaimed mid-execution', async () => {
    // The single most important worker property: a worker that lost its lease must not
    // overwrite the result of whichever worker recovered the task.
    const { taskId, message } = await queueTask(namespace + '-stale', {
      type: 'delay',
      config: { durationMs: 1_200 },
      timeoutMs: 30_000,
    });

    // A lease so short it expires while the handler is still running, and a heartbeat
    // interval long enough that no renewal rescues it.
    const exec = new TaskExecutor({
      prisma,
      transport,
      logger,
      metrics,
      registry: (() => {
        const r = new HandlerRegistry({ demoMode: false, logger });
        r.registerAll(BUILTIN_HANDLERS);
        return r;
      })(),
      workerId,
      leaseTtlMs: 300,
      heartbeatMs: 60_000,
    });

    const outcome = await exec.execute(message);
    expect(outcome.status).toBe('lease-lost');

    const task = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskId } });
    // Still RUNNING and with no output: the reaper owns this task now.
    expect(task.state).toBe(TaskRunState.RUNNING);
    expect(task.output).toBeNull();
  }, 30_000);

  it('fails a task whose handler type this worker does not have', async () => {
    const { taskId, message } = await queueTask(namespace + '-unknown', {
      type: 'noop',
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
    });

    // A registry with nothing in it: the node's type is a key, never something the
    // worker interprets, so an unknown type is an ordinary task failure.
    const exec = new TaskExecutor({
      prisma,
      transport,
      logger,
      metrics,
      registry: new HandlerRegistry({ demoMode: false, logger }),
      workerId,
      leaseTtlMs: 30_000,
      heartbeatMs: 5_000,
    });

    const outcome = await exec.execute(message);
    expect(outcome.status).toBe('failed');

    const task = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.errorCode).toBe('UNKNOWN_HANDLER');
    expect(task.errorMessage).toContain('no handler registered');
  });

  it('records progress events without mutating the task row', async () => {
    const { runId, taskId, message } = await queueTask(namespace + '-progress', {
      type: 'delay',
      config: { durationMs: 400 },
    });

    await executor().execute(message);

    const progress = await prisma.executionEvent.findMany({
      where: { workflowRunId: runId, type: 'TASK_PROGRESS' },
    });
    // Progress is a stream of observations, so it lives in the append-only log rather
    // than overwriting a column that would lose the shape of a task that stalled.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]?.taskRunId).toBe(taskId);
  }, 20_000);
});
