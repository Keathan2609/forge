import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '@forge/logger';
import {
  HandlerRegistry,
  NonRetryableError,
  UnknownHandlerError,
  type TaskContext,
} from '../../src/handlers/registry';
import { BUILTIN_HANDLERS } from '../../src/handlers/builtin';
import { SIMULATION_HANDLERS } from '../../src/handlers/simulate';

/**
 * Handler registry and built-in handlers.
 *
 * The registry is a security boundary: a node's `type` is a key into a map of code the
 * worker already contains, never something it interprets. These tests pin that, and pin
 * the demo-only gating that keeps failure-injection handlers out of production.
 */

function registry(demoMode = false): HandlerRegistry {
  return new HandlerRegistry({ demoMode, logger: createSilentLogger() });
}

function context(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    workflowRunId: 'run_1',
    taskRunId: 'task_1',
    workflowKey: 'wf',
    nodeKey: 'node',
    attempt: 1,
    workerId: 'worker_1',
    logger: createSilentLogger(),
    signal: new AbortController().signal,
    progress: () => undefined,
    isCancelled: () => false,
    ...overrides,
  };
}

describe('HandlerRegistry', () => {
  it('registers and resolves a handler', () => {
    const r = registry().registerAll(BUILTIN_HANDLERS);
    expect(r.has('noop')).toBe(true);
    expect(r.get('noop').type).toBe('noop');
  });

  it('throws a helpful error for an unknown type', () => {
    const r = registry().registerAll(BUILTIN_HANDLERS);
    try {
      r.get('definitely.not.registered');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownHandlerError);
      // The message lists what this worker *can* run, which is the first thing you want
      // when a task fails with UNKNOWN_HANDLER.
      expect((err as UnknownHandlerError).message).toContain('noop');
      expect((err as UnknownHandlerError).code).toBe('UNKNOWN_HANDLER');
    }
  });

  it('refuses to register the same type twice', () => {
    const r = registry().registerAll(BUILTIN_HANDLERS);
    const [first] = BUILTIN_HANDLERS;
    expect(first).toBeDefined();
    if (!first) return;
    expect(() => r.register(first)).toThrow(/already registered/);
  });

  it('omits demo-only handlers unless demo mode is on', () => {
    // The whole point: a production worker cannot be talked into killing itself.
    const production = registry(false).registerAll(SIMULATION_HANDLERS);
    expect(production.types()).toEqual([]);

    const demo = registry(true).registerAll(SIMULATION_HANDLERS);
    expect(demo.types()).toContain('simulate.crash');
  });

  it('restricts advertised capabilities to the configured intersection', () => {
    // A worker can only advertise what it actually has a handler for — so one image can
    // serve several pools without the control plane routing work it cannot run.
    const r = registry().registerAll(BUILTIN_HANDLERS).restrictTo(['noop', 'delay']);
    expect(r.types()).toEqual(['delay', 'noop']);
    expect(r.has('compute')).toBe(false);
  });

  it('ignores a configured capability with no handler behind it', () => {
    const r = registry().registerAll(BUILTIN_HANDLERS).restrictTo(['noop', 'imaginary']);
    expect(r.types()).toEqual(['noop']);
  });

  it('treats an empty restriction as "no restriction"', () => {
    const r = registry().registerAll(BUILTIN_HANDLERS).restrictTo([]);
    expect(r.types().length).toBeGreaterThan(1);
  });
});

