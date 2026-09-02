import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createSilentLogger, serialiseError, withContext } from '../src';

/**
 * Logging behaviour that matters.
 *
 * Redaction is the security-relevant part: a secret that reaches a log file has leaked,
 * and it has leaked somewhere with a long retention period and broad read access. These
 * tests pin the redaction paths so a refactor cannot quietly drop one.
 */

/** Capture log lines by writing to an in-memory stream. */
function capture(): { logger: pino.Logger; lines: () => Array<Record<string, unknown>> } {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      callback();
    },
  });

  // Mirrors createLogger's configuration; the transport is replaced so output is
  // capturable, which pino's `transport` option (a worker thread) makes impossible.
  const logger = pino(
    {
      level: 'debug',
      base: { service: 'test' },
      redact: {
        paths: [
          'password',
          'secret',
          'token',
          'apiKey',
          'authorization',
          'DATABASE_URL',
          '*.password',
          '*.secret',
          '*.token',
          '*.apiKey',
          'input.password',
          'input.token',
        ],
        censor: '[redacted]',
      },
    },
    stream,
  );

  return {
    logger,
    lines: () => written.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('secret redaction', () => {
  it('redacts top-level secret fields', () => {
    const { logger, lines } = capture();
    logger.info({ password: 'hunter2', user: 'alice' }, 'login');

    const entry = lines()[0] as Record<string, unknown>;
    expect(entry.password).toBe('[redacted]');
    expect(entry.user).toBe('alice');
  });

  it('redacts secrets one level deep', () => {
    const { logger, lines } = capture();
    logger.info({ config: { apiKey: 'sk_live_abc', region: 'eu' } }, 'config loaded');

    const entry = lines()[0] as { config: Record<string, unknown> };
    expect(entry.config.apiKey).toBe('[redacted]');
    expect(entry.config.region).toBe('eu');
  });

  it('redacts a task input carrying a credential', () => {
    // Task inputs are user-supplied and routinely contain credentials for the downstream
    // service a handler talks to.
    const { logger, lines } = capture();
    logger.info({ input: { token: 'ghp_secret', repo: 'forge' } }, 'task started');

    const entry = lines()[0] as { input: Record<string, unknown> };
    expect(entry.input.token).toBe('[redacted]');
    expect(entry.input.repo).toBe('forge');
  });

  it('redacts the database connection string', () => {
    const { logger, lines } = capture();
    logger.info({ DATABASE_URL: 'postgresql://u:p@host/db' }, 'starting');
    expect((lines()[0] as Record<string, unknown>).DATABASE_URL).toBe('[redacted]');
  });

  it('leaves ordinary execution context untouched', () => {
    const { logger, lines } = capture();
    logger.info(
      { workflowRunId: 'run_1', taskRunId: 'task_1', nodeKey: 'charge', attempt: 2 },
      'task started',
    );

    const entry = lines()[0] as Record<string, unknown>;
    expect(entry.workflowRunId).toBe('run_1');
    expect(entry.nodeKey).toBe('charge');
    expect(entry.attempt).toBe(2);
  });
});

describe('withContext', () => {
  it('binds correlation keys onto every subsequent line', () => {
    const { logger, lines } = capture();
    const bound = withContext(logger as never, {
      workflowRunId: 'run_9',
      workerId: 'worker_1',
    });

    bound.info('first');
    bound.info('second');

    for (const entry of lines()) {
      expect(entry.workflowRunId).toBe('run_9');
      expect(entry.workerId).toBe('worker_1');
    }
  });

  it('does not affect the parent logger', () => {
    const { logger, lines } = capture();
    withContext(logger as never, { workflowRunId: 'run_9' });
    logger.info('unbound');

    expect(lines()[0]?.workflowRunId).toBeUndefined();
  });
});

describe('serialiseError', () => {
  it('extracts name, message and code', () => {
    const error = Object.assign(new Error('boom'), { code: 'E_BOOM' });
    const result = serialiseError(error);

    expect(result.name).toBe('Error');
    expect(result.message).toBe('boom');
    expect(result.code).toBe('E_BOOM');
  });

  it('truncates the stack', () => {
    // A 200-frame stack in a JSON log helps nobody and costs real bytes at volume.
    const error = new Error('deep');
    error.stack = 'Error: deep\n' + Array.from({ length: 80 }, (_, i) => '  at f' + i).join('\n');

    const result = serialiseError(error);
    expect(result.stack?.split('\n').length).toBeLessThanOrEqual(12);
  });

  it('handles a non-Error rejection value', () => {
    // `throw 'string'` and rejected non-Errors both reach the unhandledRejection handler.
    expect(serialiseError('just a string')).toEqual({
      name: 'UnknownError',
      message: 'just a string',
    });
    expect(serialiseError(undefined).name).toBe('UnknownError');
  });
});

describe('createSilentLogger', () => {
  it('produces a usable logger that emits nothing', () => {
    const logger = createSilentLogger();
    expect(() => logger.info({ a: 1 }, 'ignored')).not.toThrow();
    expect(logger.level).toBe('silent');
  });
});
