import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Every runtime validates its slice of the environment at boot and exits non-zero on a
 * bad value. A worker that starts with `FORGE_WORKER_LEASE_TTL_MS=abc` and only
 * discovers it when the first task arrives is far more expensive to debug than one that
 * refuses to start.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

export const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FORGE_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  FORGE_VERSION: z.string().default('0.1.0'),
});

export const DatabaseConfigSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('postgres'), {
      message: 'DATABASE_URL must be a postgresql:// connection string',
    }),
  FORGE_DB_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),
});

export const RedisConfigSchema = z.object({
  REDIS_URL: z.string().refine((u) => u.startsWith('redis://') || u.startsWith('rediss://'), {
    message: 'REDIS_URL must be a redis:// or rediss:// connection string',
  }),
});

export const ObservabilityConfigSchema = z.object({
  OTEL_ENABLED: booleanish.default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://localhost:4318'),
  OTEL_SERVICE_NAMESPACE: z.string().default('forge'),
});

export const DemoConfigSchema = z.object({
  /**
   * Gates the `simulate.*` handlers and the failure-injection endpoints.
   * Enabling this in production would hand callers a way to stall the fleet, so the
   * API refuses to start with FORGE_DEMO_MODE=true and NODE_ENV=production.
   */
  FORGE_DEMO_MODE: booleanish.default(false),
});

export const ApiConfigSchema = BaseConfigSchema.merge(DatabaseConfigSchema)
  .merge(RedisConfigSchema)
  .merge(ObservabilityConfigSchema)
  .merge(DemoConfigSchema)
  .extend({
    FORGE_API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    FORGE_API_HOST: z.string().default('0.0.0.0'),
    FORGE_CORS_ORIGIN: csv('http://localhost:3000'),
    FORGE_AUTH_ENABLED: booleanish.default(true),
    FORGE_API_KEY: z.string().min(8).default('dev-local-key'),
    FORGE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
    FORGE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
    FORGE_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
    FORGE_SSE_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15_000),
    FORGE_WORKER_LIVENESS_MS: z.coerce.number().int().min(1000).default(20_000),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production' && cfg.FORGE_DEMO_MODE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FORGE_DEMO_MODE'],
        message: 'FORGE_DEMO_MODE must be false when NODE_ENV=production',
      });
    }
    if (
      cfg.NODE_ENV === 'production' &&
      cfg.FORGE_AUTH_ENABLED &&
      cfg.FORGE_API_KEY === 'dev-local-key'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FORGE_API_KEY'],
        message: 'refusing to start in production with the default development API key',
      });
    }
  });
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export const WorkerConfigSchema = BaseConfigSchema.merge(DatabaseConfigSchema)
  .merge(RedisConfigSchema)
  .merge(ObservabilityConfigSchema)
  .merge(DemoConfigSchema)
  .extend({
    FORGE_WORKER_NAME: z.string().max(64).optional(),
    FORGE_WORKER_QUEUES: csv('default'),
    FORGE_WORKER_CAPABILITIES: csv('noop,delay,compute,http.echo'),
    FORGE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    FORGE_WORKER_HEARTBEAT_MS: z.coerce.number().int().min(250).default(2_000),
    FORGE_WORKER_LEASE_TTL_MS: z.coerce.number().int().min(1_000).default(15_000),
    FORGE_WORKER_RECLAIM_GRACE_MS: z.coerce.number().int().min(0).default(3_000),
    FORGE_WORKER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9101),
    /** Seconds to finish in-flight work on SIGTERM before exiting. */
    FORGE_WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10_000),
    FORGE_QUEUE_BLOCK_SECONDS: z.coerce.number().int().min(1).max(30).default(2),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.FORGE_WORKER_HEARTBEAT_MS * 3 > cfg.FORGE_WORKER_LEASE_TTL_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FORGE_WORKER_HEARTBEAT_MS'],
        message:
          'heartbeat interval must be at most one third of the lease TTL so a worker can miss two heartbeats without losing its lease',
      });
    }
  });
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const SchedulerConfigSchema = BaseConfigSchema.merge(DatabaseConfigSchema)
  .merge(RedisConfigSchema)
  .merge(ObservabilityConfigSchema)
  .extend({
    FORGE_SCHEDULER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9102),
    FORGE_OUTBOX_POLL_MS: z.coerce.number().int().min(25).default(250),
    FORGE_OUTBOX_BATCH: z.coerce.number().int().min(1).max(2000).default(200),
    FORGE_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
    FORGE_REAPER_POLL_MS: z.coerce.number().int().min(100).default(2_000),
    FORGE_REAPER_GRACE_MS: z.coerce.number().int().min(0).default(3_000),
    FORGE_RETRY_POLL_MS: z.coerce.number().int().min(100).default(500),
    FORGE_SCHEDULE_POLL_MS: z.coerce.number().int().min(200).default(1_000),
    FORGE_ADVANCE_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    /** Heartbeat age after which a worker is flagged UNRESPONSIVE. */
    FORGE_WORKER_LIVENESS_MS: z.coerce.number().int().min(1000).default(20_000),
    /**
     * Heartbeat age after which a dead worker's row is deleted. Long enough that a
     * restarting worker still appears in the fleet view while it comes back, short
     * enough that the view is not a graveyard. Rows holding an unreleased lease are
     * never pruned regardless — the reaper needs them to attribute the recovery.
     */
    FORGE_WORKER_PRUNE_MS: z.coerce.number().int().min(60_000).default(900_000),
    FORGE_RUN_TIMEOUT_POLL_MS: z.coerce.number().int().min(1000).default(5_000),
  });
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

export class ConfigError extends Error {
  constructor(
    readonly service: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(
      'invalid configuration for ' +
        service +
        ':\n' +
        issues.map((i) => '  - ' + i.path.join('.') + ': ' + i.message).join('\n'),
    );
    this.name = 'ConfigError';
  }
}

/**
 * Parse and validate. Throws `ConfigError` listing every problem at once — fixing one
 * env var per restart is a miserable loop.
 */
export function loadConfig<T extends z.ZodTypeAny>(
  schema: T,
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) throw new ConfigError(service, result.error.issues);
  return result.data;
}

/** Redact a config object for logging at boot. */
export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (/KEY|SECRET|TOKEN|PASSWORD/i.test(key)) {
      out[key] = '[redacted]';
    } else if (key === 'DATABASE_URL' || key === 'REDIS_URL') {
      out[key] = redactConnectionString(String(value));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Strip credentials from a connection string so it is safe to log. */
export function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = parsed.username.slice(0, 2) + '***';
    return parsed.toString();
  } catch {
    return '[unparseable-url]';
  }
}
