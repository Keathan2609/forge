import { describe, expect, it } from 'vitest';
import { ExpressionError, evaluateCondition, parseExpression, validateExpression } from '../src';

const ctx = {
  input: { amount: 120, currency: 'GBP', tags: ['priority', 'uk'], nested: { deep: { v: 1 } } },
  tasks: {
    validate: { state: 'SUCCEEDED', output: { ok: true, score: 0.91 }, attempts: 1, error: null },
    charge: {
      state: 'FAILED',
      output: null,
      attempts: 3,
      error: { code: 'CARD_DECLINED', message: 'declined' },
    },
  },
  run: { id: 'r1', workflowKey: 'orders', version: 2, startedAt: null, metadata: {} },
  node: { key: 'ship', attempt: 1 },
};

describe('literals and comparison', () => {
  it.each([
    ['true', true],
    ['false', false],
    ['1 == 1', true],
    ['1 != 2', true],
    ['2 > 1', true],
    ['1 >= 1', true],
    ['1 < 2', true],
    ['2 <= 1', false],
    ["'a' == 'a'", true],
    ['"a" != "b"', true],
    ['null == null', true],
  ])('%s -> %s', (expr, expected) => {
    expect(evaluateCondition(expr, ctx)).toBe(expected);
  });

  it('compares strings lexicographically', () => {
    expect(evaluateCondition("'b' > 'a'", ctx)).toBe(true);
  });

  it('supports decimals', () => {
    expect(evaluateCondition('$.tasks.validate.output.score > 0.9', ctx)).toBe(true);
    expect(evaluateCondition('$.tasks.validate.output.score > 0.95', ctx)).toBe(false);
  });
});

describe('path resolution', () => {
  it('reads run input', () => {
    expect(evaluateCondition('$.input.amount > 100', ctx)).toBe(true);
    expect(evaluateCondition("$.input.currency == 'GBP'", ctx)).toBe(true);
  });

  it('reads upstream task output', () => {
    expect(evaluateCondition('$.tasks.validate.output.ok == true', ctx)).toBe(true);
    expect(evaluateCondition("$.tasks.charge.error.code == 'CARD_DECLINED'", ctx)).toBe(true);
  });

  it('reads array indices', () => {
    expect(evaluateCondition("$.input.tags[0] == 'priority'", ctx)).toBe(true);
  });

  it('reads bracketed string keys', () => {
    expect(evaluateCondition('$.input["amount"] == 120', ctx)).toBe(true);
  });

  it('treats a missing path as falsy rather than throwing', () => {
    expect(evaluateCondition('$.input.doesNotExist', ctx)).toBe(false);
    expect(evaluateCondition('$.a.b.c.d.e', ctx)).toBe(false);
  });

  it('distinguishes missing from null in equality', () => {
    // A missing path is not equal to an explicit null — otherwise a typo silently
    // matches every `== null` guard in the definition.
    expect(evaluateCondition('$.input.doesNotExist == null', ctx)).toBe(false);
  });

  it('does not index into a non-array', () => {
    expect(evaluateCondition('$.input.currency[0]', ctx)).toBe(false);
  });
});

describe('boolean operators', () => {
  it('supports && and || with correct precedence', () => {
    expect(evaluateCondition('true || false && false', ctx)).toBe(true);
    expect(evaluateCondition('(true || false) && false', ctx)).toBe(false);
  });

  it('supports negation', () => {
    expect(evaluateCondition('!false', ctx)).toBe(true);
    expect(evaluateCondition('!$.input.doesNotExist', ctx)).toBe(true);
  });

  it('short-circuits && so a missing right operand cannot error', () => {
    expect(evaluateCondition('false && $.input.amount > 1', ctx)).toBe(false);
  });

  it('combines paths and literals', () => {
    expect(evaluateCondition("$.input.amount > 100 && $.input.currency == 'GBP'", ctx)).toBe(true);
  });
});

