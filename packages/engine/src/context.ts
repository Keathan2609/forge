import type { InputMapping, TaskRunState } from '@forge/contracts';
import { ContextResolutionError } from './errors';
import { MISSING, parseExpression, resolvePath } from './expression';

/**
 * The execution context is the only data a node can read.
 *
 * It is assembled fresh for each dispatch from persisted rows, never carried in memory
 * between tasks. That is what makes a task re-runnable on a different worker after a
 * crash: the context is a pure function of the database.
 *
 *   $.input          the run's trigger payload
 *   $.run.id         run identifiers and metadata
 *   $.tasks.<key>    { state, output, attempts } for every completed upstream task
 *   $.node.attempt   the attempt number about to execute
 */
export interface ExecutionContext {
  input: Record<string, unknown>;
  run: {
    id: string;
    workflowKey: string;
    version: number;
    startedAt: string | null;
    metadata: Record<string, unknown>;
  };
  tasks: Record<
    string,
    {
      state: TaskRunState;
      output: unknown;
      attempts: number;
      error: { code: string | null; message: string } | null;
    }
  >;
  node: {
    key: string;
    attempt: number;
  };
}

/** `Object.create(null)` everywhere so a resolved object never carries a prototype. */
function nullObject<T extends object>(source: T): T {
  return Object.assign(Object.create(null) as T, source);
}

export function buildContext(parts: {
  input: Record<string, unknown>;
  run: ExecutionContext['run'];
  tasks: ExecutionContext['tasks'];
  node: ExecutionContext['node'];
}): ExecutionContext {
  return nullObject({
    input: nullObject(parts.input),
    run: parts.run,
    tasks: nullObject(parts.tasks),
    node: parts.node,
  });
}

/**
 * Resolve a single `$.` reference. Distinguishes "resolved to null" from "path absent",
 * because silently substituting `null` for a typo in a mapping is exactly the kind of
 * bug that only shows up in production.
 */
export function resolveReference(context: ExecutionContext, reference: string): unknown {
  const ast = parseExpression(reference);
  if (ast.kind !== 'path') {
    throw new ContextResolutionError(reference, '"' + reference + '" is not a context path');
  }
  const value = resolvePath(context, ast.segments);
  if (value === MISSING) throw new ContextResolutionError(reference);
  return value;
}

export interface ResolveOptions {
  /** When true, unresolved references become `undefined` instead of throwing. */
  lenient?: boolean;
}

/** Materialise a node's input document from its mapping and the execution context. */
export function resolveInputMapping(
  mapping: InputMapping,
  context: ExecutionContext,
  options: ResolveOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [field, spec] of Object.entries(mapping)) {
    // `from` is the discriminant: `{ value }` is a constant, `{ from }` is a reference.
    if (!('from' in spec)) {
      out[field] = (spec as { value?: unknown }).value;
      continue;
    }
    try {
      out[field] = resolveReference(context, spec.from);
    } catch (err) {
      if (options.lenient && err instanceof ContextResolutionError) {
        out[field] = undefined;
        continue;
      }
      throw err;
    }
  }
  // Return a plain object so it round-trips through JSON/Prisma cleanly.
  return { ...out };
}

/**
 * A node's effective input: the resolved mapping merged over its static `config`.
 * Mapped values win, so a definition can override a default without editing config.
 */
export function buildTaskInput(
  config: Record<string, unknown>,
  mapping: InputMapping,
  context: ExecutionContext,
  options: ResolveOptions = {},
): Record<string, unknown> {
  return { ...config, ...resolveInputMapping(mapping, context, options) };
}

/** Truncate large values before they are written to an event or a log line. */
export function truncateForDisplay(value: unknown, maxBytes = 8 * 1024): unknown {
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    return { _forge: 'unserialisable' };
  }
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return value;
  return {
    _forge: 'truncated',
    bytes: Buffer.byteLength(json, 'utf8'),
    preview: json.slice(0, maxBytes),
  };
}

/**
 * Redact well-known secret-ish keys before persisting or logging a payload.
 * Applied to task inputs/outputs on their way into `ExecutionEvent`.
 */
const SECRET_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key|session|cookie|bearer)/i;

export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactSecrets(v, depth + 1);
  }
  return out as unknown as T;
}
