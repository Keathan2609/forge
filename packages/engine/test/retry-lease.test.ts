import { describe, expect, it } from 'vitest';
import { retryPolicy, seededRandom } from '@forge/testing';
import {
  DEFAULT_LEASE_CONFIG,
  LeaseConfigError,
  applyJitter,
  assertValidLeaseConfig,
  baseDelayForAttempt,
  computeBackoff,
  decideRetry,
  effectiveDeadline,
  isLeaseReclaimable,
  isLeaseValid,
  leaseRemainingMs,
  nextExpiry,
  retryScheduleSummary,
  shouldRenew,
  type LeaseState,
} from '../src';

describe('exponential backoff', () => {
  const policy = retryPolicy({ initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 60_000 });

  it('makes the first attempt immediate', () => {
    expect(baseDelayForAttempt(policy, 1)).toBe(0);
  });

  it('doubles on each subsequent attempt', () => {
    expect(baseDelayForAttempt(policy, 2)).toBe(1_000);
    expect(baseDelayForAttempt(policy, 3)).toBe(2_000);
    expect(baseDelayForAttempt(policy, 4)).toBe(4_000);
    expect(baseDelayForAttempt(policy, 5)).toBe(8_000);
  });

  it('clamps at maxDelayMs', () => {
    expect(baseDelayForAttempt(policy, 20)).toBe(60_000);
    expect(baseDelayForAttempt(policy, 100)).toBe(60_000);
  });

  it('supports a multiplier of 1 as a fixed delay', () => {
    const fixed = retryPolicy({ initialDelayMs: 500, multiplier: 1 });
    expect(baseDelayForAttempt(fixed, 2)).toBe(500);
    expect(baseDelayForAttempt(fixed, 6)).toBe(500);
  });

  it('produces the documented schedule', () => {
    const summary = retryScheduleSummary(retryPolicy({ maxAttempts: 4 }));
    expect(summary).toEqual([
      { attempt: 1, delayMs: 0 },
      { attempt: 2, delayMs: 1_000 },
      { attempt: 3, delayMs: 2_000 },
      { attempt: 4, delayMs: 4_000 },
    ]);
  });
});

describe('jitter', () => {
  it('stays inside [0, base]', () => {
    const rng = seededRandom(42);
    for (let i = 0; i < 200; i++) {
      const jittered = applyJitter(4_000, rng);
      expect(jittered).toBeGreaterThanOrEqual(0);
      expect(jittered).toBeLessThanOrEqual(4_000);
    }
  });

  it('is deterministic for a fixed seed', () => {
    expect(applyJitter(1_000, seededRandom(7))).toBe(applyJitter(1_000, seededRandom(7)));
  });

  it('actually spreads sibling retries apart', () => {
    // The point of full jitter: 20 tasks failing together must not retry in lockstep.
    const rng = seededRandom(99);
    const delays = new Set(Array.from({ length: 20 }, () => applyJitter(8_000, rng)));
    expect(delays.size).toBeGreaterThan(10);
  });

  it('is skipped when the policy disables it', () => {
    const noJitter = retryPolicy({ jitter: false });
    expect(computeBackoff(noJitter, 3, seededRandom(1))).toBe(2_000);
  });
});

describe('decideRetry', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('retries while budget remains', () => {
    const d = decideRetry({
      policy: retryPolicy({ maxAttempts: 3, jitter: false }),
      attemptsUsed: 1,
      now,
    });
    expect(d.shouldRetry).toBe(true);
    expect(d.nextAttemptNumber).toBe(2);
    expect(d.delayMs).toBe(1_000);
    expect(d.nextAttemptAt.toISOString()).toBe('2026-01-01T00:00:01.000Z');
  });

  it('stops once the budget is exhausted', () => {
    const d = decideRetry({ policy: retryPolicy({ maxAttempts: 3 }), attemptsUsed: 3, now });
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toBe('budget-exhausted');
  });

  it('never retries when maxAttempts is 1', () => {
    const d = decideRetry({ policy: retryPolicy({ maxAttempts: 1 }), attemptsUsed: 1, now });
    expect(d.shouldRetry).toBe(false);
  });

  it('bypasses the budget for a non-retryable error code', () => {
    const d = decideRetry({
      policy: retryPolicy({ maxAttempts: 5, nonRetryableErrors: ['VALIDATION_FAILED'] }),
      attemptsUsed: 1,
      errorCode: 'VALIDATION_FAILED',
      now,
    });
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toBe('non-retryable');
  });

  it('still retries an unrelated error code', () => {
    const d = decideRetry({
      policy: retryPolicy({ maxAttempts: 5, nonRetryableErrors: ['VALIDATION_FAILED'] }),
      attemptsUsed: 1,
      errorCode: 'TIMEOUT',
      now,
    });
    expect(d.shouldRetry).toBe(true);
  });

  it('does not retry a cancelled task', () => {
    const d = decideRetry({
      policy: retryPolicy({ maxAttempts: 5 }),
      attemptsUsed: 1,
      cancelled: true,
      now,
    });
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toBe('cancelled');
  });
});

