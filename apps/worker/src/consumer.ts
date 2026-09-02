import { QUEUES } from '@forge/contracts';
import type { Logger } from '@forge/logger';
import type { Transport } from '@forge/transport';
import type { TaskExecutor } from './executor';

/**
 * The consume loop.
 *
 * Concurrency is enforced by an explicit slot counter rather than by spawning a task per
 * message: a worker that advertises `concurrency: 4` must hold at most four leases, or
 * it will heartbeat more leases than it can actually service and start losing them under
 * load. The loop therefore only calls `BRPOP` when it has a free slot.
 *
 * `BRPOP` across several queue keys is served in the order the keys are given, so a
 * worker subscribed to `default,media` drains `default` first. That is a deliberate
 * priority, not an accident of the API.
 */

export interface ConsumerOptions {
  transport: Transport;
  executor: TaskExecutor;
  logger: Logger;
  queues: string[];
  concurrency: number;
  blockSeconds: number;
}

export class Consumer {
  private running = false;
  private stopping = false;
  private inFlight = 0;
  private readonly pending = new Set<Promise<void>>();
  private readonly queueKeys: string[];

  constructor(private readonly options: ConsumerOptions) {
    this.queueKeys = options.queues.map((q) => QUEUES.taskDispatch(q));
  }

  get activeCount(): number {
    return this.inFlight;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.options.logger.info(
      { queues: this.options.queues, concurrency: this.options.concurrency },
      'consumer started',
    );
    await this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      // Wait for a free slot before taking a message off the queue. Popping first and
      // queueing internally would hide work from every other worker in the fleet.
      if (this.inFlight >= this.options.concurrency) {
        await Promise.race(this.pending);
        continue;
      }

      let received;
      try {
        received = await this.options.transport.pop(this.queueKeys, this.options.blockSeconds);
      } catch (err) {
        if (this.stopping) break;
        // A Redis blip must not kill the worker: back off briefly and reconnect. The
        // durable state is untouched, and undelivered work is republished by the outbox.
        this.options.logger.warn(
          { err: (err as Error).message },
          'queue read failed; backing off before retry',
        );
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }

      if (!received) continue; // BRPOP timed out; loop round and check `stopping`.
      if (received.message.kind !== 'task.dispatch') continue;

      const message = received.message;
      this.inFlight += 1;

      const task: Promise<void> = this.options.executor
        .execute(message)
        .then(() => undefined)
        .catch((err: unknown) => {
          // The executor already reports handler failures through `failTask`. Reaching
          // here means the executor itself threw, which is a bug — log it loudly and let
          // the lease expire so the reaper recovers the task.
          this.options.logger.error(
            {
              taskRunId: message.taskRunId,
              nodeKey: message.nodeKey,
              err: (err as Error).message,
              stack: (err as Error).stack?.split('\n').slice(0, 8).join('\n'),
            },
            'executor threw; the lease will expire and the task will be recovered',
          );
        })
        .finally(() => {
          this.inFlight -= 1;
          this.pending.delete(task);
        });

      this.pending.add(task);
    }

    this.running = false;
  }

  /**
   * Stop accepting work and wait for in-flight tasks, up to `graceMs`.
   *
   * Draining matters: a worker killed with tasks in flight leaves leases that only
   * expire after the TTL, delaying those tasks by ~15s. Finishing them first turns a
   * rolling deploy into a non-event.
   */
  async stop(graceMs: number): Promise<{ drained: boolean; abandoned: number }> {
    this.stopping = true;
    if (this.pending.size === 0) return { drained: true, abandoned: 0 };

    this.options.logger.info(
      { inFlight: this.pending.size, graceMs },
      'draining in-flight tasks before shutdown',
    );

    const drained = await Promise.race([
      Promise.allSettled([...this.pending]).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);

    if (!drained) {
      // Out of time. Abort the handlers so they stop cleanly; the reaper reclaims
      // whatever was still running once the leases expire.
      this.options.executor.abortAll('worker shutting down');
      this.options.logger.warn(
        { abandoned: this.pending.size },
        'shutdown grace expired; remaining tasks will be recovered by the control plane',
      );
    }

    return { drained, abandoned: drained ? 0 : this.pending.size };
  }
}
