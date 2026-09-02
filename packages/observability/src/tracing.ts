import {
  context,
  propagation,
  trace,
  SpanStatusCode,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

/**
 * Distributed tracing.
 *
 * The interesting property of a workflow trace is that it survives process boundaries
 * *and* a queue: an API request that creates a run, the outbox publish, the worker that
 * executes a task ten seconds later on another host, and the control plane's advance all
 * belong to one trace. That works because the W3C `traceparent` is serialised into the
 * queue message and re-extracted by the consumer — see `injectTraceContext` /
 * `extractTraceContext` below.
 *
 * The SDK bootstrap lives in `./sdk` and must be imported before anything else in a
 * process, which is why it is a separate module.
 */

export const TRACER_NAME = 'forge';

export function getTracer(name = TRACER_NAME): Tracer {
  return trace.getTracer(name);
}

export interface SerialisedTraceContext {
  traceparent?: string;
  tracestate?: string;
}

/** Serialise the active trace context for transport through Redis or the outbox. */
export function injectTraceContext(): SerialisedTraceContext {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const out: SerialisedTraceContext = {};
  if (carrier.traceparent) out.traceparent = carrier.traceparent;
  if (carrier.tracestate) out.tracestate = carrier.tracestate;
  return out;
}

/** Run `fn` with the trace context carried by a queue message as its parent. */
export async function withExtractedContext<T>(
  carrier: SerialisedTraceContext | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!carrier?.traceparent) return fn();
  const extracted = propagation.extract(context.active(), carrier as Record<string, string>);
  return context.with(extracted, fn);
}

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Run `fn` inside a span, recording exceptions and setting the status.
 *
 * Wrapping rather than manual start/end because a thrown error must still end the span —
 * an unended span is worse than no span, since it silently distorts every duration
 * aggregate downstream.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** The active trace id, for correlating a log line or a database row with a trace. */
export function currentTraceId(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  return ctx.traceId === '00000000000000000000000000000000' ? null : ctx.traceId;
}

export function currentSpanId(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  return ctx.spanId === '0000000000000000' ? null : ctx.spanId;
}

/** Semantic attribute names, kept in one place so they stay consistent across services. */
export const ATTR = {
  workflowKey: 'forge.workflow.key',
  workflowVersion: 'forge.workflow.version',
  runId: 'forge.run.id',
  taskRunId: 'forge.task.id',
  nodeKey: 'forge.task.node',
  taskType: 'forge.task.type',
  attempt: 'forge.task.attempt',
  workerId: 'forge.worker.id',
  queue: 'forge.queue',
  outcome: 'forge.outcome',
  reason: 'forge.reason',
  eventType: 'forge.event.type',
  batchSize: 'forge.batch.size',
} as const;
