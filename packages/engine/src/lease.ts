/**
 * Lease arithmetic.
 *
 * A lease is a time-bounded claim by one worker on one task attempt. It is the
 * mechanism that turns "a worker vanished" from an unrecoverable stuck RUNNING row into
 * an ordinary, automatically-handled event.
 *
 * The rules, deliberately conservative:
 *   - A lease is valid while `now < expiresAt`.
 *   - The holder renews on a heartbeat interval that is a small fraction of the TTL, so
 *     a few dropped heartbeats do not cost it the lease.
 *   - Only the holder may complete the attempt, and completion re-checks ownership
 *     inside the same transaction. A worker that pauses past its expiry and wakes up
 *     will find its claim gone and must discard its result.
 *   - The reaper only reclaims leases that are expired by a full grace period, so clock
 *     skew between the worker and the control plane cannot cause a spurious steal.
 */

export interface LeaseState {
  taskRunId: string;
  workerId: string;
  attemptNumber: number;
  acquiredAt: Date;
  expiresAt: Date;
  heartbeatAt: Date;
  releasedAt: Date | null;
}

export interface LeaseConfig {
  /** How long a lease survives without a heartbeat. */
  ttlMs: number;
  /** How often the holder renews. Must be well under `ttlMs`. */
  heartbeatIntervalMs: number;
  /** Extra slack before the reaper will steal an expired lease. */
  reclaimGraceMs: number;
}

export const DEFAULT_LEASE_CONFIG: LeaseConfig = {
  ttlMs: 15_000,
  heartbeatIntervalMs: 2_000,
  reclaimGraceMs: 3_000,
};

export class LeaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseConfigError';
  }
}

/**
 * A misconfigured lease is a silent data-integrity bug — a heartbeat interval longer
 * than the TTL means every healthy worker loses its task mid-flight — so the config is
 * validated at process start rather than discovered in production.
 */
export function assertValidLeaseConfig(config: LeaseConfig): void {
  if (config.ttlMs <= 0) throw new LeaseConfigError('lease ttlMs must be positive');
  if (config.heartbeatIntervalMs <= 0) {
    throw new LeaseConfigError('heartbeatIntervalMs must be positive');
  }
  // Three heartbeats inside one TTL means two can be lost without consequence.
  if (config.heartbeatIntervalMs * 3 > config.ttlMs) {
    throw new LeaseConfigError(
      'heartbeatIntervalMs (' +
        config.heartbeatIntervalMs +
        'ms) must be at most one third of ttlMs (' +
        config.ttlMs +
        'ms) so a worker can miss two heartbeats without losing its lease',
    );
  }
  if (config.reclaimGraceMs < 0) throw new LeaseConfigError('reclaimGraceMs must be >= 0');
}

export function nextExpiry(now: Date, config: LeaseConfig): Date {
  return new Date(now.getTime() + config.ttlMs);
}

export function isLeaseValid(lease: LeaseState, now: Date): boolean {
  if (lease.releasedAt !== null) return false;
  return lease.expiresAt.getTime() > now.getTime();
}

/** Reclaimable = expired, unreleased, and past the grace period. */
export function isLeaseReclaimable(lease: LeaseState, now: Date, config: LeaseConfig): boolean {
  if (lease.releasedAt !== null) return false;
  return now.getTime() > lease.expiresAt.getTime() + config.reclaimGraceMs;
}

/** Milliseconds until the lease expires; negative once it has. */
export function leaseRemainingMs(lease: LeaseState, now: Date): number {
  return lease.expiresAt.getTime() - now.getTime();
}

/**
 * Should the holder renew now?
 *
 * Renewing at half the remaining TTL rather than on a fixed schedule means a worker
 * that was descheduled for a while renews immediately on waking instead of waiting out
 * the rest of its interval.
 */
export function shouldRenew(lease: LeaseState, now: Date, config: LeaseConfig): boolean {
  return leaseRemainingMs(lease, now) <= config.ttlMs / 2;
}

/**
 * Wall-clock budget left for the current attempt: the smaller of the task timeout and
 * the lease. A worker stops at whichever comes first, so it can never keep running work
 * whose result it is no longer allowed to commit.
 */
export function effectiveDeadline(
  startedAt: Date,
  timeoutMs: number,
  lease: LeaseState | null,
): Date {
  const timeoutDeadline = new Date(startedAt.getTime() + timeoutMs);
  if (!lease) return timeoutDeadline;
  return lease.expiresAt < timeoutDeadline ? lease.expiresAt : timeoutDeadline;
}
