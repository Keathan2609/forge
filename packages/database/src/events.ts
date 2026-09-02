import { type ExecutionEventType } from '@forge/contracts';
import { redactSecrets, truncateForDisplay } from '@forge/engine';
import { type Prisma, type Tx } from './client';

/**
 * Append-only execution event log.
 *
 * Events are written inside the same transaction as the state change they describe, so
 * the log can never claim something that did not happen (or miss something that did).
 * The per-run `seq` is allocated by incrementing a counter on the run row in that same
 * transaction, which gives subscribers a gap-free total order to resume from — a
 * timestamp would not, because two events can share a millisecond.
 */

export interface RecordEventInput {
  workflowRunId: string;
  type: ExecutionEventType;
  taskRunId?: string | null;
  nodeKey?: string | null;
  workerId?: string | null;
  attemptNumber?: number | null;
  traceId?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface RecordedEvent {
  id: string;
  seq: number;
  type: string;
  workflowRunId: string;
  taskRunId: string | null;
  nodeKey: string | null;
  workerId: string | null;
  attemptNumber: number | null;
  traceId: string | null;
  message: string | null;
  payload: unknown;
  occurredAt: Date;
}

/** Payloads are truncated and redacted on the way in — the log is not a data store. */
function sanitisePayload(
  payload: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (!payload) return undefined;
  return truncateForDisplay(redactSecrets(payload), 4 * 1024) as Prisma.InputJsonValue;
}

export async function recordEvent(tx: Tx, input: RecordEventInput): Promise<RecordedEvent> {
  // Atomic counter bump. `update ... increment` compiles to `SET seq = seq + 1`, so two
  // concurrent writers in separate transactions serialise on the run row rather than
  // both reading the same value.
  const run = await tx.workflowRun.update({
    where: { id: input.workflowRunId },
    data: { eventSeq: { increment: 1 } },
    select: { eventSeq: true },
  });

  const payload = sanitisePayload(input.payload);

  const event = await tx.executionEvent.create({
    data: {
      workflowRunId: input.workflowRunId,
      seq: run.eventSeq,
      type: input.type,
      taskRunId: input.taskRunId ?? null,
      nodeKey: input.nodeKey ?? null,
      workerId: input.workerId ?? null,
      attemptNumber: input.attemptNumber ?? null,
      traceId: input.traceId ?? null,
      message: input.message ?? null,
      ...(payload === undefined ? {} : { payload }),
    },
  });

  return event as RecordedEvent;
}

/** Write several events for one run, preserving order and allocating a seq for each. */
export async function recordEvents(tx: Tx, inputs: RecordEventInput[]): Promise<RecordedEvent[]> {
  const out: RecordedEvent[] = [];
  for (const input of inputs) {
    out.push(await recordEvent(tx, input));
  }
  return out;
}

export interface ListEventsOptions {
  workflowRunId: string;
  /** Return only events strictly after this sequence number. */
  afterSeq?: number;
  limit?: number;
}

/**
 * Read a run's events. Used by the SSE endpoint on connect and reconnect: a client that
 * dropped at seq 42 asks for `afterSeq=42` and receives exactly what it missed, which
 * is why a lost pub/sub message is a latency problem rather than a correctness one.
 */
export async function listEvents(tx: Tx, options: ListEventsOptions): Promise<RecordedEvent[]> {
  const rows = await tx.executionEvent.findMany({
    where: {
      workflowRunId: options.workflowRunId,
      ...(options.afterSeq !== undefined ? { seq: { gt: options.afterSeq } } : {}),
    },
    orderBy: { seq: 'asc' },
    take: Math.min(options.limit ?? 500, 2000),
  });
  return rows as RecordedEvent[];
}
