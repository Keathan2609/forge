import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  CancelRunRequestSchema,
  ListRunsQuerySchema,
  ReplayRunRequestSchema,
  TriggerRunRequestSchema,
  type ExecutionEvent,
  type Page,
  type TaskAttemptView,
  type WorkflowRunView,
} from '@forge/contracts';
import {
  createRun,
  getRun,
  listEvents,
  listRuns,
  listTaskAttempts,
  replayRun,
  requestCancellation,
  type PrismaClient,
} from '@forge/database';
import type { Logger } from '@forge/logger';
import { injectTraceContext, type ForgeMetrics } from '@forge/observability';
import type { Transport } from '@forge/transport';
import { FORGE_LOGGER, FORGE_METRICS, FORGE_PRISMA, FORGE_TRANSPORT } from '../infra/providers';
import { UuidPipe, WorkflowKeyPipe, zodBody, zodQuery } from '../common/validation';

/**
 * Run lifecycle.
 *
 * Triggering a run writes the run, its tasks and an outbox intent in one transaction and
 * returns immediately. It does not wait for a worker, and it does not push to Redis —
 * the outbox publisher does that after the commit, so a crash between the two cannot
 * lose the dispatch.
 */
@Controller('v1')
export class RunsController {
  constructor(
    @Inject(FORGE_PRISMA) private readonly prisma: PrismaClient,
    @Inject(FORGE_TRANSPORT) private readonly transport: Transport,
    @Inject(FORGE_LOGGER) private readonly logger: Logger,
    @Inject(FORGE_METRICS) private readonly metrics: ForgeMetrics,
  ) {}

  @Post('workflows/:key/runs')
  @HttpCode(202)
  async trigger(
    @Param('key', WorkflowKeyPipe) key: string,
    @Body(zodBody(TriggerRunRequestSchema))
    body: {
      input: Record<string, unknown>;
      version?: number;
      idempotencyKey?: string;
      metadata: Record<string, unknown>;
    },
    // The header form is the convention most HTTP clients already implement; the body
    // field exists for the SDK. Header wins when both are present.
    @Headers('idempotency-key') headerKey?: string,
  ): Promise<{ runId: string; version: number; created: boolean; state: string }> {
    const idempotencyKey = headerKey ?? body.idempotencyKey;

    const result = await createRun(this.prisma, {
      workflowKey: key,
      ...(body.version !== undefined ? { version: body.version } : {}),
      input: body.input,
      metadata: body.metadata,
      triggeredBy: 'api',
      ...(idempotencyKey ? { idempotencyKey } : {}),
      // Carrying the trace context through the outbox is what makes the whole run —
      // API request, dispatch, worker execution — a single trace.
      trace: injectTraceContext(),
    });

    if (result.created) {
      this.metrics.workflowsStarted.inc({ workflow: key });
      this.logger.info(
        { workflowKey: key, workflowRunId: result.runId, version: result.version },
        'run triggered',
      );
    } else {
      this.logger.info(
        { workflowKey: key, workflowRunId: result.runId, idempotencyKey },
        'idempotent trigger returned the existing run',
      );
    }

    return {
      runId: result.runId,
      version: result.version,
      created: result.created,
      state: 'PENDING',
    };
  }

  @Get('runs')
  async list(
    @Query(zodQuery(ListRunsQuerySchema))
    query: {
      limit: number;
      cursor?: string;
      workflowKey?: string;
      state?: string;
      since?: Date;
    },
  ): Promise<Page<WorkflowRunView>> {
    return listRuns(this.prisma, {
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.workflowKey ? { workflowKey: query.workflowKey } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.since ? { since: query.since } : {}),
    });
  }

  @Get('runs/:id')
  async get(@Param('id', UuidPipe) id: string): Promise<WorkflowRunView> {
    const run = await getRun(this.prisma, id);
    if (!run) throw new NotFoundException('run "' + id + '" not found');
    return run;
  }

  /**
   * The run's event history.
   *
   * `afterSeq` is what makes the live stream reliable: a console that dropped its SSE
   * connection at sequence 42 asks for everything after 42 and is exactly caught up,
   * with no gap and no duplicates.
   */
  @Get('runs/:id/events')
  async events(
    @Param('id', UuidPipe) id: string,
    @Query('afterSeq') afterSeq?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: ExecutionEvent[] }> {
    const events = await listEvents(this.prisma, {
      workflowRunId: id,
      ...(afterSeq !== undefined ? { afterSeq: Number(afterSeq) } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
    return {
      items: events.map((e) => ({
        id: e.id,
        seq: e.seq,
        type: e.type as ExecutionEvent['type'],
        workflowRunId: e.workflowRunId,
        taskRunId: e.taskRunId,
        nodeKey: e.nodeKey,
        workerId: e.workerId,
        attemptNumber: e.attemptNumber,
        traceId: e.traceId,
        message: e.message,
        payload: (e.payload ?? null) as Record<string, unknown> | null,
        occurredAt: e.occurredAt.toISOString(),
      })),
    };
  }

  @Get('tasks/:id/attempts')
  async attempts(@Param('id', UuidPipe) id: string): Promise<{ items: TaskAttemptView[] }> {
    return { items: await listTaskAttempts(this.prisma, id) };
  }

  /**
   * Request cancellation.
   *
   * Returns 202, not 200: cancellation is cooperative. Running tasks observe the flag on
   * their next lease renewal and stop; queued tasks are cancelled by the control plane's
   * next advance. Claiming the run is cancelled the instant this returns would be a lie.
   */
  @Post('runs/:id/cancel')
  @HttpCode(202)
  async cancel(
    @Param('id', UuidPipe) id: string,
    @Body(zodBody(CancelRunRequestSchema)) body: { reason?: string },
  ): Promise<{ accepted: boolean; message: string }> {
    const result = await requestCancellation(this.prisma, id, body.reason);

    if (result.alreadyFinished) {
      return { accepted: false, message: 'run has already reached a terminal state' };
    }
    if (!result.cancelled) throw new NotFoundException('run "' + id + '" not found');

    // Mirror the flag into Redis so a running worker can check it without a query.
    await this.transport.setCancelFlag(id).catch(() => undefined);

    this.logger.info({ workflowRunId: id, reason: body.reason }, 'cancellation requested');
    return {
      accepted: true,
      message: 'cancellation requested; in-flight tasks will stop at their next checkpoint',
    };
  }

  /**
   * Replay a run as a new run.
   *
   * Never mutates the original. Defaults to the same workflow version so the replay
   * reproduces the original behaviour rather than silently testing a newer graph.
   */
  @Post('runs/:id/replay')
  @HttpCode(202)
  async replay(
    @Param('id', UuidPipe) id: string,
    @Body(zodBody(ReplayRunRequestSchema))
    body: { useLatestVersion: boolean; input?: Record<string, unknown> },
  ): Promise<{ runId: string; version: number; replayOf: string }> {
    const result = await replayRun(this.prisma, id, {
      useLatestVersion: body.useLatestVersion,
      ...(body.input ? { input: body.input } : {}),
      triggeredBy: 'replay',
    });

    this.logger.info(
      { originalRunId: id, workflowRunId: result.runId, version: result.version },
      'run replayed',
    );
    return { runId: result.runId, version: result.version, replayOf: id };
  }
}
