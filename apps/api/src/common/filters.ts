import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { GraphValidationError, IllegalTransitionError, ExpressionError } from '@forge/engine';
import { IdempotencyConflictError, WorkflowNotFoundError, InvalidCronError } from '@forge/database';
import { serialiseError, type Logger } from '@forge/logger';
import { currentTraceId, type ForgeMetrics } from '@forge/observability';
import { FORGE_LOGGER, FORGE_METRICS } from '../infra/providers';

/**
 * Error translation and request instrumentation.
 *
 * Domain errors are mapped to HTTP status codes in one place rather than each controller
 * catching and re-throwing. The important property is that a client can distinguish
 * "your definition has a cycle" (400, with the cycle) from "the database is down" (500,
 * with a request id and nothing else) — and that the second case never leaks a stack
 * trace or a connection string.
 */

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
  requestId?: string;
  traceId?: string;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(@Inject(FORGE_LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as Request & { requestId?: string }).requestId;

    const body = this.translate(exception);
    if (requestId) body.requestId = requestId;
    const traceId = currentTraceId();
    if (traceId) body.traceId = traceId;

    if (body.statusCode >= 500) {
      this.logger.error(
        {
          requestId,
          method: request.method,
          path: request.path,
          err: serialiseError(exception),
        },
        'request failed',
      );
    } else {
      this.logger.debug(
        { requestId, method: request.method, path: request.path, status: body.statusCode },
        body.message,
      );
    }

    if (response.headersSent) return;
    response.status(body.statusCode).json(body);
  }

  private translate(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      if (typeof payload === 'object' && payload !== null && 'error' in payload) {
        return { statusCode: exception.getStatus(), ...(payload as object) } as ErrorBody;
      }
      return {
        statusCode: exception.getStatus(),
        error: HttpStatus[exception.getStatus()] ?? 'Error',
        message: typeof payload === 'string' ? payload : exception.message,
      };
    }

    // A definition that is not a DAG is the caller's problem, and they need the details
    // to fix it — this is the response the console renders inline in the editor.
    if (exception instanceof GraphValidationError) {
      return {
        statusCode: 400,
        error: 'InvalidWorkflowDefinition',
        message: exception.message,
        details: exception.issues,
      };
    }

    if (exception instanceof ExpressionError) {
      return {
        statusCode: 400,
        error: 'InvalidExpression',
        message: exception.message,
        details: { expression: exception.expression, position: exception.position },
      };
    }

    if (exception instanceof InvalidCronError) {
      return { statusCode: 400, error: 'InvalidCronExpression', message: exception.message };
    }

    if (exception instanceof WorkflowNotFoundError) {
      return { statusCode: 404, error: 'WorkflowNotFound', message: exception.message };
    }

    if (exception instanceof IdempotencyConflictError) {
      return { statusCode: 409, error: 'IdempotencyKeyConflict', message: exception.message };
    }

    // Reaching this means a caller found a path that bypasses the guarded transitions —
    // a server bug, not a client error, so it is a 500 and gets logged as such.
    if (exception instanceof IllegalTransitionError) {
      return {
        statusCode: 500,
        error: 'IllegalStateTransition',
        message: 'the requested operation is not valid for the current state',
        details: { from: exception.from, to: exception.to },
      };
    }

    // Anything unrecognised: no message, no stack. The request id is the way back to the
    // detail, which is in the logs where it belongs.
    return {
      statusCode: 500,
      error: 'InternalServerError',
      message: 'an unexpected error occurred',
    };
  }
}

/**
 * Assigns a request id, records metrics, and logs one line per request.
 *
 * The route label is the *template* (`/v1/runs/:id`), never the concrete path —
 * labelling by concrete path would give Prometheus one time series per run id and
 * take the metrics endpoint down within an hour.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(FORGE_LOGGER) private readonly logger: Logger,
    @Inject(FORGE_METRICS) private readonly metrics: ForgeMetrics,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = req.header('x-request-id') ?? randomUUID();
    (req as Request & { requestId?: string }).requestId = requestId;
    res.setHeader('x-request-id', requestId);

    if (req.path.startsWith('/health') || req.path === '/metrics') {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      const route = normaliseRoute(req);

      this.metrics.httpRequests.inc({
        method: req.method,
        route,
        status: String(res.statusCode),
      });
      this.metrics.httpDuration.observe({ method: req.method, route }, durationSeconds);

      this.logger.info(
        {
          requestId,
          method: req.method,
          route,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(durationSeconds * 1000),
          traceId: currentTraceId(),
        },
        req.method + ' ' + req.path + ' ' + res.statusCode,
      );
    });

    next();
  }
}

/** Collapse concrete ids into their route template to keep label cardinality bounded. */
function normaliseRoute(req: Request): string {
  const route = (req as Request & { route?: { path?: string } }).route?.path;
  if (route) {
    const base = (req.baseUrl ?? '').replace(/\/$/, '');
    return base + route || route;
  }
  return req.path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:n');
}