describe('lease configuration', () => {
  it('accepts the default', () => {
    expect(() => assertValidLeaseConfig(DEFAULT_LEASE_CONFIG)).not.toThrow();
  });

  it('rejects a heartbeat interval too close to the TTL', () => {
    // A worker must be able to miss two heartbeats without losing its task.
    expect(() =>
      assertValidLeaseConfig({ ttlMs: 5_000, heartbeatIntervalMs: 4_000, reclaimGraceMs: 0 }),
    ).toThrow(LeaseConfigError);
  });

  it('rejects non-positive values', () => {
    expect(() =>
      assertValidLeaseConfig({ ttlMs: 0, heartbeatIntervalMs: 1_000, reclaimGraceMs: 0 }),
    ).toThrow(LeaseConfigError);
  });
});

describe('lease lifecycle', () => {
  const base = new Date('2026-01-01T00:00:00.000Z');
  const lease = (overrides: Partial<LeaseState> = {}): LeaseState => ({
    taskRunId: 't1',
    workerId: 'w1',
    attemptNumber: 1,
    acquiredAt: base,
    expiresAt: new Date(base.getTime() + 15_000),
    heartbeatAt: base,
    releasedAt: null,
    ...overrides,
  });

  it('is valid before expiry', () => {
    expect(isLeaseValid(lease(), new Date(base.getTime() + 10_000))).toBe(true);
  });

  it('is invalid after expiry', () => {
    expect(isLeaseValid(lease(), new Date(base.getTime() + 16_000))).toBe(false);
  });

  it('is invalid once released, even before expiry', () => {
    expect(isLeaseValid(lease({ releasedAt: base }), new Date(base.getTime() + 1_000))).toBe(false);
  });

  it('is not reclaimable during the grace period', () => {
    // Clock skew between a worker and the control plane must not cause a steal.
    const justExpired = new Date(base.getTime() + 16_000);
    expect(isLeaseReclaimable(lease(), justExpired, DEFAULT_LEASE_CONFIG)).toBe(false);
  });

  it('is reclaimable once the grace period has passed', () => {
    const wellExpired = new Date(base.getTime() + 15_000 + 3_001);
    expect(isLeaseReclaimable(lease(), wellExpired, DEFAULT_LEASE_CONFIG)).toBe(true);
  });

  it('is never reclaimable once released', () => {
    const wellExpired = new Date(base.getTime() + 60_000);
    expect(isLeaseReclaimable(lease({ releasedAt: base }), wellExpired, DEFAULT_LEASE_CONFIG)).toBe(
      false,
    );
  });

  it('reports remaining time, negative once expired', () => {
    expect(leaseRemainingMs(lease(), base)).toBe(15_000);
    expect(leaseRemainingMs(lease(), new Date(base.getTime() + 20_000))).toBe(-5_000);
  });

  it('renews at the halfway point', () => {
    expect(shouldRenew(lease(), new Date(base.getTime() + 7_000), DEFAULT_LEASE_CONFIG)).toBe(
      false,
    );
    expect(shouldRenew(lease(), new Date(base.getTime() + 8_000), DEFAULT_LEASE_CONFIG)).toBe(true);
  });

  it('extends expiry from the renewal time', () => {
    const at = new Date(base.getTime() + 8_000);
    expect(nextExpiry(at, DEFAULT_LEASE_CONFIG).toISOString()).toBe('2026-01-01T00:00:23.000Z');
  });
});

describe('effectiveDeadline', () => {
  const start = new Date('2026-01-01T00:00:00.000Z');

  it('uses the task timeout when there is no lease', () => {
    expect(effectiveDeadline(start, 30_000, null).toISOString()).toBe('2026-01-01T00:00:30.000Z');
  });

  it('uses whichever of lease and timeout expires first', () => {
    const shortLease: LeaseState = {
      taskRunId: 't',
      workerId: 'w',
      attemptNumber: 1,
      acquiredAt: start,
      expiresAt: new Date(start.getTime() + 10_000),
      heartbeatAt: start,
      releasedAt: null,
    };
    // A worker must never keep computing past the point where it can commit a result.
    expect(effectiveDeadline(start, 30_000, shortLease).toISOString()).toBe(
      '2026-01-01T00:00:10.000Z',
    );
    expect(effectiveDeadline(start, 5_000, shortLease).toISOString()).toBe(
      '2026-01-01T00:00:05.000Z',
    );
  });
});
