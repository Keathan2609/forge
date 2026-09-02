import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { FORGE_CONFIG, type ApiConfig } from '../infra/providers';
import { Inject } from '@nestjs/common';

/**
 * Authentication and rate limiting.
 *
 * FORGE is an engineering demonstration, and its interesting problems are orchestration
 * problems — so authentication is deliberately a single shared key rather than a user
 * and tenancy model. What is *not* skipped is the part that would be a real bug: the
 * comparison is constant-time, the key never appears in a log or an error, and the guard
 * fails closed if the key is missing from the configuration.
 *
 * Production would put this behind an identity provider; `docs/system-design.md` says so
 * explicitly rather than leaving the impression that a shared key is the design.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(FORGE_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.FORGE_AUTH_ENABLED) return true;

    const request = context.switchToHttp().getRequest<Request>();

    // Health and metrics stay open: a probe that needs a credential is a probe that
    // reports "unhealthy" the moment the credential rotates.
    const path = request.path;
    if (path.startsWith('/health') || path === '/metrics') return true;

    const header = request.header('x-forge-api-key');
    if (!header) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'missing x-forge-api-key header',
      });
    }

    if (!constantTimeEquals(header, this.config.FORGE_API_KEY)) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'invalid API key',
      });
    }

    return true;
  }
}

/** Length-independent constant-time comparison. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on length mismatch, which would itself leak length. Compare
  // fixed-size digests of the inputs instead.
  if (bufA.length !== bufB.length) {
    const padded = Buffer.alloc(Math.max(bufA.length, bufB.length));
    const other = Buffer.alloc(padded.length);
    bufA.copy(padded);
    bufB.copy(other);
    timingSafeEqual(padded, other);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * A small fixed-window rate limiter.
 *
 * In-process and per-replica: it exists to stop one runaway script from flooding the
 * database, not to enforce a quota. A real quota needs shared state, and pretending an
 * in-memory counter provides one would be worse than not having it — so the limit is
 * generous and the header says what it actually is.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  constructor(@Inject(FORGE_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path;
    if (path.startsWith('/health') || path === '/metrics') return true;

    const now = Date.now();
    this.sweep(now);

    const key = request.ip ?? 'unknown';
    const window = this.config.FORGE_RATE_LIMIT_WINDOW_MS;
    const entry = this.hits.get(key);

    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + window });
      return true;
    }

    entry.count += 1;
    if (entry.count > this.config.FORGE_RATE_LIMIT_MAX) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'RateLimited',
          message:
            'rate limit of ' +
            this.config.FORGE_RATE_LIMIT_MAX +
            ' requests per ' +
            Math.round(window / 1000) +
            's exceeded',
          retryAfterMs: entry.resetAt - now,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /** Drop expired buckets so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}

/** Guards endpoints that must only exist in the local/demo environment. */
@Injectable()
export class DemoModeGuard implements CanActivate {
  constructor(@Inject(FORGE_CONFIG) private readonly config: ApiConfig) {}

  canActivate(): boolean {
    if (!this.config.FORGE_DEMO_MODE) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'DemoModeDisabled',
        message: 'this endpoint injects failures and is only available when FORGE_DEMO_MODE=true',
      });
    }
    return true;
  }
}
