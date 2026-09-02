import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CreateScheduleRequestSchema,
  ReplayDeadLetterRequestSchema,
  UpdateScheduleRequestSchema,
  type DeadLetterView,
  type Page,
  type ScheduleView,
  type WorkerView,
} from '@forge/contracts';
import {
  acknowledgeDeadLetter,
  createSchedule,
  listDeadLetters,
  listSchedules,
  listWorkers,
  retryDeadLetter,
  setScheduleEnabled,
  validateCron,
  computeNextRun,
  type PrismaClient,
} from '@forge/database';
import type { Logger } from '@forge/logger';
import { FORGE_CONFIG, FORGE_LOGGER, FORGE_PRISMA, type ApiConfig } from '../infra/providers';
import { UuidPipe, zodBody } from '../common/validation';

/**
 * Fleet, dead letters and schedules — the operator surface.
 *
 * These endpoints are what someone reaches for when something has gone wrong, so they
 * are deliberately explicit about what they did and did not do: a dead letter that
 * cannot be retried says *why* rather than returning a bare 400.
 */
@Controller('v1')
export class OperationsController {
  constructor(
    @Inject(FORGE_PRISMA) private readonly prisma: PrismaClient,
    @Inject(FORGE_LOGGER) private readonly logger: Logger,
    @Inject(FORGE_CONFIG) private readonly config: ApiConfig,
  ) {}

  // --- workers -------------------------------------------------------------

  @Get('workers')
  async workers(): Promise<{ items: WorkerView[] }> {
    return {
      items: await listWorkers(this.prisma, this.config.FORGE_WORKER_LIVENESS_MS),
    };
  }

  // --- dead letters --------------------------------------------------------

  @Get('dead-letters')
  async deadLetters(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<Page<DeadLetterView>> {
    return listDeadLetters(this.prisma, {
      ...(status ? { status } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(cursor ? { cursor } : {}),
    });
  }

  /**
   * Return a dead-lettered task to the queue, in place.
   *
   * Only possible while its run is still live. A dead letter belonging to a finished run
   * cannot be retried in place — there is nothing to continue — so the caller is told to
   * replay the run instead, rather than being given a misleading success.
   */
  @Post('dead-letters/:id/retry')
  @HttpCode(202)
  async retryDeadLetter(
    @Param('id', UuidPipe) id: string,
    @Body(zodBody(ReplayDeadLetterRequestSchema))
    body: { resetAttempts: boolean; input?: Record<string, unknown> },
  ): Promise<{ retried: boolean; taskRunId?: string; workflowRunId?: string }> {
    const result = await retryDeadLetter(this.prisma, id, {
      resetAttempts: body.resetAttempts,
      ...(body.input ? { input: body.input } : {}),
      actor: 'api',
    });

    if (!result.retried) {
      if (result.reason === 'not-found') {
        throw new NotFoundException('dead letter "' + id + '" not found');
      }
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'DeadLetterNotRetryable',
        message:
          result.reason === 'run-terminal'
            ? 'the parent run has already finished; use POST /v1/runs/:id/replay to start a new run'
            : result.reason === 'already-resolved'
              ? 'this dead letter has already been retried or acknowledged'
              : 'the task is not in a state that can be retried',
        details: { reason: result.reason },
      });
    }

    this.logger.info(
      { deadLetterId: id, taskRunId: result.taskRunId, workflowRunId: result.workflowRunId },
      'dead letter retried',
    );
    return result as { retried: boolean; taskRunId: string; workflowRunId: string };
  }

  @Post('dead-letters/:id/acknowledge')
  @HttpCode(200)
  async acknowledge(@Param('id', UuidPipe) id: string): Promise<{ acknowledged: boolean }> {
    const acknowledged = await acknowledgeDeadLetter(this.prisma, id, 'api');
    if (!acknowledged) {
      throw new NotFoundException('dead letter "' + id + '" not found or already resolved');
    }
    this.logger.info({ deadLetterId: id }, 'dead letter acknowledged');
    return { acknowledged };
  }

  // --- schedules -----------------------------------------------------------

  @Get('schedules')
  async schedules(): Promise<{ items: ScheduleView[] }> {
    return { items: await listSchedules(this.prisma) };
  }

  @Post('schedules')
  @HttpCode(201)
  async createSchedule(
    @Body(zodBody(CreateScheduleRequestSchema))
    body: {
      workflowKey: string;
      name: string;
      cron?: string;
      runAt?: Date;
      timezone: string;
      input: Record<string, unknown>;
      enabled: boolean;
    },
  ): Promise<{ id: string; nextRunAt: string | null }> {
    if (body.cron) {
      // Validated here so an unparseable expression is a 400 at creation rather than a
      // schedule that silently disables itself on the control plane's first tick.
      const check = validateCron(body.cron, body.timezone);
      if (!check.ok) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'InvalidCronExpression',
          message: check.message,
        });
      }
    }

    const created = await createSchedule(this.prisma, {
      workflowKey: body.workflowKey,
      name: body.name,
      ...(body.cron ? { cron: body.cron } : {}),
      ...(body.runAt ? { runAt: body.runAt } : {}),
      timezone: body.timezone,
      input: body.input,
      enabled: body.enabled,
    });
    if (!created) throw new NotFoundException('workflow "' + body.workflowKey + '" not found');

    this.logger.info(
      { scheduleId: created.id, workflowKey: body.workflowKey, cron: body.cron },
      'schedule created',
    );
    return { id: created.id, nextRunAt: created.nextRunAt?.toISOString() ?? null };
  }

  @Patch('schedules/:id')
  async updateSchedule(
    @Param('id', UuidPipe) id: string,
    @Body(zodBody(UpdateScheduleRequestSchema)) body: { enabled?: boolean },
  ): Promise<{ updated: boolean }> {
    if (body.enabled === undefined) return { updated: false };
    const updated = await setScheduleEnabled(this.prisma, id, body.enabled);
    if (!updated) throw new NotFoundException('schedule "' + id + '" not found');
    this.logger.info({ scheduleId: id, enabled: body.enabled }, 'schedule updated');
    return { updated };
  }

  /** Preview the next occurrences of a cron expression, for the schedule editor. */
  @Get('schedules/preview')
  preview(
    @Query('cron') cron?: string,
    @Query('timezone') timezone = 'UTC',
  ): { valid: boolean; message?: string; next: string[] } {
    if (!cron) return { valid: false, message: 'cron query parameter is required', next: [] };
    const check = validateCron(cron, timezone);
    if (!check.ok) return { valid: false, message: check.message, next: [] };

    const next: string[] = [];
    let cursor = new Date();
    for (let i = 0; i < 5; i++) {
      cursor = computeNextRun(cron, timezone, cursor);
      next.push(cursor.toISOString());
    }
    return { valid: true, next };
  }
}