describe('built-in handlers', () => {
  const r = registry().registerAll(BUILTIN_HANDLERS);

  it('noop echoes its input', async () => {
    const result = await r.get('noop').handler({ a: 1 }, context());
    expect(result).toEqual({ ok: true, echoed: { a: 1 } });
  });

  it('compute performs the named operation', async () => {
    const compute = r.get('compute').handler;
    expect(await compute({ operation: 'sum', values: [1, 2, 3] }, context())).toEqual({
      result: 6,
      count: 3,
    });
    expect(await compute({ operation: 'max', values: [1, 9, 3] }, context())).toMatchObject({
      result: 9,
    });
    expect(await compute({ operation: 'mean', values: [2, 4] }, context())).toMatchObject({
      result: 3,
    });
  });

  it('compute rejects an unknown operation as non-retryable', async () => {
    // Retrying an unknown operation will never make it known; spending the budget on it
    // just delays the inevitable failure.
    await expect(
      r.get('compute').handler({ operation: 'nope', values: [1] }, context()),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('compute rejects non-numeric values', async () => {
    await expect(
      r.get('compute').handler({ operation: 'sum', values: [1, 'two'] }, context()),
    ).rejects.toThrow(/must be numbers/);
  });

  it('validate reports every missing field at once', async () => {
    await expect(
      r.get('validate').handler({ required: ['a', 'b', 'c'], payload: { a: 1 } }, context()),
    ).rejects.toThrow(/b, c/);
  });

  it('validate treats an explicit null as missing', async () => {
    await expect(
      r.get('validate').handler({ required: ['a'], payload: { a: null } }, context()),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('transform projects through a mapping and nulls absent keys', async () => {
    const result = await r
      .get('transform')
      .handler(
        { source: { orderId: 'o1' }, mapping: { id: 'orderId', missing: 'nope' } },
        context(),
      );
    expect(result).toEqual({ result: { id: 'o1', missing: null }, fields: 2 });
  });

  it('transform refuses a prototype-polluting target key', async () => {
    // Built with JSON.parse, not an object literal: `{ __proto__: x }` in source code
    // sets the prototype rather than creating an own property, so a literal would not
    // reproduce what actually arrives over HTTP.
    const mapping = JSON.parse('{"__proto__":"orderId"}') as Record<string, unknown>;
    expect(Object.hasOwn(mapping, '__proto__')).toBe(true);

    // Defence in depth: the API already validated the definition, but a handler must not
    // depend on a check it cannot see.
    await expect(
      r.get('transform').handler({ source: { orderId: 'o1' }, mapping }, context()),
    ).rejects.toThrow(/illegal target key/);
  });

  it('http.echo treats 5xx as retryable and 4xx as not', async () => {
    const echo = r.get('http.echo').handler;
    await expect(echo({ status: 503, latencyMs: 0 }, context())).rejects.not.toBeInstanceOf(
      NonRetryableError,
    );
    await expect(echo({ status: 404, latencyMs: 0 }, context())).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(await echo({ status: 200, latencyMs: 0, body: { ok: 1 } }, context())).toMatchObject({
      status: 200,
    });
  });

  it('delay reports progress and honours the abort signal', async () => {
    const progress = vi.fn();
    const controller = new AbortController();

    const promise = r
      .get('delay')
      .handler({ durationMs: 5_000 }, context({ signal: controller.signal, progress }));

    controller.abort(new Error('cancelled'));
    await expect(promise).rejects.toThrow(/aborted/);
  });

  it('delay completes and reports progress for a short wait', async () => {
    const progress = vi.fn();
    const result = await r.get('delay').handler({ durationMs: 20 }, context({ progress }));
    expect(result).toEqual({ waitedMs: 20 });
    expect(progress).toHaveBeenCalled();
  });
});

describe('simulation handlers', () => {
  const r = registry(true).registerAll(SIMULATION_HANDLERS);

  it('simulate.flaky fails until the configured attempt, then succeeds', async () => {
    const flaky = r.get('simulate.flaky').handler;

    await expect(
      flaky({ succeedOnAttempt: 3, durationMs: 0 }, context({ attempt: 1 })),
    ).rejects.toThrow(/transient failure on attempt 1/);

    const result = await flaky({ succeedOnAttempt: 3, durationMs: 0 }, context({ attempt: 3 }));
    expect(result).toMatchObject({ recoveredOnAttempt: 3 });
  });

  it('simulate.fail can be configured as non-retryable', async () => {
    const fail = r.get('simulate.fail').handler;
    await expect(fail({ nonRetryable: true }, context())).rejects.toBeInstanceOf(NonRetryableError);
    await expect(fail({}, context())).rejects.not.toBeInstanceOf(NonRetryableError);
  });

  it('simulate.crash completes normally on a recovered attempt', async () => {
    // Bounded on purpose: a handler that crashes on *every* attempt takes down each
    // worker in turn, which destroys the fleet instead of demonstrating recovery.
    const result = await r
      .get('simulate.crash')
      .handler({ crashUntilAttempt: 1, afterMs: 0 }, context({ attempt: 2 }));

    expect(result).toMatchObject({ recovered: true, completedOnAttempt: 2 });
  });
});