describe('builtins', () => {
  it('exists() distinguishes present from absent', () => {
    expect(evaluateCondition('exists($.input.amount)', ctx)).toBe(true);
    expect(evaluateCondition('exists($.input.nope)', ctx)).toBe(false);
  });

  it('len() handles strings, arrays and objects', () => {
    expect(evaluateCondition('len($.input.tags) == 2', ctx)).toBe(true);
    expect(evaluateCondition('len($.input.currency) == 3', ctx)).toBe(true);
    expect(evaluateCondition('len($.input.nested) == 1', ctx)).toBe(true);
  });

  it('contains() works on arrays and strings', () => {
    expect(evaluateCondition("contains($.input.tags, 'uk')", ctx)).toBe(true);
    expect(evaluateCondition("contains($.input.tags, 'us')", ctx)).toBe(false);
    expect(evaluateCondition("contains($.input.currency, 'GB')", ctx)).toBe(true);
  });

  it('lower()/upper() normalise case', () => {
    expect(evaluateCondition("lower($.input.currency) == 'gbp'", ctx)).toBe(true);
    expect(evaluateCondition("upper('gbp') == 'GBP'", ctx)).toBe(true);
  });

  it('rejects the wrong number of arguments', () => {
    expect(() => parseExpression('len()')).toThrow(ExpressionError);
    expect(() => parseExpression("contains('a')")).toThrow(ExpressionError);
  });
});

describe('security properties', () => {
  it('refuses prototype-reaching path segments', () => {
    expect(() => parseExpression('$.__proto__.polluted')).toThrow(ExpressionError);
    expect(() => parseExpression('$.constructor.name')).toThrow(ExpressionError);
    expect(() => parseExpression('$.a.prototype')).toThrow(ExpressionError);
  });

  it('never walks the prototype chain even for inherited keys', () => {
    const polluted = Object.create({ inherited: 'gotcha' }) as Record<string, unknown>;
    polluted.own = 1;
    expect(evaluateCondition("$.inherited == 'gotcha'", polluted)).toBe(false);
    expect(evaluateCondition('$.own == 1', polluted)).toBe(true);
  });

  it('rejects arbitrary identifiers, so there is no callable surface', () => {
    expect(() => parseExpression('process.exit(1)')).toThrow(ExpressionError);
    expect(() => parseExpression('require("fs")')).toThrow(ExpressionError);
    expect(() => parseExpression('globalThis')).toThrow(ExpressionError);
    expect(() => parseExpression('constructor')).toThrow(ExpressionError);
  });

  it('rejects assignment', () => {
    expect(() => parseExpression('$.input.amount = 5')).toThrow(/use "==" for equality/);
  });

  it('bounds expression length', () => {
    expect(() => parseExpression('true || '.repeat(200) + 'true')).toThrow(
      /exceeds 512 characters/,
    );
  });

  it('bounds AST size for expressions inside the length limit', () => {
    const expr = '!'.repeat(400) + 'true';
    expect(() => parseExpression(expr)).toThrow(ExpressionError);
  });
});

describe('parse errors', () => {
  it('reports unterminated strings', () => {
    expect(() => parseExpression("$.a == 'unterminated")).toThrow(/unterminated string/);
  });

  it('reports unbalanced parentheses', () => {
    expect(() => parseExpression('(true')).toThrow(ExpressionError);
  });

  it('reports unexpected characters', () => {
    expect(() => parseExpression('$.a @ 1')).toThrow(/unexpected character/);
  });

  it('reports malformed numbers', () => {
    expect(() => parseExpression('1.2.3 == 1')).toThrow(/malformed number/);
  });

  it('carries the position of the failure', () => {
    try {
      parseExpression('$.a @ 1');
    } catch (err) {
      expect((err as ExpressionError).position).toBe(4); // index of '@'
      expect((err as ExpressionError).code).toBe('EXPRESSION_INVALID');
    }
  });

  it('refuses to compare incompatible types', () => {
    expect(() => evaluateCondition("$.input.amount > 'text'", ctx)).toThrow(/cannot apply/);
  });
});

describe('validateExpression', () => {
  it('returns ok for a valid expression', () => {
    expect(validateExpression('$.input.a == 1')).toEqual({ ok: true });
  });

  it('returns the message for an invalid one without throwing', () => {
    const result = validateExpression('$.input.a ==');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/unexpected end/);
  });
});
