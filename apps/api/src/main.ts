import './telemetry';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigError } from '@forge/config';
import { shutdownTelemetry } from '@forge/observability';
import { serialiseError } from '@forge/logger';

import { AppModule } from './app.module';
import { config, FORGE_LOGGER, type Logger } from './infra/providers';

/**
 * API entrypoint.
 *
 * The API is a control plane, not a data plane: it validates, persists, and returns.
 * It never executes a task, never blocks on a worker, and never holds a run's state in
 * memory. Every endpoint either commits a transaction or reads one.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest's own logger is replaced by the structured one so every line in the process
    // shares a format and correlation keys.
    logger: ['error', 'warn'],
    bodyParser: true,
  });

  const logger = app.get<Logger>(FORGE_LOGGER);

  // A workflow definition with 250 nodes is legitimately large; anything past the limit
  // is rejected before it reaches the JSON parser rather than after.
  app.useBodyParser('json', { limit: config.FORGE_BODY_LIMIT_BYTES });

  app.enableCors({
    origin: config.FORGE_CORS_ORIGIN,
    credentials: false,
    allowedHeaders: ['content-type', 'x-forge-api-key', 'idempotency-key', 'last-event-id'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // `x-powered-by` advertises the framework and version for no benefit.
  app.disable('x-powered-by');
  // Behind the compose/ingress proxy, so `req.ip` reflects the real client.
  app.set('trust proxy', 1);

  app.enableShutdownHooks();

  await app.listen(config.FORGE_API_PORT, config.FORGE_API_HOST);

  logger.info(
    {
      port: config.FORGE_API_PORT,
      host: config.FORGE_API_HOST,
      authEnabled: config.FORGE_AUTH_ENABLED,
      demoMode: config.FORGE_DEMO_MODE,
      corsOrigin: config.FORGE_CORS_ORIGIN,
    },
    'forge api listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'api shutting down');
    // `close()` stops accepting connections and waits for in-flight requests, then runs
    // the module destroy hooks that disconnect Prisma and Redis.
    await app.close();
    await shutdownTelemetry();
    logger.info('api stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: serialiseError(reason) }, 'unhandled rejection');
  });
}

void bootstrap().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(78); // EX_CONFIG
  }

  console.error('api failed to start:', err);
  process.exit(1);
});
