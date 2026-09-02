import { describe, expect, it } from 'vitest';
import {
  ApiConfigSchema,
  ConfigError,
  SchedulerConfigSchema,
  WorkerConfigSchema,
  loadConfig,
  redactConfig,
  redactConnectionString,
} from '../src';

/**
 * Environment validation.
 *
 * The point of validating at boot is that a misconfigured process refuses to start rather
 * than failing at first use — a worker whose heartbeat interval exceeds a third of its
 * lease TTL looks perfectly healthy right up until every long task loses its lease.
 */

const base = {
  DATABASE_URL: 'postgresql://forge:forge@localhost:5432/forge',
  REDIS_URL: 'redis://localhost:6379',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies defaults for everything optional', () => {
    const config = loadConfig(ApiConfigSchema, 'api', base);
    expect(config.FORGE_API_PORT).toBe(4000);
    expect(config.FORGE_LOG_LEVEL).toBe('info');
    expect(config.NODE_ENV).toBe('development');
    expect(config.FORGE_DEMO_MODE).toBe(false);
  });

  it('reports every problem at once', () => {
    // Fixing one variable per restart is a miserable loop.
    try {
      loadConfig(ApiConfigSchema, 'api', {
        DATABASE_URL: 'not-a-url',
        REDIS_URL: 'http://wrong-protocol',
      } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.length).toBeGreaterThanOrEqual(2);
      expect((err as ConfigError).message).toContain('DATABASE_URL');
      expect((err as ConfigError).message).toContain('REDIS_URL');
    }
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      loadConfig(ApiConfigSchema, 'api', {
        ...base,
        DATABASE_URL: 'mysql://localhost/db',
      } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it('parses booleanish values the way a shell writes them', () => {
    for (const value of ['true', '1', 'yes', 'on', 'TRUE']) {
      const config = loadConfig(ApiConfigSchema, 'api', {
        ...base,
        FORGE_DEMO_MODE: value,
      } as NodeJS.ProcessEnv);
      expect(config.FORGE_DEMO_MODE, value).toBe(true);
    }
    for (const value of ['false', '0', 'no', '']) {
      const config = loadConfig(ApiConfigSchema, 'api', {
        ...base,
        FORGE_DEMO_MODE: value,
      } as NodeJS.ProcessEnv);
      expect(config.FORGE_DEMO_MODE, value).toBe(false);
    }
  });

  it('splits comma-separated lists and trims them', () => {
    const config = loadConfig(WorkerConfigSchema, 'worker', {
      ...base,
      FORGE_WORKER_QUEUES: 'default, media ,deploy',
    } as NodeJS.ProcessEnv);
    expect(config.FORGE_WORKER_QUEUES).toEqual(['default', 'media', 'deploy']);
  });
});

describe('safety refusals', () => {
  it('refuses demo mode in production', () => {
    // Demo mode registers handlers that deliberately kill their own worker.
    expect(() =>
      loadConfig(ApiConfigSchema, 'api', {
        ...base,
        NODE_ENV: 'production',
        FORGE_DEMO_MODE: 'true',
        FORGE_API_KEY: 'a-real-production-key',
      } as NodeJS.ProcessEnv),
    ).toThrow(/FORGE_DEMO_MODE must be false/);
  });

  it('refuses the default API key in production', () => {
    expect(() =>
      loadConfig(ApiConfigSchema, 'api', {
        ...base,
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv),
    ).toThrow(/default development API key/);
  });

  it('allows the default key when auth is disabled', () => {
    const config = loadConfig(ApiConfigSchema, 'api', {
      ...base,
      NODE_ENV: 'production',
      FORGE_AUTH_ENABLED: 'false',
    } as NodeJS.ProcessEnv);
    expect(config.FORGE_AUTH_ENABLED).toBe(false);
  });

  it('refuses a heartbeat interval too close to the lease TTL', () => {
    expect(() =>
      loadConfig(WorkerConfigSchema, 'worker', {
        ...base,
        FORGE_WORKER_LEASE_TTL_MS: '5000',
        FORGE_WORKER_HEARTBEAT_MS: '4000',
      } as NodeJS.ProcessEnv),
    ).toThrow(/one third of the lease TTL/);
  });

  it('accepts a heartbeat at exactly one third', () => {
    const config = loadConfig(WorkerConfigSchema, 'worker', {
      ...base,
      FORGE_WORKER_LEASE_TTL_MS: '9000',
      FORGE_WORKER_HEARTBEAT_MS: '3000',
    } as NodeJS.ProcessEnv);
    expect(config.FORGE_WORKER_LEASE_TTL_MS).toBe(9000);
  });
});

describe('redaction', () => {
  it('strips credentials from a connection string', () => {
    const redacted = redactConnectionString('postgresql://user:hunter2@host:5432/db');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('host');
  });

  it('does not throw on an unparseable url', () => {
    expect(redactConnectionString('not a url')).toBe('[unparseable-url]');
  });

  it('redacts secrets when logging config at boot', () => {
    const config = loadConfig(SchedulerConfigSchema, 'scheduler', base);
    const redacted = redactConfig(config as unknown as Record<string, unknown>);

    expect(String(redacted.DATABASE_URL)).not.toContain('forge:forge@');
    expect(redacted.FORGE_OUTBOX_POLL_MS).toBe(250);
  });

  it('redacts anything key-shaped', () => {
    const redacted = redactConfig({
      FORGE_API_KEY: 'sk_live_x',
      SOME_SECRET: 'y',
      AUTH_TOKEN: 'z',
      PORT: 4000,
    });
    expect(redacted.FORGE_API_KEY).toBe('[redacted]');
    expect(redacted.SOME_SECRET).toBe('[redacted]');
    expect(redacted.AUTH_TOKEN).toBe('[redacted]');
    expect(redacted.PORT).toBe(4000);
  });
});
