import { describe, expect, it } from 'vitest';
import {
  IdentifierSchema,
  MAX_JSON_BYTES,
  MAX_NODES,
  RetryPolicySchema,
  SafeJsonObjectSchema,
  TERMINAL_TASK_STATES,
  TERMINAL_WORKFLOW_STATES,
  TaskRunState,
  WorkflowDefinitionSchema,
  WorkflowRunState,
  isDependencyPermanentlyUnsatisfiable,
  isDependencySatisfied,
  isTerminalTaskState,
} from '../src';

/**
 * The workflow schema is the trust boundary.
 *
 * Everything reaching `WorkflowDefinitionSchema.parse` came from an HTTP request. These
 * tests are the specification for what is allowed through — so they lean heavily on the
 * hostile cases, which are the ones that matter.
 */

const minimal = {
  key: 'my-workflow',
  name: 'My Workflow',
  nodes: [{ key: 'a', type: 'noop' }],
  edges: [],
};

describe('IdentifierSchema', () => {
  it.each(['a', 'a1', 'order-fulfilment', 'a.b_c-d', 'x9'])('accepts %s', (value) => {
    expect(IdentifierSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['UPPERCASE', 'uppercase is rejected so keys are canonical in URLs and logs'],
    ['has space', 'spaces would break queue key interpolation'],
    ['-leading', 'must start alphanumeric'],
    ['trailing-', 'must end alphanumeric'],
    ['../traversal', 'path traversal'],
    ['a/b', 'path separator'],
    ['', 'empty'],
    ['x'.repeat(65), 'over the length limit'],
  ])('rejects %s (%s)', (value) => {
    expect(IdentifierSchema.safeParse(value).success).toBe(false);
  });
});

describe('SafeJsonObjectSchema', () => {
  it('accepts an ordinary JSON object and applies its default', () => {
    expect(SafeJsonObjectSchema.parse({ a: 1, b: [1, 2], c: { d: null } })).toEqual({
      a: 1,
      b: [1, 2],
      c: { d: null },
    });
    expect(SafeJsonObjectSchema.parse(undefined)).toEqual({});
  });

  it('rejects a prototype-polluting key rather than silently dropping it', () => {
    // Parsed from JSON so `__proto__` is a real own property, exactly as it would arrive
    // over HTTP. Zod's own record parser strips this key silently; validating the raw
    // input instead turns it into a reported error.
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    const result = SafeJsonObjectSchema.safeParse(hostile);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('__proto__');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(['constructor', 'prototype'])('rejects a nested "%s" key', (key) => {
    const hostile = JSON.parse('{"safe":{"' + key + '":{"x":1}}}') as unknown;
    expect(SafeJsonObjectSchema.safeParse(hostile).success).toBe(false);
  });

  it('rejects an array or a primitive', () => {
    expect(SafeJsonObjectSchema.safeParse([1, 2]).success).toBe(false);
    expect(SafeJsonObjectSchema.safeParse('string').success).toBe(false);
    expect(SafeJsonObjectSchema.safeParse(42).success).toBe(false);
  });

  it('rejects a payload over the size limit', () => {
    const oversized = { blob: 'x'.repeat(MAX_JSON_BYTES + 1_000) };
    expect(SafeJsonObjectSchema.safeParse(oversized).success).toBe(false);
  });

  it('rejects pathological nesting', () => {
    // A deeply nested document is cheap to send and expensive to walk.
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(SafeJsonObjectSchema.safeParse(deep).success).toBe(false);
  });
});

describe('RetryPolicySchema', () => {
  it('fills in every default', () => {
    const policy = RetryPolicySchema.parse({});
    expect(policy).toEqual({
      maxAttempts: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 60_000,
      multiplier: 2,
      jitter: true,
      nonRetryableErrors: [],
    });
  });

  it('rejects a max delay below the initial delay', () => {
    // Otherwise the backoff curve is silently clamped to something the author did not
    // write, and the retry schedule shown in the console would be a lie.
    const result = RetryPolicySchema.safeParse({ initialDelayMs: 10_000, maxDelayMs: 1_000 });
    expect(result.success).toBe(false);
  });

  it('bounds the attempt count', () => {
    expect(RetryPolicySchema.safeParse({ maxAttempts: 0 }).success).toBe(false);
    expect(RetryPolicySchema.safeParse({ maxAttempts: 100 }).success).toBe(false);
    expect(RetryPolicySchema.safeParse({ maxAttempts: 1 }).success).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(RetryPolicySchema.safeParse({ maxRetries: 3 }).success).toBe(false);
  });
});

describe('WorkflowDefinitionSchema', () => {
  it('parses a minimal definition and applies defaults', () => {
    const definition = WorkflowDefinitionSchema.parse(minimal);
    expect(definition.timeoutMs).toBe(3_600_000);
    expect(definition.edges).toEqual([]);
    expect(definition.nodes[0]?.queue).toBe('default');
    expect(definition.nodes[0]?.timeoutMs).toBe(60_000);
    expect(definition.nodes[0]?.retryPolicy.maxAttempts).toBe(3);
  });

  it('rejects unknown top-level keys instead of stripping them', () => {
    // Silently dropping a misspelled field is how someone spends an afternoon wondering
    // why their setting had no effect.
    expect(WorkflowDefinitionSchema.safeParse({ ...minimal, retryPolicy: {} }).success).toBe(false);
  });

  it('requires at least one node', () => {
    expect(WorkflowDefinitionSchema.safeParse({ ...minimal, nodes: [] }).success).toBe(false);
  });

  it('bounds the node count', () => {
    const nodes = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({
      key: 'n' + i,
      type: 'noop',
    }));
    expect(WorkflowDefinitionSchema.safeParse({ ...minimal, nodes }).success).toBe(false);
  });

  it('rejects a self-referencing edge', () => {
    const result = WorkflowDefinitionSchema.safeParse({
      ...minimal,
      edges: [{ from: 'a', to: 'a' }],
    });
    expect(result.success).toBe(false);
  });

  it('bounds a condition expression', () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...minimal,
        nodes: [{ key: 'a', type: 'noop', condition: 'x'.repeat(600) }],
      }).success,
    ).toBe(false);
  });

  it('accepts both mapping forms for a node input', () => {
    const definition = WorkflowDefinitionSchema.parse({
      ...minimal,
      nodes: [
        {
          key: 'a',
          type: 'noop',
          input: { fromRef: { from: '$.input.x' }, literal: { value: 42 } },
        },
      ],
    });
    expect(definition.nodes[0]?.input.fromRef).toEqual({ from: '$.input.x' });
    expect(definition.nodes[0]?.input.literal).toEqual({ value: 42 });
  });

  it('rejects an input mapping with neither form', () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...minimal,
        nodes: [{ key: 'a', type: 'noop', input: { bad: { source: '$.input.x' } } }],
      }).success,
    ).toBe(false);
  });

  it('keeps the editor position hint optional', () => {
    const withPosition = WorkflowDefinitionSchema.parse({
      ...minimal,
      nodes: [{ key: 'a', type: 'noop', position: { x: 10, y: 20 } }],
    });
    expect(withPosition.nodes[0]?.position).toEqual({ x: 10, y: 20 });
    expect(WorkflowDefinitionSchema.parse(minimal).nodes[0]?.position).toBeUndefined();
  });
});

