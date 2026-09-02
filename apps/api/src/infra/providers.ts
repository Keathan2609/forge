import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiConfigSchema, loadConfig, type ApiConfig } from '@forge/config';
import {
  createPrismaClient,
  fleetSummary,
  outboxHealth,
  queueDepths,
  type PrismaClient,
} from '@forge/database';
import { createLogger, type Logger } from '@forge/logger';
import { createMetrics, type ForgeMetrics } from '@forge/observability';
import { Transport } from '@forge/transport';

/**
 * Infrastructure providers.
 *
 * Config, database, transport, logger and metrics are constructed once and injected
 * everywhere. They live in a `@Global()` module because every feature module needs at
 * least two of them, and threading imports through eight modules would be noise rather
 * than encapsulation.
 */

export const FORGE_CONFIG = Symbol('FORGE_CONFIG');
export const FORGE_PRISMA = Symbol('FORGE_PRISMA');
export const FORGE_TRANSPORT = Symbol('FORGE_TRANSPORT');
export const FORGE_LOGGER = Symbol('FORGE_LOGGER');
export const FORGE_METRICS = Symbol('FORGE_METRICS');

export const InjectConfig = (): ParameterDecorator => Inject(FORGE_CONFIG);
export const InjectPrisma = (): ParameterDecorator => Inject(FORGE_PRISMA);
export const InjectTransport = (): ParameterDecorator => Inject(FORGE_TRANSPORT);
export const InjectLogger = (): ParameterDecorator => Inject(FORGE_LOGGER);
export const InjectMetrics = (): ParameterDecorator => Inject(FORGE_METRICS);

/** Loaded once at module construction so a bad environment fails before the port binds. */
export const config: ApiConfig = loadConfig(ApiConfigSchema, 'api');

const logger = createLogger({
  service: 'api',
  level: config.FORGE_LOG_LEVEL,
  version: config.FORGE_VERSION,
});

const metrics = createMetrics({ service: 'api' });
const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
const transport = new Transport({ url: config.REDIS_URL, logger });

// Fleet-wide gauges read from PostgreSQL at scrape time, so several API replicas each
// report the whole truth rather than their own slice of it.
metrics.setCollectors({
  queueDepth: () => queueDepths(prisma),
  workerCounts: async () => {
    const fleet = await fleetSummary(prisma);
    return { ONLINE: fleet.online, UNRESPONSIVE: fleet.unresponsive, OFFLINE: fleet.offline };
  },
  workerActiveTasks: async () => (await fleetSummary(prisma)).activeTasks,
  outbox: async () => {
    const health = await outboxHealth(prisma);
    return { pending: health.pending, oldestPendingAgeMs: health.oldestPendingAgeMs };
  },
});

@Injectable()
export class Lifecycle implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await prisma.$connect();
    await transport.ping();
    logger.info({ port: config.FORGE_API_PORT }, 'api dependencies connected');
  }

  async onModuleDestroy(): Promise<void> {
    await transport.close();
    await prisma.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    { provide: FORGE_CONFIG, useValue: config },
    { provide: FORGE_PRISMA, useValue: prisma },
    { provide: FORGE_TRANSPORT, useValue: transport },
    { provide: FORGE_LOGGER, useValue: logger },
    { provide: FORGE_METRICS, useValue: metrics },
    Lifecycle,
  ],
  exports: [FORGE_CONFIG, FORGE_PRISMA, FORGE_TRANSPORT, FORGE_LOGGER, FORGE_METRICS],
})
export class InfraModule {}

export type { ApiConfig, PrismaClient, Logger, ForgeMetrics, Transport };
