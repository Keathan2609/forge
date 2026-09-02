import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { InfraModule } from './infra/providers';
import { ApiKeyGuard, RateLimitGuard } from './common/guards';
import { DomainExceptionFilter, RequestContextMiddleware } from './common/filters';
import { WorkflowsController } from './modules/workflows.controller';
import { RunsController } from './modules/runs.controller';
import { StreamController } from './modules/stream.controller';
import { OperationsController } from './modules/operations.controller';
import { SystemController } from './modules/system.controller';

/**
 * The API application.
 *
 * Controllers are grouped by the operation an *operator* performs, not by database
 * table: `OperationsController` owns workers, dead letters and schedules because they
 * are the three things you touch when something has gone wrong. Splitting them into
 * three modules would add ceremony without adding a boundary.
 *
 * Guards are registered globally and ordered deliberately: rate limiting runs before
 * authentication, so a flood of unauthenticated requests is rejected without doing the
 * (cheap, but not free) constant-time key comparison for each one.
 */
@Module({
  imports: [InfraModule],
  controllers: [
    SystemController,
    WorkflowsController,
    RunsController,
    StreamController,
    OperationsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
