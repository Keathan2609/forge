import './telemetry';

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  ConfigError,
  WorkerConfigSchema,
  loadConfig,
  redactConfig,
  type WorkerConfig,
} from '@forge/config';
import {
  createPrismaClient,
  heartbeatWorker,
  markWorkerDraining,
  markWorkerOffline,
  pingDatabase,
  registerWorker,
} from '@forge/database';
import { assertValidLeaseConfig } from '@forge/engine';
import { createLogger, serialiseError, type Logger } from '@forge/logger';
import {
  createMetrics,
  shutdownTelemetry,
  startMetricsServerAsync,
  stopMetricsServer,
} from '@forge/observability';
import { Transport } from '@forge/transport';

import { Consumer } from './consumer';
import { TaskExecutor } from './executor';
import { HandlerRegistry } from './handlers/registry';
import { BUILTIN_HANDLERS } from './handlers/builtin';
import { SIMULATION_HANDLERS } from './handlers/simulate';

/**
 * A FORGE worker.
 *
 * Stateless by construction: its identity is a UUID it generates at boot, it holds no
 * queue of its own, and everything it is doing is represented by leases in PostgreSQL.
 * Killing it at any instant is safe — the leases expire and the control plane returns
 * its work to the queue. That is the property the chaos test exercises.
 */

async function main(): Promise<void> {
  let config: WorkerConfig;
  try {
    config = loadConfig(WorkerConfigSchema, 'worker');
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  // A fresh id per process. A restarted worker is a *new* worker: reusing an id would
  // let it inherit leases it no longer holds and silently suppress recovery.
  const workerId = randomUUID();
  const workerName =
    config.FORGE_WORKER_NAME ?? 'worker-' + hostname().slice(0, 12) + '-' + workerId.slice(0, 6);

  const logger: Logger = createLogger({
    service: 'worker',
    level: config.FORGE_LOG_LEVEL,
    version: config.FORGE_VERSION,
    base: { workerId, workerName },
  });

  // Validated here rather than discovered when the first long task loses its lease.
  assertValidLeaseConfig({
    ttlMs: config.FORGE_WORKER_LEASE_TTL_MS,
    heartbeatIntervalMs: config.FORGE_WORKER_HEARTBEAT_MS,
    reclaimGraceMs: config.FORGE_WORKER_RECLAIM_GRACE_MS,
  });

  logger.info({ config: redactConfig(config) }, 'worker starting');

  const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
  const transport = new Transport({ url: config.REDIS_URL, logger });
  const metrics = createMetrics({ service: 'worker' });

  const registry = new HandlerRegistry({ demoMode: config.FORGE_DEMO_MODE, logger });
  registry.registerAll(BUILTIN_HANDLERS);
  if (config.FORGE_DEMO_MODE) {
    logger.warn(
      'FORGE_DEMO_MODE is enabled: failure-injection handlers are registered. Never enable this in production.',
    );
    registry.registerAll(SIMULATION_HANDLERS);
  }
  // The configured capability list is an intersection, not an assertion: a worker can
  // only advertise what it actually has a handler for.
  registry.restrictTo(config.FORGE_WORKER_CAPABILITIES);

  const capabilities = registry.types();
  if (capabilities.length === 0) {
    logger.fatal(
      { configured: config.FORGE_WORKER_CAPABILITIES },
      'no handlers registered — this worker could never execute anything',
    );
    process.exit(78);
  }

  await prisma.$connect();
  await transport.ping();

  await registerWorker(prisma, {
    id: workerId,
    name: workerName,
    hostname: hostname(),
    pid: process.pid,
    version: config.FORGE_VERSION,
    queues: config.FORGE_WORKER_QUEUES,
    capabilities,
    concurrency: config.FORGE_WORKER_CONCURRENCY,
  });

  logger.info(
    {
      queues: config.FORGE_WORKER_QUEUES,
      capabilities,
      concurrency: config.FORGE_WORKER_CONCURRENCY,
    },
    'worker registered',
  );

  const executor = new TaskExecutor({
    prisma,
    transport,
    logger,
    metrics,
    registry,
    workerId,
    leaseTtlMs: config.FORGE_WORKER_LEASE_TTL_MS,
    heartbeatMs: config.FORGE_WORKER_HEARTBEAT_MS,
  });

  const consumer = new Consumer({
    transport,
    executor,
    logger,
    queues: config.FORGE_WORKER_QUEUES,
    concurrency: config.FORGE_WORKER_CONCURRENCY,
    blockSeconds: config.FORGE_QUEUE_BLOCK_SECONDS,
  });

  // Process-level heartbeat, separate from per-task lease renewal. This one keeps the
  // *worker* visible in the fleet view; lease renewal keeps individual tasks alive.
  const heartbeat = setInterval(() => {
    void heartbeatWorker(prisma, workerId, executor.activeCount).catch((err: Error) => {
      logger.warn({ err: err.message }, 'worker heartbeat failed');
    });
  }, config.FORGE_WORKER_HEARTBEAT_MS);

  const metricsServer = await startMetricsServerAsync({
    port: config.FORGE_WORKER_METRICS_PORT,
    metrics,
    healthCheck: async () => {
      const [dbLatency, redisLatency] = await Promise.all([pingDatabase(prisma), transport.ping()]);
      return {
        ok: true,
        details: {
          workerId,
          activeTasks: executor.activeCount,
          capacity: config.FORGE_WORKER_CONCURRENCY,
          databaseLatencyMs: dbLatency,
          redisLatencyMs: redisLatency,
        },
      };
    },
    onListening: (port) => logger.info({ port }, 'metrics server listening'),
  });

  // --- graceful shutdown ---------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, activeTasks: executor.activeCount }, 'worker shutting down');

    clearInterval(heartbeat);
    // DRAINING tells the console this worker is on its way out while it finishes.
    await markWorkerDraining(prisma, workerId).catch(() => undefined);

    const result = await consumer.stop(config.FORGE_WORKER_SHUTDOWN_GRACE_MS);
    await markWorkerOffline(prisma, workerId).catch(() => undefined);

    await stopMetricsServer(metricsServer);
    await transport.close();
    await prisma.$disconnect();
    await shutdownTelemetry();

    logger.info({ drained: result.drained, abandoned: result.abandoned }, 'worker stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: serialiseError(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: serialiseError(err) }, 'uncaught exception, exiting');
    process.exit(1);
  });

  await consumer.start();
}

void main().catch((err: unknown) => {
  console.error('worker failed to start:', err);
  process.exit(1);
});
