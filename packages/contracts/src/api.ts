import { z } from 'zod';
import { WorkflowDefinitionSchema, IdentifierSchema, SafeJsonObjectSchema } from './workflow';

/** Request/response contracts for the REST API. Shared verbatim by the SDK and CLI. */

export const CreateWorkflowRequestSchema = z
  .object({
    definition: WorkflowDefinitionSchema,
    /** Optional human note recorded against the version, e.g. "added fraud check". */
    changelog: z.string().max(500).optional(),
  })
  .strict();
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequestSchema>;

export const TriggerRunRequestSchema = z
  .object({
    input: SafeJsonObjectSchema,
    /** Pin the run to a specific version. Defaults to the definition's latest. */
    version: z.number().int().min(1).optional(),
    /**
     * Caller-supplied dedupe key. Two triggers with the same key against the same
     * workflow return the same run instead of creating a second one.
     */
    idempotencyKey: z.string().min(8).max(200).optional(),
    metadata: SafeJsonObjectSchema,
  })
  .strict();
export type TriggerRunRequest = z.infer<typeof TriggerRunRequestSchema>;

export const PaginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    /** Opaque cursor — the id of the last row from the previous page. */
    cursor: z.string().max(200).optional(),
  })
  .strict();
export type Pagination = z.infer<typeof PaginationSchema>;

export const ListRunsQuerySchema = PaginationSchema.extend({
  workflowKey: IdentifierSchema.optional(),
  state: z
    .enum(['PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])
    .optional(),
  since: z.coerce.date().optional(),
}).strict();
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;

export const CancelRunRequestSchema = z.object({ reason: z.string().max(500).optional() }).strict();

export const ReplayRunRequestSchema = z
  .object({
    /** Replay against the version the original run used, or the latest. */
    useLatestVersion: z.boolean().default(false),
    /** Override the original trigger input. Omit to reuse it verbatim. */
    input: SafeJsonObjectSchema.optional(),
  })
  .strict();

export const CreateScheduleRequestSchema = z
  .object({
    workflowKey: IdentifierSchema,
    name: z.string().min(1).max(120),
    /** Standard 5-field cron. Mutually exclusive with `runAt`. */
    cron: z.string().min(9).max(120).optional(),
    /** One-shot execution time. Mutually exclusive with `cron`. */
    runAt: z.coerce.date().optional(),
    timezone: z.string().max(64).default('UTC'),
    input: SafeJsonObjectSchema,
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((s) => Boolean(s.cron) !== Boolean(s.runAt), {
    message: 'provide exactly one of `cron` or `runAt`',
  });
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

export const UpdateScheduleRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    cron: z.string().min(9).max(120).optional(),
    input: SafeJsonObjectSchema.optional(),
  })
  .strict();

export const ReplayDeadLetterRequestSchema = z
  .object({
    /** Reset the attempt counter so the node gets a fresh retry budget. */
    resetAttempts: z.boolean().default(true),
    /** Optionally override the node input for the replay. */
    input: SafeJsonObjectSchema.optional(),
  })
  .strict();

/** Failure-injection controls. Only mounted when FORGE_DEMO_MODE=true. */
export const FailureInjectionRuleSchema = z
  .object({
    /** Node key or `*` for every node. */
    nodeKey: z.string().min(1).max(64),
    mode: z.enum(['fail', 'timeout', 'slow', 'crash-worker', 'transient']),
    /** 0..1 — probability the rule fires on a given attempt. */
    probability: z.number().min(0).max(1).default(1),
    /** For `slow`: added delay. For `transient`: fail until this attempt number. */
    value: z.number().int().min(0).max(600_000).default(0),
    /** Rule auto-expires so a forgotten injection cannot poison a demo. */
    expiresInMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  })
  .strict();
export type FailureInjectionRule = z.infer<typeof FailureInjectionRuleSchema>;

/** Uniform API error body. */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  /** Zod issues, when the failure was schema validation. */
  details?: unknown;
  requestId?: string;
}
