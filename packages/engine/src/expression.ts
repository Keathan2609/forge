import { ExpressionError } from './errors';

/**
 * A deliberately tiny, total expression language for node/edge conditions.
 *
 * Why not `eval`, `new Function`, `vm`, or a general expression library?
 * Conditions arrive from the API as untrusted strings and are executed inside the
 * control plane. Anything capable of property traversal on arbitrary objects, or of
 * reaching a constructor, is a remote code execution primitive. This parser can only
 * produce booleans, numbers, strings, null and arrays-of-those; it has no assignment,
 * no member access outside the whitelisted `$` context, no loops and no host callables
 * beyond five pure builtins. Parsing is separated from evaluation so definitions are
 * validated once at save time rather than failing mid-run.
 *
 * Grammar (precedence low to high):
 *   expr       := or
 *   or         := and ( '||' and )*
 *   and        := unary ( '&&' unary )*
 *   unary      := '!' unary | comparison
 *   comparison := primary ( ('=='|'!='|'>='|'<='|'>'|'<') primary )?
 *   primary    := '(' expr ')' | literal | path | call
 */

type TokenType = 'path' | 'number' | 'string' | 'ident' | 'op' | 'punct' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export type Ast =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'path'; segments: PathSegment[]; raw: string }
  | { kind: 'unary'; op: '!'; operand: Ast }
  | { kind: 'binary'; op: BinaryOp; left: Ast; right: Ast }
  | { kind: 'call'; name: BuiltinName; args: Ast[] };

export type PathSegment = { kind: 'key'; key: string } | { kind: 'index'; index: number };

export type BinaryOp = '==' | '!=' | '>' | '>=' | '<' | '<=' | '&&' | '||';

const BUILTINS = ['exists', 'len', 'contains', 'lower', 'upper'] as const;
export type BuiltinName = (typeof BUILTINS)[number];

const BUILTIN_ARITY: Record<BuiltinName, number> = {
  exists: 1,
  len: 1,
  contains: 2,
  lower: 1,
  upper: 1,
};

/** Object keys that would let a crafted context reach the prototype chain. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_EXPRESSION_LENGTH = 512;
const MAX_AST_NODES = 200;

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}

function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/**
 * Characters allowed inside a dot-notation path segment.
 *
 * Wider than an identifier because node keys are slugs and routinely contain hyphens
 * (`prepare-shipment`, `deploy-production`). Admitting `-` here is unambiguous only
 * because the language has no arithmetic: there is no subtraction operator for it to
 * collide with. A key containing a dot needs bracket notation — `$.tasks["http.fetch"]`
 * — since dots are the segment separator.
 */
