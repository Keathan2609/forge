import { z } from 'zod';

/**
 * Workflow definition schema.
 *
 * This is the trust boundary between untrusted API input and the engine. Anything
 * that reaches `WorkflowDefinitionSchema.parse` is structurally safe to persist and
 * execute: identifiers are constrained, payloads are size-bounded, and object keys
 * that would poison `Object.prototype` are rejected outright.
 */

/** Keys that must never appear in user-supplied objects. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const MAX_NODES = 250;
export const MAX_EDGES = 1000;
export const MAX_JSON_BYTES = 256 * 1024; // 256 KiB per payload document
export const MAX_JSON_DEPTH = 24;

/** Slug used for workflow keys and node keys. Kept URL- and log-safe. */
export const IdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    'must be lowercase alphanumeric, optionally separated by . _ or -',
  );

function assertSafeJson(value: unknown, depth = 0, path = '$'): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(`nesting deeper than ${MAX_JSON_DEPTH} levels at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafeJson(v, depth + 1, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`forbidden object key "${key}" at ${path}`);
      }
      assertSafeJson((value as Record<string, unknown>)[key], depth + 1, `${path}.${key}`);
    }
  }
}

/**
 * A JSON document that is safe to persist and to merge into an execution context.
 * Rejects prototype-polluting keys, unbounded nesting and oversized payloads.
 */
export const SafeJsonSchema: z.ZodType<unknown> = z.unknown().superRefine((value, ctx) => {
  try {
    assertSafeJson(value);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
    return;
  }
  let serialised: string;
  try {
    serialised = JSON.stringify(value ?? null);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'value is not JSON-serialisable' });
    return;
  }
  if (Buffer.byteLength(serialised, 'utf8') > MAX_JSON_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `payload exceeds ${MAX_JSON_BYTES} bytes`,
    });
  }
});

/**
 * A JSON *object* that is safe to persist.
 *
 * Built on `z.unknown()` rather than `z.record()` deliberately. Zod's record parser
 * rebuilds the object by assignment, which silently drops a `__proto__` key before any
 * refinement can see it. Nothing is polluted either way — the rebuilt object keeps
 * `Object.prototype` — but silently discarding part of a caller's payload is its own
 * bug: they get no error, and their handler config arrives missing a field.
 *
 * Validating the *raw* input instead means a hostile or malformed key is reported as a
 * validation error, which is both safer to reason about and far easier to debug.
 */
export const SafeJsonObjectSchema = z
  .unknown()
  .default({})
  .superRefine((value, ctx) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expected a JSON object' });
      return;
    }
    const result = SafeJsonSchema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue(issue);
    }
  })
  .transform((value) => value as Record<string, unknown>);

export const RetryPolicySchema = z
  .object({
    /** Total attempts including the first. 1 disables retries. */
    maxAttempts: z.number().int().min(1).max(20).default(3),
    initialDelayMs: z.number().int().min(0).max(3_600_000).default(1_000),
    maxDelayMs: z.number().int().min(0).max(86_400_000).default(60_000),
    /** delay(n) = initialDelay * multiplier^(n-2), clamped to maxDelayMs. */
    multiplier: z.number().min(1).max(10).default(2),
    /** Full jitter in [0, delay] to avoid retry stampedes across a fan-out. */
    jitter: z.boolean().default(true),
    /**
     * Error `code` values that should bypass the retry budget and fail immediately.
     * Useful for deterministic errors (validation, 4xx) where retrying is pointless.
     */
    nonRetryableErrors: z.array(z.string().min(1).max(64)).max(32).default([]),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.maxDelayMs < policy.initialDelayMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxDelayMs'],
        message: 'maxDelayMs must be >= initialDelayMs',
      });
    }
  });
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  multiplier: 2,
  jitter: true,
  nonRetryableErrors: [],
};

/**
 * A reference into the execution context, resolved by the engine.
 * Only these two shapes exist — there is no expression evaluation on the input side,
 * which keeps input mapping trivially safe.
 */
export const InputMappingSchema = z.record(
  z.string().min(1).max(64),
  z.union([
    /** `$.input.orderId`, `$.tasks.validate.output.total`, `$.run.id` */
    z.object({ from: z.string().min(2).max(256) }).strict(),
    /** A constant embedded in the definition. */
    z.object({ value: SafeJsonSchema }).strict(),
  ]),
);
export type InputMapping = z.infer<typeof InputMappingSchema>;

export const WorkflowNodeSchema = z
  .object({
    key: IdentifierSchema,
    name: z.string().min(1).max(120).optional(),
    /**
     * Handler type. A worker will only execute a node whose type it has explicitly
     * registered — an unknown type is a definition-validation error, never a
     * dynamic code path.
     */
    type: IdentifierSchema,
    description: z.string().max(500).optional(),
    /** Logical queue. Lets you pin heavy nodes to a dedicated worker pool. */
    queue: IdentifierSchema.default('default'),
    /** Wall-clock budget for a single attempt. */
    timeoutMs: z.number().int().min(100).max(86_400_000).default(60_000),
    retryPolicy: RetryPolicySchema.default(DEFAULT_RETRY_POLICY),
    /** Static handler configuration (e.g. `{ "durationMs": 500 }`). */
    config: SafeJsonObjectSchema,
    input: InputMappingSchema.default({}),
    /**
     * Boolean guard evaluated against the execution context before dispatch.
     * A falsy result marks the node SKIPPED and prunes nothing else — downstream
     * nodes treat SKIPPED as a satisfied dependency.
     */
    condition: z.string().min(1).max(512).optional(),
    /** Free-form labels surfaced in the console. */
    metadata: SafeJsonObjectSchema,
    /** Editor-only layout hint; ignored by the engine. */
    position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  })
  .strict();
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z
  .object({
    from: IdentifierSchema,
    to: IdentifierSchema,
    /** Optional guard on the edge itself, evaluated after `from` succeeds. */
    condition: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine((e) => e.from !== e.to, { message: 'a node cannot depend on itself' });
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    key: IdentifierSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    /** Budget for the whole run, enforced by the control plane. */
    timeoutMs: z.number().int().min(1_000).max(604_800_000).default(3_600_000),
    /** Default policy inherited by nodes that do not override it. */
    defaultRetryPolicy: RetryPolicySchema.default(DEFAULT_RETRY_POLICY),
    /** JSON Schema-lite description of the trigger payload, for docs and the console. */
    inputSchema: SafeJsonObjectSchema,
    /** Maps terminal task outputs into the run's `output` document. */
    output: InputMappingSchema.default({}),
    nodes: z.array(WorkflowNodeSchema).min(1).max(MAX_NODES),
    edges: z.array(WorkflowEdgeSchema).max(MAX_EDGES).default([]),
    metadata: SafeJsonObjectSchema,
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/** Trigger payload for a run. */
export const RunInputSchema = SafeJsonObjectSchema;
