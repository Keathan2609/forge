import { describe, expect, it } from 'vitest';
import { makeDefinition, makeNode } from '@forge/testing';
import { ValidationCode, evaluateCondition, parseExpression, validateDefinition } from '../src';

/**
 * Regression: node keys are slugs, and slugs contain hyphens.
 *
 * The path lexer originally accepted only `[A-Za-z0-9_]` after a dot, so
 * `$.tasks.prepare-shipment.output` failed to parse. Nothing caught it at save time
 * because run-level `output` mappings were not validated at all — so the first sign of
 * trouble was a run whose tasks had every one succeeded, sitting in RUNNING forever
 * because finalising it threw.
 *
 * Two defects, one symptom. These tests pin both.
 */

describe('hyphenated path segments', () => {
  const ctx = {
    tasks: {
      'prepare-shipment': { output: { result: { shipmentId: 'shp_1' } } },
      'deploy-production': { output: { url: 'https://example.internal' } },
    },
    input: { 'order-id': 'ord_1' },
  };

  it('parses a hyphenated task key in dot notation', () => {
    expect(() => parseExpression('$.tasks.prepare-shipment.output')).not.toThrow();
  });

  it('resolves through a hyphenated segment', () => {
    expect(
      evaluateCondition("$.tasks.prepare-shipment.output.result.shipmentId == 'shp_1'", ctx),
    ).toBe(true);
  });

  it('handles several hyphens in one key', () => {
    expect(evaluateCondition('exists($.tasks.deploy-production.output.url)', ctx)).toBe(true);
  });

  it('still supports bracket notation for keys containing dots', () => {
    const dotted = { tasks: { 'http.fetch': { output: { status: 200 } } } };
    expect(evaluateCondition('$.tasks["http.fetch"].output.status == 200', dotted)).toBe(true);
  });

  it('does not treat a hyphen as an operator outside a path', () => {
    // There is no arithmetic in this language; a bare hyphen is still a syntax error,
    // which is what makes admitting it inside path segments unambiguous.
    expect(() => parseExpression('1 - 1')).toThrow(/unexpected character/);
  });

  it('still rejects a prototype-reaching segment even with the wider character set', () => {
    expect(() => parseExpression('$.__proto__.x')).toThrow(/forbidden path segment/);
  });
});

describe('run output mapping validation', () => {
  it('accepts an output mapping that references a real task', () => {
    const definition = {
      ...makeDefinition({
        nodes: [makeNode('validate-order'), makeNode('prepare-shipment')],
        edges: ['validate-order->prepare-shipment'],
      }),
      output: { shipmentId: { from: '$.tasks.prepare-shipment.output.result.shipmentId' } },
    };
    expect(validateDefinition(definition).valid).toBe(true);
  });

  it('rejects an output mapping that references a task that does not exist', () => {
    const definition = {
      ...makeDefinition({ nodes: [makeNode('a')] }),
      output: { missing: { from: '$.tasks.ghost.output.value' } },
    };
    const result = validateDefinition(definition);
    expect(result.valid).toBe(false);
    const issue = result.errors.find((e) => e.code === ValidationCode.INVALID_INPUT_REFERENCE);
    expect(issue?.target).toBe('$.output.missing');
    expect(issue?.message).toContain('ghost');
  });

  it('rejects an output mapping that is not a context path', () => {
    const definition = {
      ...makeDefinition({ nodes: [makeNode('a')] }),
      output: { bad: { from: 'tasks.a.output' } },
    };
    expect(validateDefinition(definition).valid).toBe(false);
  });

  it('rejects an output mapping with an unparseable path', () => {
    const definition = {
      ...makeDefinition({ nodes: [makeNode('a')] }),
      output: { bad: { from: '$.tasks.a.output[' } },
    };
    expect(validateDefinition(definition).valid).toBe(false);
  });

  it('allows a constant output value', () => {
    const definition = {
      ...makeDefinition({ nodes: [makeNode('a')] }),
      output: { version: { value: 2 } },
    };
    expect(validateDefinition(definition).valid).toBe(true);
  });

  it('does not require the output mapping to depend on the referenced task', () => {
    // Unlike a node input, the run output is materialised after everything has finished,
    // so reading any node is safe — there is no ordering hazard to guard against.
    const definition = {
      ...makeDefinition({ nodes: [makeNode('a'), makeNode('b')] }),
      output: { fromA: { from: '$.tasks.a.output' }, fromB: { from: '$.tasks.b.output' } },
    };
    expect(validateDefinition(definition).valid).toBe(true);
  });
});
