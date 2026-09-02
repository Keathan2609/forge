import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  CreateWorkflowRequestSchema,
  TriggerRunRequestSchema,
  WorkflowDefinitionSchema,
  type CreateWorkflowRequest,
  type TriggerRunRequest,
  type WorkflowDefinition,
} from '@forge/contracts';
import { UuidPipe, WorkflowKeyPipe, ZodValidationPipe } from '../../src/common/validation';

/**
 * API input validation.
 *
 * These are the tests for the trust boundary: everything below asserts that malformed or
 * hostile input is rejected *before* it can reach the engine or the database.
 */

const validDefinition = {
  key: 'test-workflow',
  name: 'Test',
  nodes: [{ key: 'a', type: 'noop' }],
  edges: [],
};

describe('ZodValidationPipe', () => {
  it('accepts and defaults a minimal definition', () => {
    const pipe = new ZodValidationPipe<WorkflowDefinition>(WorkflowDefinitionSchema);
    const result = pipe.transform(validDefinition);
    expect(result.key).toBe('test-workflow');
    // Defaults are applied, so the engine never sees a partially-specified node.
    expect(result.timeoutMs).toBe(3_600_000);
    expect(result.nodes[0]?.retryPolicy.maxAttempts).toBe(3);
    expect(result.nodes[0]?.queue).toBe('default');
  });

  it('rejects an unknown top-level key rather than silently dropping it', () => {
    const pipe = new ZodValidationPipe<WorkflowDefinition>(WorkflowDefinitionSchema);
    // Silently stripping a misspelled field is how someone spends an afternoon
    // wondering why their retry policy had no effect.
    expect(() => pipe.transform({ ...validDefinition, retryPolicy: {} })).toThrow(
      BadRequestException,
    );
  });

  it('reports every problem at once, with paths', () => {
    const pipe = new ZodValidationPipe<WorkflowDefinition>(WorkflowDefinitionSchema);
    try {
      pipe.transform({ key: 'BAD KEY', name: '', nodes: [] });
      expect.unreachable('should have thrown');
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as {
        details: Array<{ path: string; message: string }>;
      };
      expect(body.details.length).toBeGreaterThan(1);
      expect(body.details.some((d) => d.path === 'key')).toBe(true);
    }
  });

  it('rejects a node key that is not a safe slug', () => {
    const pipe = new ZodValidationPipe<WorkflowDefinition>(WorkflowDefinitionSchema);
    for (const key of ['../etc', 'Has Spaces', 'UPPER', 'trailing-', '']) {
      expect(() => pipe.transform({ ...validDefinition, nodes: [{ key, type: 'noop' }] })).toThrow(
        BadRequestException,
      );
    }
  });

  it('rejects a prototype-polluting config payload', () => {
    const pipe = new ZodValidationPipe<WorkflowDefinition>(WorkflowDefinitionSchema);
    // Parsed from JSON so `__proto__` is a real own property rather than a setter.
    const hostile = JSON.parse(
      JSON.stringify({
        ...validDefinition,
        nodes: [{ key: 'a', type: 'noop', config: {} }],
      }).replace('"config":{}', '"config":{"__proto__":{"polluted":true}}'),
    );
    expect(() => pipe.transform(hostile)).toThrow(BadRequestException);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects an oversized payload', () => {
    const pipe = new ZodValidationPipe<WorkflowDefinition>(WorkflowDefinitionSchema);
    const huge = { ...validDefinition, metadata: { blob: 'x'.repeat(300_000) } };
    expect(() => pipe.transform(huge)).toThrow(BadRequestException);
  });

  it('bounds the number of nodes', () => {
    const pipe = new ZodValidationPipe<WorkflowDefinition>(WorkflowDefinitionSchema);
    const nodes = Array.from({ length: 300 }, (_, i) => ({ key: 'n' + i, type: 'noop' }));
    expect(() => pipe.transform({ ...validDefinition, nodes })).toThrow(BadRequestException);
  });

  it('rejects a retry policy whose max delay is below its initial delay', () => {
    const pipe = new ZodValidationPipe<WorkflowDefinition>(WorkflowDefinitionSchema);
    expect(() =>
      pipe.transform({
        ...validDefinition,
        nodes: [
          {
            key: 'a',
            type: 'noop',
            retryPolicy: { maxAttempts: 3, initialDelayMs: 10_000, maxDelayMs: 1_000 },
          },
        ],
      }),
    ).toThrow(BadRequestException);
  });
});

describe('CreateWorkflowRequestSchema', () => {
  it('requires a definition', () => {
    const pipe = new ZodValidationPipe<CreateWorkflowRequest>(CreateWorkflowRequestSchema);
    expect(() => pipe.transform({ changelog: 'no definition' })).toThrow(BadRequestException);
  });

  it('accepts a definition with an optional changelog', () => {
    const pipe = new ZodValidationPipe<CreateWorkflowRequest>(CreateWorkflowRequestSchema);
    const result = pipe.transform({ definition: validDefinition, changelog: 'first' });
    expect(result.changelog).toBe('first');
  });
});

describe('TriggerRunRequestSchema', () => {
  it('defaults input and metadata to empty objects', () => {
    const pipe = new ZodValidationPipe<TriggerRunRequest>(TriggerRunRequestSchema);
    const result = pipe.transform({});
    expect(result.input).toEqual({});
    expect(result.metadata).toEqual({});
  });

  it('rejects an idempotency key that is too short to be unique', () => {
    const pipe = new ZodValidationPipe<TriggerRunRequest>(TriggerRunRequestSchema);
    expect(() => pipe.transform({ idempotencyKey: 'abc' })).toThrow(BadRequestException);
  });

  it('rejects a non-integer version', () => {
    const pipe = new ZodValidationPipe<TriggerRunRequest>(TriggerRunRequestSchema);
    expect(() => pipe.transform({ version: 1.5 })).toThrow(BadRequestException);
  });
});

describe('UuidPipe', () => {
  it('accepts a v4 uuid', () => {
    const pipe = new UuidPipe();
    expect(pipe.transform('d4ba68eb-6c57-4522-8498-935e14e44a0e')).toBe(
      'd4ba68eb-6c57-4522-8498-935e14e44a0e',
    );
  });

  it('rejects anything else, without echoing an unbounded string back', () => {
    const pipe = new UuidPipe();
    for (const value of ['not-a-uuid', '../../etc/passwd', "1' OR '1'='1", '']) {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    }
    try {
      pipe.transform('x'.repeat(5_000));
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { message: string };
      expect(body.message.length).toBeLessThan(200);
    }
  });
});

describe('WorkflowKeyPipe', () => {
  it('accepts slug keys', () => {
    const pipe = new WorkflowKeyPipe();
    for (const key of ['order-fulfilment', 'a', 'a.b_c-d', 'x1']) {
      expect(pipe.transform(key)).toBe(key);
    }
  });

  it('rejects path traversal and injection attempts', () => {
    const pipe = new WorkflowKeyPipe();
    for (const key of ['../admin', 'a/b', 'UPPER', 'has space', '-leading', 'x'.repeat(100)]) {
      expect(() => pipe.transform(key)).toThrow(BadRequestException);
    }
  });
});
