import { z } from 'zod';

/**
 * Queue message shapes.
 *
 * Messages are *hints*, not state. Every consumer re-reads PostgreSQL and revalidates
 * before acting, so a duplicated, delayed or lost message can never corrupt a run —
 * at worst it costs a wasted round trip, or delays work until the next sweep.
 */

/** W3C trace context, propagated end-to-end so a run is one trace. */
export const TraceContextSchema = z
  .object({
    traceparent: z.string().max(200).optional(),
    tracestate: z.string().max(512).optional(),
  })
  .strict();
export type TraceContext = z.infer<typeof TraceContextSchema>;

export const TaskDispatchMessageSchema = z
  .object({
    kind: z.literal('task.dispatch'),
    taskRunId: z.string().uuid(),
    workflowRunId: z.string().uuid(),
    nodeKey: z.string(),
    type: z.string(),
    queue: z.string(),
    /** The attempt the producer expected. Used only for logging/diagnostics. */
    expectedAttempt: z.number().int().min(1),
    /** Deduplication hint; the durable guard is the DB claim, not this field. */
    dispatchId: z.string().uuid(),
    trace: TraceContextSchema.optional(),
  })
  .strict();
export type TaskDispatchMessage = z.infer<typeof TaskDispatchMessageSchema>;

export const RunAdvanceMessageSchema = z
  .object({
    kind: z.literal('run.advance'),
    workflowRunId: z.string().uuid(),
    reason: z.string().max(120),
    trace: TraceContextSchema.optional(),
  })
  .strict();
export type RunAdvanceMessage = z.infer<typeof RunAdvanceMessageSchema>;

export const QueueMessageSchema = z.discriminatedUnion('kind', [
  TaskDispatchMessageSchema,
  RunAdvanceMessageSchema,
]);
export type QueueMessage = z.infer<typeof QueueMessageSchema>;

/** Outbox event types. Each maps to exactly one transport action. */
export const OutboxEventType = {
  TASK_DISPATCH: 'TASK_DISPATCH',
  RUN_ADVANCE: 'RUN_ADVANCE',
  EVENT_BROADCAST: 'EVENT_BROADCAST',
} as const;
export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];