function isPathSegmentChar(c: string): boolean {
  return /[A-Za-z0-9_-]/.test(c);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const readQuoted = (quote: string, start: number): string => {
    let out = '';
    i++; // consume opening quote
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') {
        const next = source[i + 1];
        if (next === undefined) throw new ExpressionError('unterminated escape', source, i);
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        i += 2;
        continue;
      }
      out += source[i];
      i++;
    }
    if (i >= source.length) throw new ExpressionError('unterminated string literal', source, start);
    i++; // consume closing quote
    return out;
  };

  while (i < source.length) {
    const c = source[i] as string;

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // Context path: `$` followed by .key / ["key"] / [0]
    if (c === '$') {
      const start = i;
      i++;
      let raw = '$';
      for (;;) {
        if (source[i] === '.') {
          i++;
          let key = '';
          while (i < source.length && isPathSegmentChar(source[i] as string)) key += source[i++];
          if (!key) throw new ExpressionError('expected property name after "."', source, i);
          raw += '.' + key;
          continue;
        }
        if (source[i] === '[') {
          const bracketStart = i;
          i++;
          const quote = source[i];
          if (quote === '"' || quote === "'") {
            const key = readQuoted(quote, bracketStart);
            raw += '["' + key + '"]';
          } else {
            let digits = '';
            while (i < source.length && /[0-9]/.test(source[i] as string)) digits += source[i++];
            if (!digits) {
              throw new ExpressionError('expected index or quoted key', source, bracketStart);
            }
            raw += '[' + digits + ']';
          }
          if (source[i] !== ']') throw new ExpressionError('expected "]"', source, i);
          i++;
          continue;
        }
        break;
      }
      tokens.push({ type: 'path', value: raw, pos: start });
      continue;
    }

    if (c === '"' || c === "'") {
      const start = i;
      const value = readQuoted(c, start);
      tokens.push({ type: 'string', value, pos: start });
      continue;
    }

    if (/[0-9]/.test(c)) {
      const start = i;
      let num = '';
      while (i < source.length && /[0-9.]/.test(source[i] as string)) num += source[i++];
      if ((num.match(/\./g) ?? []).length > 1) {
        throw new ExpressionError('malformed number "' + num + '"', source, start);
      }
      tokens.push({ type: 'number', value: num, pos: start });
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      let ident = '';
      while (i < source.length && isIdentPart(source[i] as string)) ident += source[i++];
      tokens.push({ type: 'ident', value: ident, pos: start });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }

    if (c === '>' || c === '<' || c === '!') {
      tokens.push({ type: 'op', value: c, pos: i });
      i++;
      continue;
    }

    if (c === '(' || c === ')' || c === ',') {
      tokens.push({ type: 'punct', value: c, pos: i });
      i++;
      continue;
    }

    // A lone `=` is the classic assignment typo; name it explicitly.
    if (c === '=') {
      throw new ExpressionError('use "==" for equality, "=" is not an operator', source, i);
    }

    throw new ExpressionError('unexpected character "' + c + '"', source, i);
  }

  tokens.push({ type: 'eof', value: '', pos: source.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private index = 0;
  private nodeCount = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  parse(): Ast {
    const ast = this.parseOr();
    const tok = this.peek();
    if (tok.type !== 'eof') {
      throw new ExpressionError('unexpected token "' + tok.value + '"', this.source, tok.pos);
    }
    return ast;
  }

  private track(): void {
    if (++this.nodeCount > MAX_AST_NODES) {
      throw new ExpressionError('expression exceeds ' + MAX_AST_NODES + ' nodes', this.source);
    }
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    return this.tokens[this.index++] as Token;
  }

  private matchOp(...ops: string[]): Token | null {
    const tok = this.peek();
    if (tok.type === 'op' && ops.includes(tok.value)) return this.next();
    return null;
  }

  private parseOr(): Ast {
    let left = this.parseAnd();
    while (this.matchOp('||')) {
      this.track();
      left = { kind: 'binary', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Ast {
    let left = this.parseUnary();
    while (this.matchOp('&&')) {
      this.track();
      left = { kind: 'binary', op: '&&', left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Ast {
    if (this.matchOp('!')) {
      this.track();
      return { kind: 'unary', op: '!', operand: this.parseUnary() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Ast {
    const left = this.parsePrimary();
    const op = this.matchOp('==', '!=', '>=', '<=', '>', '<');
    if (!op) return left;
    this.track();
    return { kind: 'binary', op: op.value as BinaryOp, left, right: this.parsePrimary() };
  }

  private parsePrimary(): Ast {
    this.track();
    const tok = this.next();

    if (tok.type === 'punct' && tok.value === '(') {
      const inner = this.parseOr();
      const close = this.next();
      if (close.type !== 'punct' || close.value !== ')') {
        throw new ExpressionError('expected ")"', this.source, close.pos);
      }
      return inner;
    }

    if (tok.type === 'number') return { kind: 'literal', value: Number(tok.value) };
    if (tok.type === 'string') return { kind: 'literal', value: tok.value };
    if (tok.type === 'path') {
      return {
        kind: 'path',
        segments: parsePathSegments(tok.value, this.source, tok.pos),
        raw: tok.value,
      };
    }

    if (tok.type === 'ident') {
      if (tok.value === 'true') return { kind: 'literal', value: true };
      if (tok.value === 'false') return { kind: 'literal', value: false };
      if (tok.value === 'null') return { kind: 'literal', value: null };

      if (!(BUILTINS as readonly string[]).includes(tok.value)) {
        throw new ExpressionError(
          'unknown identifier "' + tok.value + '" (allowed builtins: ' + BUILTINS.join(', ') + ')',
          this.source,
          tok.pos,
        );
      }
      const name = tok.value as BuiltinName;
      const open = this.next();
      if (open.type !== 'punct' || open.value !== '(') {
        throw new ExpressionError('expected "(" after ' + name, this.source, open.pos);
      }
      const args: Ast[] = [];
      if (!(this.peek().type === 'punct' && this.peek().value === ')')) {
        for (;;) {
          args.push(this.parseOr());
          const sep = this.peek();
          if (sep.type === 'punct' && sep.value === ',') {
            this.next();
            continue;
          }
          break;
        }
      }
      const close = this.next();
      if (close.type !== 'punct' || close.value !== ')') {
        throw new ExpressionError('expected ")" closing ' + name, this.source, close.pos);
      }
      const arity = BUILTIN_ARITY[name];
      if (args.length !== arity) {
        throw new ExpressionError(
          name + '() takes ' + arity + ' argument(s), received ' + args.length,
          this.source,
          tok.pos,
        );
      }
      return { kind: 'call', name, args };
    }

    throw new ExpressionError(
      tok.type === 'eof' ? 'unexpected end of expression' : 'unexpected token "' + tok.value + '"',
      this.source,
      tok.pos,
    );
  }
}

function parsePathSegments(raw: string, source: string, pos: number): PathSegment[] {
  const segments: PathSegment[] = [];
  const body = raw.slice(1); // strip leading `$`
  // Segment: `.key` (slug characters, must start alphanumeric or `_`), `[0]`, or `["any key"]`.
  const re = /\.([A-Za-z0-9_][A-Za-z0-9_-]*)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index !== consumed) {
      throw new ExpressionError('malformed path "' + raw + '"', source, pos);
    }
    consumed = m.index + m[0].length;
    if (m[1] !== undefined) segments.push({ kind: 'key', key: m[1] });
    else if (m[2] !== undefined) segments.push({ kind: 'index', index: Number(m[2]) });
    else if (m[3] !== undefined) segments.push({ kind: 'key', key: m[3].replace(/\\(.)/g, '$1') });
  }
  if (consumed !== body.length) {
    throw new ExpressionError('malformed path "' + raw + '"', source, pos);
  }
  for (const seg of segments) {
    if (seg.kind === 'key' && FORBIDDEN_KEYS.has(seg.key)) {
      throw new ExpressionError('forbidden path segment "' + seg.key + '"', source, pos);
    }
  }
  return segments;
}

/** Parse an expression once. Throws `ExpressionError` with a position on failure. */
export function parseExpression(source: string): Ast {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(
      'expression exceeds ' + MAX_EXPRESSION_LENGTH + ' characters',
      source,
    );
  }
  return new Parser(tokenize(source), source).parse();
}

/** Validate an expression without evaluating it. Used at definition-save time. */
export function validateExpression(source: string): { ok: true } | { ok: false; message: string } {
  try {
    parseExpression(source);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/** Sentinel for "this path does not exist", distinct from a stored `null`. */
export const MISSING: unique symbol = Symbol('forge.missing');

/** Resolve a `$.a.b[0]` path against a context. Returns `MISSING` when absent. */
export function resolvePath(context: unknown, segments: PathSegment[]): unknown {
  let current: unknown = context;
  for (const seg of segments) {
    if (current === null || current === undefined) return MISSING;
    if (seg.kind === 'index') {
      if (!Array.isArray(current)) return MISSING;
      if (seg.index >= current.length) return MISSING;
      current = current[seg.index];
      continue;
    }
    if (typeof current !== 'object' || Array.isArray(current)) return MISSING;
    // `hasOwn` keeps resolution off the prototype chain even for a crafted context.
    if (!Object.hasOwn(current as object, seg.key)) return MISSING;
    current = (current as Record<string, unknown>)[seg.key];
  }
  return current;
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === MISSING || b === MISSING) return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a === 'object' || typeof b === 'object')
    return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function describe(v: unknown): string {
  if (v === MISSING) return 'missing value';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function compare(op: BinaryOp, a: unknown, b: unknown, expr: string): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case '>':
        return a > b;
      case '>=':
        return a >= b;
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      default:
        break;
    }
  }
  if (typeof a === 'string' && typeof b === 'string') {
    switch (op) {
      case '>':
        return a > b;
      case '>=':
        return a >= b;
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      default:
        break;
    }
  }
  throw new ExpressionError(
    'cannot apply "' + op + '" to ' + describe(a) + ' and ' + describe(b),
    expr,
  );
}

/** JS-like truthiness, with `MISSING` treated as false. */
export function truthy(value: unknown): boolean {
  if (value === MISSING || value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function evaluateNode(ast: Ast, context: unknown, expr: string): unknown {
  switch (ast.kind) {
    case 'literal':
      return ast.value;
    case 'path':
      return resolvePath(context, ast.segments);
    case 'unary':
      return !truthy(evaluateNode(ast.operand, context, expr));
    case 'binary': {
      if (ast.op === '&&') {
        return (
          truthy(evaluateNode(ast.left, context, expr)) &&
          truthy(evaluateNode(ast.right, context, expr))
        );
      }
      if (ast.op === '||') {
        return (
          truthy(evaluateNode(ast.left, context, expr)) ||
          truthy(evaluateNode(ast.right, context, expr))
        );
      }
      const left = evaluateNode(ast.left, context, expr);
      const right = evaluateNode(ast.right, context, expr);
      if (ast.op === '==') return looseEquals(left, right);
      if (ast.op === '!=') return !looseEquals(left, right);
      return compare(ast.op, left, right, expr);
    }
    case 'call': {
      const args = ast.args.map((a) => evaluateNode(a, context, expr));
      switch (ast.name) {
        case 'exists':
          return args[0] !== MISSING && args[0] !== null && args[0] !== undefined;
        case 'len': {
          const v = args[0];
          if (typeof v === 'string' || Array.isArray(v)) return v.length;
          if (v !== MISSING && v !== null && typeof v === 'object') {
            return Object.keys(v as object).length;
          }
          return 0;
        }
        case 'contains': {
          const haystack = args[0];
          const needle = args[1];
          if (typeof haystack === 'string') return haystack.includes(String(needle));
          if (Array.isArray(haystack)) return haystack.some((item) => looseEquals(item, needle));
          return false;
        }
        case 'lower':
          return String(args[0] === MISSING ? '' : args[0]).toLowerCase();
        case 'upper':
          return String(args[0] === MISSING ? '' : args[0]).toUpperCase();
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

/**
 * Evaluate a condition to a boolean.
 *
 * Missing paths evaluate to falsy rather than throwing: a condition guarding an
 * optional branch should prune the branch, not fail the run.
 */
export function evaluateCondition(source: string, context: unknown): boolean {
  const ast = parseExpression(source);
  return truthy(evaluateNode(ast, context, source));
}

/** Evaluate a pre-parsed AST. Use when the same condition runs repeatedly. */
export function evaluateAst(ast: Ast, context: unknown): boolean {
  return truthy(evaluateNode(ast, context, '<compiled>'));
}
