import type { Logger } from '@forge/logger';

/**
 * A supervised polling loop.
 *
 * Every control-plane daemon is one of these. The behaviours that matter and are easy to
 * get wrong when each loop rolls its own:
 *
 *   - a throw never kills the loop; it backs off and continues
 *   - repeated failures back off exponentially instead of hammering a broken dependency
 *   - a loop that found work runs again immediately rather than sleeping through a burst
 *   - shutdown waits for the current iteration, so a SIGTERM never lands mid-transaction
 */

export interface LoopOptions {
  name: string;
  intervalMs: number;
  logger: Logger;
  /** Returns the number of items processed; > 0 skips the sleep before the next tick. */
  tick: () => Promise<number>;
  /** Ceiling for the error backoff. */
  maxBackoffMs?: number;
  /** Called once before the first tick. */
  onStart?: () => Promise<void>;
}

export class Loop {
  private running = false;
  private stopping = false;
  private consecutiveErrors = 0;
  private currentIteration: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;

  constructor(private readonly options: LoopOptions) {}

  get name(): string {
    return this.options.name;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    await this.options.onStart?.();
    this.options.logger.info(
      { loop: this.options.name, intervalMs: this.options.intervalMs },
      'loop started',
    );
    void this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const iteration = this.iterate();
      this.currentIteration = iteration.then(() => undefined);
      const processed = await iteration;
      this.currentIteration = null;
      if (this.stopping) break;
      // Work found means more may be waiting; drain before sleeping.
      if (processed > 0 && this.consecutiveErrors === 0) continue;
      await this.sleep(this.currentDelay());
    }
    this.running = false;
    this.options.logger.info({ loop: this.options.name }, 'loop stopped');
  }

  private async iterate(): Promise<number> {
    try {
      const processed = await this.options.tick();
      if (this.consecutiveErrors > 0) {
        this.options.logger.info(
          { loop: this.options.name, afterErrors: this.consecutiveErrors },
          'loop recovered',
        );
      }
      this.consecutiveErrors = 0;
      return processed;
    } catch (err) {
      this.consecutiveErrors += 1;
      this.options.logger.error(
        {
          loop: this.options.name,
          consecutiveErrors: this.consecutiveErrors,
          err: (err as Error).message,
          stack: (err as Error).stack?.split('\n').slice(0, 5).join('\n'),
        },
        'loop iteration failed',
      );
      return 0;
    }
  }

  private currentDelay(): number {
    if (this.consecutiveErrors === 0) return this.options.intervalMs;
    const max = this.options.maxBackoffMs ?? 30_000;
    const backoff = this.options.intervalMs * Math.pow(2, Math.min(this.consecutiveErrors, 8));
    // Jitter so several loops failing on the same dependency do not retry in lockstep.
    return Math.min(max, Math.round(backoff * (0.5 + Math.random() * 0.5)));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, ms);
      // `stop()` and `nudge()` resolve the sleep immediately instead of waiting it out.
      this.wakeUp = (): void => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }

  /** Skip the remaining sleep — used when a pub/sub notification says work has arrived. */
  nudge(): void {
    this.wakeUp?.();
  }

  /** Stop after the current iteration completes. Never interrupts a transaction. */
  async stop(): Promise<void> {
    if (!this.running && !this.currentIteration) return;
    this.stopping = true;
    this.wakeUp?.();
    if (this.currentIteration) {
      await this.currentIteration.catch(() => undefined);
    }
  }
}

/** Run several loops, and stop them all cleanly together. */
export class LoopSupervisor {
  private readonly loops: Loop[] = [];

  add(loop: Loop): Loop {
    this.loops.push(loop);
    return loop;
  }

  async startAll(): Promise<void> {
    for (const loop of this.loops) await loop.start();
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.loops.map((l) => l.stop()));
  }

  get(name: string): Loop | undefined {
    return this.loops.find((l) => l.name === name);
  }
}
