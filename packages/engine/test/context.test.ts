import { describe, expect, it } from 'vitest';
import { TaskRunState } from '@forge/contracts';
import {
  ContextResolutionError,
  buildContext,
  buildTaskInput,
  redactSecrets,
  resolveInputMapping,
  resolveReference,
  truncateForDisplay,
} from '../src';

const context = buildContext({
  input: { orderId: 'ord_1', amount: 4999, items: [{ sku: 'A1' }, { sku: 'B2' }] },
  run: {
    id: 'run_1',
    workflowKey: 'orders',
    version: 3,
    startedAt: '2026-01-01T00:00:00.000Z',
    metadata: { source: 'api' },
  },
  tasks: {
    validate: {
      state: TaskRunState.SUCCEEDED,
      output: { ok: true, total: 4999 },
      attempts: 1,
      error: null,
    },
  },
  node: { key: 'charge', attempt: 2 },
});

describe('resolveReference', () => {
  it('resolves run input', () => {
    expect(resolveReference(context, '$.input.orderId')).toBe('ord_1');
  });

  it('resolves upstream task output', () => {
    expect(resolveReference(context, '$.tasks.validate.output.total')).toBe(4999);
  });

  it('resolves run and node metadata', () => {
    expect(resolveReference(context, '$.run.workflowKey')).toBe('orders');
    expect(resolveReference(context, '$.node.attempt')).toBe(2);
  });

  it('resolves array elements', () => {
    expect(resolveReference(context, '$.input.items[1].sku')).toBe('B2');
  });

  it('throws for an unresolved path rather than substituting null', () => {
    expect(() => resolveReference(context, '$.input.missing')).toThrow(ContextResolutionError);
  });

  it('rejects a non-path expression', () => {
    expect(() => resolveReference(context, '1 == 1')).toThrow(/is not a context path/);
  });
});

describe('resolveInputMapping', () => {
  it('resolves references and constants together', () => {
    const result = resolveInputMapping(
      {
        amount: { from: '$.input.amount' },
        currency: { value: 'GBP' },
        total: { from: '$.tasks.validate.output.total' },
      },
      context,
    );
    expect(result).toEqual({ amount: 4999, currency: 'GBP', total: 4999 });
  });

  it('throws on an unresolved reference by default', () => {
    expect(() => resolveInputMapping({ x: { from: '$.input.nope' } }, context)).toThrow(
      ContextResolutionError,
    );
  });

  it('yields undefined in lenient mode', () => {
    const result = resolveInputMapping({ x: { from: '$.input.nope' } }, context, {
      lenient: true,
    });
    expect(result).toEqual({ x: undefined });
  });

  it('returns a plain object that survives JSON round-tripping', () => {
    const result = resolveInputMapping({ a: { value: 1 } }, context);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(result))).toEqual({ a: 1 });
  });
});

describe('buildTaskInput', () => {
  it('overlays mapped values on static config', () => {
    const input = buildTaskInput(
      { retries: 3, mode: 'default' },
      { mode: { value: 'strict' }, amount: { from: '$.input.amount' } },
      context,
    );
    expect(input).toEqual({ retries: 3, mode: 'strict', amount: 4999 });
  });
});

describe('buildContext', () => {
  it('produces prototype-free containers', () => {
    expect(Object.getPrototypeOf(context)).toBeNull();
    expect(Object.getPrototypeOf(context.input)).toBeNull();
    expect(Object.getPrototypeOf(context.tasks)).toBeNull();
  });

  it('cannot be reached through the prototype chain', () => {
    const polluted = buildContext({
      input: JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>,
      run: context.run,
      tasks: {},
      node: { key: 'x', attempt: 1 },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => resolveReference(polluted, '$.input.polluted')).toThrow(ContextResolutionError);
  });
});

describe('redactSecrets', () => {
  it('masks secret-looking keys at any depth', () => {
    const redacted = redactSecrets({
      user: 'alice',
      password: 'hunter2',
      nested: { apiKey: 'sk_live_x', safe: 1 },
      list: [{ token: 'abc' }],
    });
    expect(redacted).toEqual({
      user: 'alice',
      password: '[redacted]',
      nested: { apiKey: '[redacted]', safe: 1 },
      list: [{ token: '[redacted]' }],
    });
  });

  it('leaves ordinary payloads untouched', () => {
    expect(redactSecrets({ amount: 1, items: [1, 2] })).toEqual({ amount: 1, items: [1, 2] });
  });

  it('handles primitives and null', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(5)).toBe(5);
  });
});

describe('truncateForDisplay', () => {
  it('passes small values through unchanged', () => {
    expect(truncateForDisplay({ a: 1 })).toEqual({ a: 1 });
  });

  it('truncates values over the limit', () => {
    const big = { data: 'x'.repeat(20_000) };
    const result = truncateForDisplay(big, 1_000) as Record<string, unknown>;
    expect(result._forge).toBe('truncated');
    expect(String(result.preview).length).toBe(1_000);
  });

  it('handles circular structures without throwing', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(truncateForDisplay(circular)).toEqual({ _forge: 'unserialisable' });
  });
});