describe('state vocabulary', () => {
  it('marks exactly the intended workflow states terminal', () => {
    expect([...TERMINAL_WORKFLOW_STATES].sort()).toEqual(
      ['CANCELLED', 'FAILED', 'SUCCEEDED', 'TIMED_OUT'].sort(),
    );
  });

  it('marks exactly the intended task states terminal', () => {
    expect([...TERMINAL_TASK_STATES].sort()).toEqual(
      ['CANCELLED', 'DEAD_LETTERED', 'FAILED', 'SKIPPED', 'SUCCEEDED', 'TIMED_OUT'].sort(),
    );
  });

  it('treats SKIPPED as satisfying a dependency', () => {
    // A pruned branch must not block its dependents forever — that is the difference
    // between a conditional branch and a deadlock.
    expect(isDependencySatisfied(TaskRunState.SKIPPED)).toBe(true);
    expect(isDependencySatisfied(TaskRunState.SUCCEEDED)).toBe(true);
    expect(isDependencySatisfied(TaskRunState.RUNNING)).toBe(false);
  });

  it('identifies dependencies that can never be satisfied', () => {
    for (const state of [
      TaskRunState.FAILED,
      TaskRunState.CANCELLED,
      TaskRunState.TIMED_OUT,
      TaskRunState.DEAD_LETTERED,
    ]) {
      expect(isDependencyPermanentlyUnsatisfiable(state)).toBe(true);
    }
    expect(isDependencyPermanentlyUnsatisfiable(TaskRunState.RETRYING)).toBe(false);
    expect(isDependencyPermanentlyUnsatisfiable(TaskRunState.SKIPPED)).toBe(false);
  });

  it('agrees between the terminal list and the predicate', () => {
    for (const state of Object.values(TaskRunState)) {
      expect(isTerminalTaskState(state)).toBe(TERMINAL_TASK_STATES.includes(state));
    }
  });

  it('has no overlap between terminal and active workflow states', () => {
    const active = [WorkflowRunState.PENDING, WorkflowRunState.QUEUED, WorkflowRunState.RUNNING];
    for (const state of active) {
      expect(TERMINAL_WORKFLOW_STATES).not.toContain(state);
    }
  });
});
