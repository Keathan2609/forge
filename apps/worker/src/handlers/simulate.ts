import { NonRetryableError, type HandlerDefinition, type TaskContext } from './registry';

/**
 * Failure-injection handlers.
 *
 * These exist so the recovery behaviour can be *demonstrated* rather than described:
 * pointing a node at `simulate.crash` and watching another worker pick the task up is a
 * much stronger claim than a paragraph asserting that leases work.
 *
 * Every handler here is `demoOnly`, so `FORGE_DEMO_MODE=false` (the default, and
 * enforced for `NODE_ENV=production`) means they are never registered and a definition
 * referencing them fails with `UNKNOWN_HANDLER`. A production worker cannot be talked
 * into killing itself by a submitted workflow.
 */

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const simulateFail: HandlerDefinition = {
  type: 'simulate.fail',
  description:
    'Always fails. Drives a node through its full retry budget into the dead-letter queue.',
  demoOnly: true,
  handler: async (input, ctx: TaskContext) => {
    const message = String(input.message ?? 'simulated failure');
    ctx.logger.warn({ attempt: ctx.attempt }, 'simulate.fail raising a failure');
    if (input.nonRetryable === true) {
      throw new NonRetryableError(message, String(input.code ?? 'SIMULATED_PERMANENT'));
    }
    const error = new Error(message);
    (error as Error & { code?: string }).code = String(input.code ?? 'SIMULATED_FAILURE');
    throw error;
  },
};

const simulateFlaky: HandlerDefinition = {
  type: 'simulate.flaky',
  description:
    'Fails until `succeedOnAttempt`, then succeeds. Produces a real, observable retry sequence.',
  demoOnly: true,
  handler: async (input, ctx: TaskContext) => {
    const succeedOnAttempt = Number(input.succeedOnAttempt ?? 3);
    const delayMs = Math.min(Number(input.durationMs ?? 100), 60_000);
    await sleep(delayMs, ctx.signal);

    if (ctx.attempt < succeedOnAttempt) {
      ctx.logger.warn(
        { attempt: ctx.attempt, succeedOnAttempt },
        'simulate.flaky failing this attempt',
      );
      const error = new Error(
        'transient failure on attempt ' + ctx.attempt + ' of ' + succeedOnAttempt,
      );
      (error as Error & { code?: string }).code = 'TRANSIENT';
      throw error;
    }
    return { recoveredOnAttempt: ctx.attempt, durationMs: delayMs };
  },
};

const simulateTimeout: HandlerDefinition = {
  type: 'simulate.timeout',
  description:
    'Sleeps past the node timeout. Exercises the timeout path and the abort signal contract.',
  demoOnly: true,
  handler: async (input, ctx: TaskContext) => {
    const durationMs = Math.min(Number(input.durationMs ?? 120_000), 600_000);
    ctx.logger.warn({ durationMs }, 'simulate.timeout sleeping past its budget');
    await sleep(durationMs, ctx.signal);
    // Reached only if the node's timeout is longer than `durationMs`.
    return { sleptMs: durationMs, timedOut: false };
  },
};

const simulateCrash: HandlerDefinition = {
  type: 'simulate.crash',
  description:
    'Kills this worker with SIGKILL on the configured attempt. The lease expires and another worker recovers the task.',
  demoOnly: true,
  handler: async (input, ctx: TaskContext) => {
    const afterMs = Math.min(Number(input.afterMs ?? 500), 60_000);
    // Crash up to and including this attempt, then succeed.
    //
    // Bounded deliberately: a handler that crashes on *every* attempt takes down each
    // worker that picks the task up in turn, and the demo becomes an unattended way to
    // destroy the fleet rather than a demonstration that the fleet survives. Recovery is
    // proven by one crash followed by a successful attempt elsewhere.
    const crashUntilAttempt = Math.max(0, Number(input.crashUntilAttempt ?? 1));

    if (ctx.attempt > crashUntilAttempt) {
      ctx.logger.info(
        { attempt: ctx.attempt },
        'simulate.crash — running on a recovered attempt, completing normally',
      );
      await sleep(afterMs, ctx.signal);
      return {
        recovered: true,
        completedOnAttempt: ctx.attempt,
        completedBy: ctx.workerId,
      };
    }

    ctx.logger.error(
      { workerId: ctx.workerId, taskRunId: ctx.taskRunId, attempt: ctx.attempt, afterMs },
      'simulate.crash — this worker will be killed to demonstrate lease recovery',
    );
    await sleep(afterMs, ctx.signal);

    // SIGKILL specifically: no shutdown hook, no lease release, no final heartbeat.
    // Anything gentler would let the worker tidy up and would not exercise the recovery
    // path at all — which is the whole point of this handler.
    process.kill(process.pid, 'SIGKILL');

    // Unreachable; present so the function is well-typed and the intent is explicit.
    await sleep(60_000, ctx.signal);
    return { crashed: true };
  },
};

const simulateSlow: HandlerDefinition = {
  type: 'simulate.slow',
  description: 'Runs longer than one lease TTL, exercising lease renewal on a genuinely long task.',
  demoOnly: true,
  handler: async (input, ctx: TaskContext) => {
    const durationMs = Math.min(Number(input.durationMs ?? 45_000), 600_000);
    const started = Date.now();
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      await sleep(durationMs / steps, ctx.signal);
      ctx.progress(Math.round((i / steps) * 100), 'still working');
      if (ctx.isCancelled()) {
        // Cooperative cancellation: stop cleanly rather than being killed mid-write.
        return { cancelled: true, elapsedMs: Date.now() - started };
      }
    }
    return { elapsedMs: Date.now() - started, renewalsExercised: true };
  },
};

export const SIMULATION_HANDLERS: HandlerDefinition[] = [
  simulateFail,
  simulateFlaky,
  simulateTimeout,
  simulateCrash,
  simulateSlow,
];
