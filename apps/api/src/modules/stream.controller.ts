import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CHANNELS, type ExecutionEvent } from '@forge/contracts';
import { listEvents, type PrismaClient } from '@forge/database';
import type { Logger } from '@forge/logger';
import type { ForgeMetrics } from '@forge/observability';
import type { Transport } from '@forge/transport';
import {
  FORGE_CONFIG,
  FORGE_LOGGER,
  FORGE_METRICS,
  FORGE_PRISMA,
  FORGE_TRANSPORT,
  type ApiConfig,
} from '../infra/providers';
import { UuidPipe } from '../common/validation';

/**
 * Real-time execution events over Server-Sent Events.
 *
 * SSE rather than WebSockets because the traffic is strictly one-directional, it rides
 * on plain HTTP (so it survives proxies and needs no separate upgrade path), and the
 * browser reconnects on its own. The console never sends anything up this channel — it
 * uses ordinary REST calls for commands.
 *
 * The reliability model is the part worth reading:
 *
 *   1. on connect, the client sends `Last-Event-ID` (or `?afterSeq=`)
 *   2. the server replays everything after that sequence from PostgreSQL
 *   3. only then does it attach to the Redis pub/sub firehose
 *
 * So a dropped connection, a missed broadcast, or a Redis restart all degrade to a
 * replay rather than a gap. The durable log is the contract; pub/sub is the accelerator.
 */
@Controller('v1')
export class StreamController {
  constructor(
    @Inject(FORGE_PRISMA) private readonly prisma: PrismaClient,
    @Inject(FORGE_TRANSPORT) private readonly transport: Transport,
    @Inject(FORGE_LOGGER) private readonly logger: Logger,
    @Inject(FORGE_METRICS) private readonly metrics: ForgeMetrics,
    @Inject(FORGE_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('runs/:id/stream')
  async streamRun(
    @Param('id', UuidPipe) runId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query('afterSeq') afterSeqQuery?: string,
  ): Promise<void> {
    const lastEventId = req.header('last-event-id');
    const afterSeq = Number(lastEventId ?? afterSeqQuery ?? 0) || 0;

    this.openStream(res);
    this.metrics.sseConnections.inc();

    // Replay from the durable log first, so the client is provably caught up before any
    // live event arrives.
    let lastSeq = afterSeq;
    try {
      const backlog = await listEvents(this.prisma, {
        workflowRunId: runId,
        afterSeq,
        limit: 1000,
      });
      for (const event of backlog) {
        this.write(res, toView(event));
        lastSeq = event.seq;
      }
    } catch (err) {
      this.logger.warn(
        { workflowRunId: runId, err: (err as Error).message },
        'failed to replay event backlog',
      );
    }

    const unsubscribe = await this.transport.subscribe(CHANNELS.eventsForRun(runId), (payload) => {
      try {
        const event = JSON.parse(payload) as ExecutionEvent;
        // Drop anything the replay already delivered — pub/sub and the backlog
        // overlap by design, and the client must not see an event twice.
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        this.write(res, event);
      } catch {
        /* malformed broadcast: the durable log is unaffected, so ignore it */
      }
    });

    this.attachLifecycle(res, req, unsubscribe, { workflowRunId: runId });
  }

  /** The global feed, for the console's activity view. */
  @Get('events/stream')
  async streamAll(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.openStream(res);
    this.metrics.sseConnections.inc();

    const unsubscribe = await this.transport.subscribe(CHANNELS.eventsAll, (payload) => {
      try {
        this.write(res, JSON.parse(payload) as ExecutionEvent);
      } catch {
        /* ignore malformed broadcast */
      }
    });

    this.attachLifecycle(res, req, unsubscribe, {});
  }

  private openStream(res: Response): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Without this, nginx buffers the stream and nothing arrives until it closes.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    // Flush headers immediately so the browser fires `onopen` rather than waiting for
    // the first event, which may be minutes away on an idle run.
    res.flushHeaders?.();
  }

  private write(res: Response, event: ExecutionEvent): void {
    // `id:` is what the browser sends back as Last-Event-ID after a reconnect.
    res.write('id: ' + event.seq + '\n');
    res.write('event: ' + event.type + '\n');
    res.write('data: ' + JSON.stringify(event) + '\n\n');
  }

  private attachLifecycle(
    res: Response,
    req: Request,
    unsubscribe: () => void,
    context: Record<string, unknown>,
  ): void {
    // Periodic comment frames keep proxies and load balancers from culling an idle
    // connection, and let the server notice a client that vanished without a FIN.
    const heartbeat = setInterval(() => {
      res.write(': heartbeat ' + Date.now() + '\n\n');
    }, this.config.FORGE_SSE_HEARTBEAT_MS);

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.metrics.sseConnections.dec();
      this.logger.debug(context, 'sse connection closed');
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }
}

function toView(event: {
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
}): ExecutionEvent {
  return {
    id: event.id,
    seq: event.seq,
    type: event.type as ExecutionEvent['type'],
    workflowRunId: event.workflowRunId,
    taskRunId: event.taskRunId,
    nodeKey: event.nodeKey,
    workerId: event.workerId,
    attemptNumber: event.attemptNumber,
    traceId: event.traceId,
    message: event.message,
    payload: (event.payload ?? null) as Record<string, unknown> | null,
    occurredAt: event.occurredAt.toISOString(),
  };
}
