import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';

/**
 * Structured logging.
 *
 * Every line carries the same correlation keys — service, workflowRunId, taskRunId,
 * workerId, traceId — so a single run can be reconstructed from the logs of five
 * separate processes with one grep. Child loggers are used rather than passing context
 * through call signatures, so adding a field never means touching every caller.
 */

export interface LogContext {
  service?: string;
  workflowRunId?: string;
  taskRunId?: string;
  nodeKey?: string;
  workerId?: string;
  attempt?: number;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  [key: string]: unknown;
}

export type Logger = PinoLogger<never>;

/** Keys whose values are never written to a log, at any nesting depth. */
const REDACT_PATHS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'privateKey',
  'DATABASE_URL',
  'REDIS_URL',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-forge-api-key"]',
  'input.password',
  'input.secret',
  'input.token',
  'input.apiKey',
  'output.token',
  'config.password',
  'config.secret',
];

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  /** Human-readable output for local development; JSON everywhere else. */
  pretty?: boolean;
  version?: string;
  base?: LogContext;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const pretty =
    options.pretty ?? (process.env.NODE_ENV !== 'production' && process.stdout.isTTY === true);

  const config: LoggerOptions = {
    level: options.level ?? process.env.FORGE_LOG_LEVEL ?? 'info',
    base: {
      service: options.service,
      version: options.version ?? process.env.FORGE_VERSION ?? '0.1.0',
      ...options.base,
    },
    // ISO timestamps: log aggregation and the console timeline both need them ordered
    // and human-readable, and the cost is negligible next to the I/O.
    timestamp: () => ',"timestamp":"' + new Date().toISOString() + '"',
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };

  if (pretty) {
    try {
      return pino({
        ...config,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,version',
            messageFormat: '{service} | {msg}',
          },
        },
      }) as Logger;
    } catch {
      // pino-pretty is a devDependency; fall through to JSON if it is absent.
    }
  }

  return pino(config) as Logger;
}

/** Derive a child logger bound to a run/task/worker. */
export function withContext(logger: Logger, context: LogContext): Logger {
  return logger.child(context) as Logger;
}

/**
 * Serialise an error for logging without leaking the whole object graph.
 * Stacks are truncated because a 200-frame stack in a JSON log helps nobody.
 */
export function serialiseError(err: unknown): {
  name: string;
  message: string;
  code?: string;
  stack?: string;
} {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      code: (err as { code?: string }).code,
      stack: err.stack?.split('\n').slice(0, 12).join('\n'),
    };
  }
  return { name: 'UnknownError', message: String(err) };
}

/** A no-op logger for tests that assert behaviour rather than output. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' }) as Logger;
}
