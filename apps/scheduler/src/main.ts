import './telemetry';

import {
  SchedulerConfigSchema,
  loadConfig,
  redactConfig,
  ConfigError,
  type SchedulerConfig,
} from '@forge/config';
import {
  createPrismaClient,
  outboxHealth,
  pingDatabase,
  queueDepths,
  reconcileSchedules,
  fleetSummary,
} from '@forge/database';
import { createLogger, serialiseError, type Logger } from '@forge/logger';
import {
  createMetrics,
  shutdownTelemetry,
  startMetricsServerAsync,
  stopMetricsServer,
} from '@forge/observability';
import { Transport } from '@forge/transport';

import { Loop, LoopSupervisor } from './loop';
import { createOutboxPublisher } from './loops/outbox-publisher';
import { createAdvancer } from './loops/advancer';
import {
  createCronScheduler,
  createLeaseReaper,
  createLivenessSweeper,
  createMaintenanceSweeper,
  createRetrySweeper,
  createRunTimeoutSweeper,
} from './loops/sweepers';

/**
 * The FORGE control plane.
 *
 * One process hosting six independent loops. They are co-located rather than split into
 * six deployments because they share a connection pool and a Prisma client, they all
 * scale on the same axis, and each is a few hundred lines — six containers would be
 * operational cost with no isolation benefit. Every loop is independently safe to run on
 * N replicas, so scaling out is still `--scale scheduler=3`.
 *
 * Nothing here executes user code. Task execution is exclusively the worker's job.
 */

async function main(): Promise<void> {
  let config: SchedulerConfig;
  try {
    config = loadConfig(SchedulerConfigSchema, 'scheduler');
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const logger: Logger = createLogger({
    service: 'scheduler',
    level: config.FORGE_LOG_LEVEL,
    version: config.FORGE_VERSION,
  });

  logger.info({ config: redactConfig(config) }, 'control plane starting');

  const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
  const transport = new Transport({ url: config.REDIS_URL, logger });
  const metrics = createMetrics({ service: 'scheduler' });

  // Fleet-wide gauges are read from PostgreSQL at scrape time rather than accumulated
  // in this process, so the numbers stay correct with several replicas running.
  metrics.setCollectors({
    queueDepth: () => queueDepths(prisma),
    workerCounts: async () => {
      const fleet = await fleetSummary(prisma);
      return {
        ONLINE: fleet.online,
        UNRESPONSIVE: fleet.unresponsive,
        OFFLINE: fleet.offline,
      };
    },
    workerActiveTasks: async () => (await fleetSummary(prisma)).activeTasks,
    outbox: async () => {
      const health = await outboxHealth(prisma);
      return { pending: health.pending, oldestPendingAgeMs: health.oldestPendingAgeMs };
    },
  });

  await prisma.$connect();
  await transport.ping();
  const reconciled = await reconcileSchedules(prisma);
  if (reconciled > 0) logger.info({ schedules: reconciled }, 'schedules reconciled at startup');

  const deps = { prisma, logger, metrics };
  const supervisor = new LoopSupervisor();

  supervisor.add(
    new Loop({
      name: 'outbox-publisher',
      intervalMs: config.FORGE_OUTBOX_POLL_MS,
      logger,
      tick: createOutboxPublisher({
        prisma,
        transport,
        logger,
        metrics,
        batchSize: config.FORGE_OUTBOX_BATCH,
        maxAttempts: config.FORGE_OUTBOX_MAX_ATTEMPTS,
      }),
    }),
  );

  // Several advancer loops so one slow run cannot stall the whole queue. Each blocks on
  // its own Redis connection, which is why the count is bounded by config.
  const advance = createAdvancer({ prisma, transport, logger, metrics, blockSeconds: 2 });
  for (let i = 0; i < config.FORGE_ADVANCE_CONCURRENCY; i++) {
    supervisor.add(
      new Loop({
        name: 'advancer-' + i,
        // The advancer blocks on BRPOP, so its own interval only matters after an error.
        intervalMs: 25,
        logger,
        tick: advance,
      }),
    );
  }

  supervisor.add(
    new Loop({
      name: 'lease-reaper',
      intervalMs: config.FORGE_REAPER_POLL_MS,
      logger,
      tick: createLeaseReaper({ ...deps, graceMs: config.FORGE_REAPER_GRACE_MS }),
    }),
  );

  supervisor.add(
    new Loop({
      name: 'retry-sweeper',
      intervalMs: config.FORGE_RETRY_POLL_MS,
      logger,
      tick: createRetrySweeper(deps),
    }),
  );

  supervisor.add(
    new Loop({
      name: 'run-timeout-sweeper',
      intervalMs: config.FORGE_RUN_TIMEOUT_POLL_MS,
      logger,
      tick: createRunTimeoutSweeper(deps),
    }),
  );

  supervisor.add(
    new Loop({
      name: 'cron-scheduler',
      intervalMs: config.FORGE_SCHEDULE_POLL_MS,
      logger,
      tick: createCronScheduler(deps),
    }),
  );

  supervisor.add(
    new Loop({
      name: 'worker-liveness',
      intervalMs: 5_000,
      logger,
      tick: createLivenessSweeper({
        ...deps,
        livenessMs: config.FORGE_WORKER_LIVENESS_MS,
        pruneAfterMs: config.FORGE_WORKER_PRUNE_MS,
      }),
    }),
  );

  supervisor.add(
    new Loop({
      name: 'maintenance',
      intervalMs: 60_000,
      logger,
      tick: createMaintenanceSweeper({ ...deps, outboxRetentionMs: 6 * 60 * 60 * 1000 }),
    }),
  );

  const metricsServer = await startMetricsServerAsync({
    port: config.FORGE_SCHEDULER_METRICS_PORT,
    metrics,
    healthCheck: async () => {
      const [dbLatency, redisLatency, outbox] = await Promise.all([
        pingDatabase(prisma),
        transport.ping(),
        outboxHealth(prisma),
      ]);
      // Sustained outbox lag means dispatches are not reaching workers, which is the
      // one control-plane failure that is invisible in every other signal.
      const healthy = outbox.oldestPendingAgeMs === null || outbox.oldestPendingAgeMs < 30_000;
      return {
        ok: healthy,
        details: {
          databaseLatencyMs: dbLatency,
          redisLatencyMs: redisLatency,
          outboxPending: outbox.pending,
          outboxLagMs: outbox.oldestPendingAgeMs,
        },
      };
    },
    onListening: (port) => logger.info({ port }, 'metrics server listening'),
  });

  await supervisor.startAll();
  logger.info('control plane ready');

  // --- graceful shutdown ---------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'control plane shutting down');

    // Loops stop after their current iteration, so no transaction is ever interrupted.
    await supervisor.stopAll();
    await stopMetricsServer(metricsServer);
    await transport.close();
    await prisma.$disconnect();
    await shutdownTelemetry();
    logger.info('control plane stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: serialiseError(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    // An uncaught exception means the process is in an unknown state; log and exit so
    // the supervisor restarts it cleanly rather than limping on.
    logger.fatal({ err: serialiseError(err) }, 'uncaught exception, exiting');
    void shutdown('uncaughtException').finally(() => process.exit(1));
  });
}

void main().catch((err: unknown) => {
  console.error('control plane failed to start:', err);
  process.exit(1);
});
