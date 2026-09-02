import type { RetryPolicy } from '@forge/contracts';

/**
 * Retry maths.
 *
 * Kept pure and injectable (`rng`) so the exponential curve and the jitter window can
 * both be asserted deterministically in tests, rather than "probably about right".
 */

export interface RetryDecision {
  shouldRetry: boolean;
  /** 1-based number of the attempt that would run next. */
  nextAttemptNumber: number;
  delayMs: number;
  /** Absolute time the next attempt becomes eligible. */
  nextAttemptAt: Date;
  reason: 'retry' | 'budget-exhausted' | 'non-retryable' | 'cancelled';
}

/**
 * Base delay before attempt `n` (n is 1-based; attempt 1 is the first try).
 *
 *   attempt 1 -> 0ms          (immediate)
 *   attempt 2 -> initialDelay
 *   attempt 3 -> initialDelay * multiplier
 *   attempt 4 -> initialDelay * multiplier^2   ... clamped to maxDelayMs
 */
export function baseDelayForAttempt(policy: RetryPolicy, attemptNumber: number): number {
  if (attemptNumber <= 1) return 0;
  const exponent = attemptNumber - 2;
  const raw = policy.initialDelayMs * Math.pow(policy.multiplier, exponent);
  if (!Number.isFinite(raw)) return policy.maxDelayMs;
  return Math.min(Math.round(raw), policy.maxDelayMs);
}

/**
 * Full jitter: uniform in [0, base].
 *
 * Chosen over "equal jitter" or a fixed +/-10% band because the dominant failure mode
 * here is a fan-out of N sibling tasks failing together against the same downstream
 * dependency; full jitter spreads their retries across the whole window instead of
 * re-synchronising them into a second thundering herd.
 */
export function applyJitter(baseMs: number, rng: () => number = Math.random): number {
  if (baseMs <= 0) return 0;
  return Math.round(rng() * baseMs);
}

export function computeBackoff(
  policy: RetryPolicy,
  attemptNumber: number,
  rng: () => number = Math.random,
): number {
  const base = baseDelayForAttempt(policy, attemptNumber);
  return policy.jitter ? applyJitter(base, rng) : base;
}

export interface RetryContext {
  policy: RetryPolicy;
  /** How many attempts have already completed (including the one that just failed). */
  attemptsUsed: number;
  errorCode?: string | null;
  cancelled?: boolean;
  now?: Date;
  rng?: () => number;
}

/**
 * Decide what happens after a failed attempt.
 *
 * Note that lease-expiry recovery does *not* route through here — an abandoned attempt
 * is a transport/infrastructure failure, not an application failure, and consuming the
 * application's retry budget for a worker crash would make the budget mean two
 * different things. See `docs/adr/004-worker-leases.md`.
 */
export function decideRetry(ctx: RetryContext): RetryDecision {
  const now = ctx.now ?? new Date();
  const nextAttemptNumber = ctx.attemptsUsed + 1;

  if (ctx.cancelled) {
    return {
      shouldRetry: false,
      nextAttemptNumber,
      delayMs: 0,
      nextAttemptAt: now,
      reason: 'cancelled',
    };
  }

  if (ctx.errorCode && ctx.policy.nonRetryableErrors.includes(ctx.errorCode)) {
    return {
      shouldRetry: false,
      nextAttemptNumber,
      delayMs: 0,
      nextAttemptAt: now,
      reason: 'non-retryable',
    };
  }

  if (ctx.attemptsUsed >= ctx.policy.maxAttempts) {
    return {
      shouldRetry: false,
      nextAttemptNumber,
      delayMs: 0,
      nextAttemptAt: now,
      reason: 'budget-exhausted',
    };
  }

  const delayMs = computeBackoff(ctx.policy, nextAttemptNumber, ctx.rng);
  return {
    shouldRetry: true,
    nextAttemptNumber,
    delayMs,
    nextAttemptAt: new Date(now.getTime() + delayMs),
    reason: 'retry',
  };
}

/** The full un-jittered schedule, used by the console to explain a node's retry policy. */
export function retryScheduleSummary(
  policy: RetryPolicy,
): Array<{ attempt: number; delayMs: number }> {
  const out: Array<{ attempt: number; delayMs: number }> = [];
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    out.push({ attempt, delayMs: baseDelayForAttempt(policy, attempt) });
  }
  return out;
}
