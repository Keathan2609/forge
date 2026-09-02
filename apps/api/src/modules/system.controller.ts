import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { DashboardStatsView, SystemStatusView } from '@forge/contracts';
import {
  dashboardStats,
  fleetSummary,
  outboxHealth,
  pingDatabase,
  type PrismaClient,
} from '@forge/database';
import type { ForgeMetrics } from '@forge/observability';
import type { Transport } from '@forge/transport';
import {
  FORGE_CONFIG,
  FORGE_METRICS,
  FORGE_PRISMA,
  FORGE_TRANSPORT,
  type ApiConfig,
} from '../infra/providers';

/**
 * Health, metrics and the dashboard aggregate.
 *
 * Two distinct health endpoints, because they answer different questions:
 *
 *   /health        is this process alive? (liveness — restarting fixes it)
 *   /health/ready  can it serve traffic? (readiness — remove it from the load balancer)
 *
 * Conflating them is how a transient database blip turns into a restart loop that makes
 * the outage permanent.
 */
@Controller()
export class SystemController {
  constructor(
    @Inject(FORGE_PRISMA) private readonly prisma: PrismaClient,
    @Inject(FORGE_TRANSPORT) private readonly transport: Transport,
    @Inject(FORGE_METRICS) private readonly metrics: ForgeMetrics,
    @Inject(FORGE_CONFIG) private readonly config: ApiConfig,
  ) {}

  /** Liveness. Deliberately touches no dependency. */
  @Get('health')
  health(): { status: string; service: string; version: string; uptimeSeconds: number } {
    return {
      status: 'ok',
      service: 'forge-api',
      version: this.config.FORGE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /** Readiness. Checks the dependencies a request would actually need. */
  @Get('health/ready')
  async ready(@Res() res: Response): Promise<void> {
    const checks = await Promise.allSettled([pingDatabase(this.prisma), this.transport.ping()]);
    const database = checks[0];
    const redis = checks[1];
    const ok = database.status === 'fulfilled' && redis.status === 'fulfilled';

    res.status(ok ? 200 : 503).json({
      status: ok ? 'ready' : 'not-ready',
      database:
        database.status === 'fulfilled'
          ? { ok: true, latencyMs: database.value }
          : { ok: false, error: 'unreachable' },
      redis:
        redis.status === 'fulfilled'
          ? { ok: true, latencyMs: redis.value }
          : { ok: false, error: 'unreachable' },
    });
  }

  @Get('metrics')
  @Header('cache-control', 'no-store')
  async prometheusMetrics(@Res() res: Response): Promise<void> {
    const body = await this.metrics.registry.metrics();
    res.setHeader('content-type', this.metrics.registry.contentType);
    res.send(body);
  }

  /**
   * Component-level system status for the console.
   *
   * `degraded` rather than `unhealthy` when the outbox is lagging: the system is still
   * accepting and persisting work, it is just not dispatching it promptly — a meaningful
   * distinction when deciding whether to page someone.
   */
  @Get('v1/system/status')
  async status(): Promise<SystemStatusView> {
    const [databaseResult, redisResult, fleet, outbox] = await Promise.allSettled([
      pingDatabase(this.prisma),
      this.transport.ping(),
      fleetSummary(this.prisma),
      outboxHealth(this.prisma),
    ]);

    const database =
      databaseResult.status === 'fulfilled'
        ? { ok: true, latencyMs: databaseResult.value }
        : { ok: false, latencyMs: null, message: 'unreachable' };

    const redis =
      redisResult.status === 'fulfilled'
        ? { ok: true, latencyMs: redisResult.value }
        : { ok: false, latencyMs: null, message: 'unreachable' };

    const fleetValue =
      fleet.status === 'fulfilled'
        ? fleet.value
        : { online: 0, unresponsive: 0, offline: 0, totalCapacity: 0, activeTasks: 0 };

    const outboxValue =
      outbox.status === 'fulfilled'
        ? outbox.value
        : { pending: 0, failed: 0, oldestPendingAgeMs: null };

    const outboxHealthy =
      outboxValue.oldestPendingAgeMs === null || outboxValue.oldestPendingAgeMs < 30_000;

    const healthy = database.ok && redis.ok && fleetValue.online > 0 && outboxHealthy;

    return {
      status: healthy ? 'healthy' : 'degraded',
      checkedAt: new Date().toISOString(),
      components: {
        database,
        redis,
        workers: {
          ok: fleetValue.online > 0,
          online: fleetValue.online,
          unresponsive: fleetValue.unresponsive,
        },
        outbox: {
          ok: outboxHealthy,
          pending: outboxValue.pending,
          oldestPendingAgeMs: outboxValue.oldestPendingAgeMs,
        },
      },
      version: this.config.FORGE_VERSION,
    };
  }

  /** One request backing the whole console home page. */
  @Get('v1/system/stats')
  async stats(): Promise<DashboardStatsView> {
    return dashboardStats(this.prisma);
  }
}
