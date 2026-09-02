import { NonRetryableError, type HandlerDefinition, type TaskContext } from './registry';

/**
 * Built-in task handlers.
 *
 * These are deliberately boring and self-contained: they compute, wait, or transform
 * data that is already in the execution context. None of them shell out, load code, or
 * reach an unvetted network endpoint, because a workflow definition arrives over an HTTP
 * API and the demo environment must not become a remote execution service.
 *
 * A real deployment adds its own handlers in its own worker image — that is the intended
 * extension point, and it is a code change reviewed like any other, not a payload.
 */

/** Cancellable sleep: resolves early if the task is cancelled or times out. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function requireNumber(input: Record<string, unknown>, key: string, fallback?: number): number {
  const value = input[key];
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new NonRetryableError('required numeric input "' + key + '" is missing', 'INVALID_INPUT');
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new NonRetryableError('input "' + key + '" is not a number', 'INVALID_INPUT');
  }
  return num;
}

const noop: HandlerDefinition = {
  type: 'noop',
  description: 'Succeeds immediately, echoing its input. Useful as a graph join point.',
  handler: async (input) => ({ ok: true, echoed: input }),
};

const delay: HandlerDefinition = {
  type: 'delay',
  description: 'Waits for `durationMs`, reporting progress. Models a slow downstream call.',
  handler: async (input, ctx: TaskContext) => {
    const durationMs = Math.min(requireNumber(input, 'durationMs', 250), 600_000);
    const steps = Math.max(1, Math.min(10, Math.floor(durationMs / 200)));
    const stepMs = durationMs / steps;
    for (let i = 1; i <= steps; i++) {
      await sleep(stepMs, ctx.signal);
      ctx.progress(Math.round((i / steps) * 100));
    }
    return { waitedMs: durationMs };
  },
};

const compute: HandlerDefinition = {
  type: 'compute',
  description: 'Applies a named arithmetic operation to `values`. Deterministic and pure.',
  handler: async (input) => {
    const values = Array.isArray(input.values) ? (input.values as unknown[]).map(Number) : [];
    if (values.some((v) => !Number.isFinite(v))) {
      throw new NonRetryableError('all `values` must be numbers', 'INVALID_INPUT');
    }
    const operation = String(input.operation ?? 'sum');
    switch (operation) {
      case 'sum':
        return { result: values.reduce((a, b) => a + b, 0), count: values.length };
      case 'product':
        return { result: values.reduce((a, b) => a * b, 1), count: values.length };
      case 'max':
        return { result: values.length ? Math.max(...values) : null, count: values.length };
      case 'min':
        return { result: values.length ? Math.min(...values) : null, count: values.length };
      case 'mean':
        return {
          result: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
          count: values.length,
        };
      default:
        // Unknown operation is a definition bug: retrying will not make it known.
        throw new NonRetryableError(
          'unknown operation "' + operation + '" (sum, product, max, min, mean)',
          'INVALID_INPUT',
        );
    }
  },
};

const validate: HandlerDefinition = {
  type: 'validate',
  description: 'Checks that every field named in `required` is present and non-null on `payload`.',
  handler: async (input) => {
    const required = Array.isArray(input.required) ? (input.required as unknown[]).map(String) : [];
    const payload = (input.payload ?? {}) as Record<string, unknown>;
    const missing = required.filter(
      (field) => !Object.hasOwn(payload, field) || payload[field] === null,
    );
    if (missing.length > 0) {
      throw new NonRetryableError(
        'missing required field(s): ' + missing.join(', '),
        'VALIDATION_FAILED',
      );
    }
    return { valid: true, checked: required.length };
  },
};

const transform: HandlerDefinition = {
  type: 'transform',
  description: 'Projects `source` onto a new object using a `mapping` of target -> source key.',
  handler: async (input) => {
    const source = (input.source ?? {}) as Record<string, unknown>;
    const mapping = (input.mapping ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [target, sourceKey] of Object.entries(mapping)) {
      // Reject prototype-polluting targets even though the API already validated the
      // definition — a handler must not depend on an upstream check it cannot see.
      if (target === '__proto__' || target === 'constructor' || target === 'prototype') {
        throw new NonRetryableError('illegal target key "' + target + '"', 'INVALID_INPUT');
      }
      const key = String(sourceKey);
      out[target] = Object.hasOwn(source, key) ? source[key] : null;
    }
    return { result: out, fields: Object.keys(out).length };
  },
};

const httpEcho: HandlerDefinition = {
  type: 'http.echo',
  description:
    'Returns a synthetic HTTP-shaped response from its input. Models an API call without making one.',
  handler: async (input, ctx) => {
    const latencyMs = Math.min(requireNumber(input, 'latencyMs', 50), 30_000);
    await sleep(latencyMs, ctx.signal);
    const status = requireNumber(input, 'status', 200);
    if (status >= 500) {
      // 5xx is transient by convention, so the retry policy applies normally.
      throw new Error('upstream returned ' + status);
    }
    if (status >= 400) {
      throw new NonRetryableError('upstream returned ' + status, 'HTTP_' + status);
    }
    return { status, latencyMs, body: input.body ?? null };
  },
};

export const BUILTIN_HANDLERS: HandlerDefinition[] = [
  noop,
  delay,
  compute,
  validate,
  transform,
  httpEcho,
];
