import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  reclaimExpiredLeases,
  registerWorker,
  resetTestDatabase,
  saveDefinition,
  type PrismaClient,
} from '@forge/database';
import { createSilentLogger } from '@forge/logger';
import { createMetrics } from '@forge/observability';
import { Transport } from '@forge/transport';
import type { WorkflowDefinition } from '@forge/contracts';
import { createOutboxPublisher } from '../../src/loops/outbox-publisher';
import { createAdvancer } from '../../src/loops/advancer';
import { createLeaseReaper, createRetrySweeper } from '../../src/loops/sweepers';

/**
 * Integration harness.
 *
 * Runs the *real* control plane against a *real* PostgreSQL and Redis — no mocks, no
 * fakes, no in-memory substitutes. The point of these tests is the interaction between
 * the engine, the database's constraints and the transport; a test that mocks any of the
 * three would pass while the system was broken.
 *
 * The loops are driven manually (`pump()`) rather than left running on timers, so a test
 * can assert on the state between two specific steps instead of racing a scheduler.
 */

/**
 * Integration tests get their own database and their own Redis index.
 *
 * They assert on exact state — "this task is QUEUED and nothing has claimed it" — which
 * a running `pnpm forge:dev` would invalidate within milliseconds by advancing the run
 * and claiming the task. Isolation is what makes the assertions meaningful, and it lets
 * the dev stack keep running while you iterate on a failing test.
 *
 * `pnpm test:setup` creates both.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://forge:forge@localhost:5435/forge_test?schema=public';

/** Redis database 1, so the dev stack's queues on database 0 are untouched. */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6381/1';

export interface Harness {
  prisma: PrismaClient;
  transport: Transport;
  /** Run one iteration of every control-plane loop, in dependency order. */
  pump: (times?: number) => Promise<void>;
  /** Reap leases that have expired, ignoring the usual grace period. */
  reap: (graceMs?: number) => Promise<number>;
  registerTestWorker: (name?: string) => Promise<string>;
  installWorkflow: (definition: WorkflowDefinition) => Promise<{ version: number }>;
  close: () => Promise<void>;
  /** Namespaced so parallel test files cannot collide on workflow keys. */
  namespace: string;
}

export async function createHarness(): Promise<Harness> {
  const logger = createSilentLogger();
  const metrics = createMetrics({ service: 'scheduler', defaultMetrics: false });
  const prisma = createPrismaClient({ databaseUrl: TEST_DATABASE_URL });
  const transport = new Transport({ url: TEST_REDIS_URL, logger });
  const namespace = 'it-' + randomUUID().slice(0, 8);

  await prisma.$connect();
  await transport.ping();

  // Start from a clean slate. Leftover rows from another suite would otherwise starve
  // this one: its publisher claims the old pending outbox rows, its advancer consumes
  // the resulting messages, and the run under test never gets advanced in time.
  await resetTestDatabase(prisma);
  await transport.redis.flushdb();

  const publish = createOutboxPublisher({
    prisma,
    transport,
    logger,
    metrics,
    batchSize: 200,
    maxAttempts: 5,
  });
  // A short block so `pump()` does not stall for seconds when the queue is empty.
  const advance = createAdvancer({ prisma, transport, logger, metrics, blockSeconds: 1 });
  const sweepRetries = createRetrySweeper({ prisma, logger, metrics });

  const pump = async (times = 3): Promise<void> => {
    for (let i = 0; i < times; i++) {
      // Order matters: publish first so the advancer has something to consume.
      await publish();
      await advance();
      await sweepRetries();
    }
  };

  return {
    prisma,
    transport,
    namespace,
    pump,
    reap: async (graceMs = 0) => {
      const reaper = createLeaseReaper({ prisma, logger, metrics, graceMs });
      return reaper();
    },
    registerTestWorker: async (name = 'test-worker') => {
      const id = randomUUID();
      await registerWorker(prisma, {
        id,
        name: name + '-' + id.slice(0, 6),
        hostname: 'test',
        pid: process.pid,
        version: '0.0.0-test',
        queues: ['default'],
        capabilities: ['noop', 'delay', 'compute', 'validate', 'transform', 'http.echo'],
        concurrency: 4,
      });
      return id;
    },
    installWorkflow: async (definition) => {
      const result = await saveDefinition(prisma, definition, { createdBy: 'integration-test' });
      return { version: result.version };
    },
    close: async () => {
      await transport.close();
      await prisma.$disconnect();
    },
  };
}

/** Poll until `predicate` returns truthy, or fail with a useful message. */
export async function eventually<T>(
  predicate: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    'timed out after ' +
      timeoutMs +
      'ms waiting for ' +
      (options.description ?? 'condition') +
      '; last value: ' +
      JSON.stringify(last),
  );
}

/** True when PostgreSQL and Redis are both reachable. Used to skip, not to fail. */
export async function integrationServicesAvailable(): Promise<boolean> {
  const prisma = createPrismaClient({ databaseUrl: TEST_DATABASE_URL });
  const transport = new Transport({ url: TEST_REDIS_URL, logger: createSilentLogger() });
  try {
    await prisma.$queryRaw`SELECT 1`;
    await transport.ping();
    return true;
  } catch {
    return false;
  } finally {
    await transport.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

export { reclaimExpiredLeases };
