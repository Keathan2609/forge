import { Redis, type RedisOptions } from 'ioredis';
import {
  CHANNELS,
  KEYS,
  QUEUES,
  QueueMessageSchema,
  type ExecutionEvent,
  type QueueMessage,
  type TaskDispatchMessage,
} from '@forge/contracts';
import type { Logger } from '@forge/logger';

/**
 * Redis transport.
 *
 * Redis moves messages and fans out events. It is never consulted to answer "what state
 * is this run in" — that is always PostgreSQL. The practical consequence is that FORGE
 * survives `FLUSHALL`: every consumer re-reads the database before acting, the outbox
 * republishes anything undelivered, and the sweepers pick up whatever the lost messages
 * would have triggered. Latency suffers; correctness does not.
 */

export interface TransportOptions {
  url: string;
  logger?: Logger;
  /** Prefix every key, so several environments can share one Redis instance. */
  keyPrefix?: string;
}

function redisOptions(logger?: Logger): RedisOptions {
  return {
    // Fail fast rather than queueing commands forever behind a dead connection: a
    // consumer that cannot reach Redis should surface as unhealthy, not as "slow".
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 5_000,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 200, 5_000);
      logger?.warn({ attempt: times, delayMs: delay }, 'redis connection retry');
      return delay;
    },
  };
}

export class Transport {
  /** Commands. Never used for blocking reads. */
  readonly redis: Redis;
  private subscriber: Redis | null = null;
  private blockingClient: Redis | null = null;
  private readonly logger: Logger | undefined;
  private readonly url: string;
  private closed = false;
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();

  constructor(options: TransportOptions) {
    this.url = options.url;
    this.logger = options.logger;
    this.redis = new Redis(options.url, {
      ...redisOptions(options.logger),
      ...(options.keyPrefix ? { keyPrefix: options.keyPrefix } : {}),
    });
    this.redis.on('error', (err) => {
      this.logger?.error({ err: err.message }, 'redis command client error');
    });
  }

  /**
   * A dedicated connection for blocking reads.
   *
   * `BRPOP` occupies its connection for the whole timeout, so sharing one with ordinary
   * commands would stall every heartbeat and metric write behind it.
   */
  private blocking(): Redis {
    if (!this.blockingClient) {
      this.blockingClient = new Redis(this.url, redisOptions(this.logger));
      this.blockingClient.on('error', (err) => {
        this.logger?.error({ err: err.message }, 'redis blocking client error');
      });
    }
    return this.blockingClient;
  }

  /** A connection in subscriber mode, which cannot issue ordinary commands. */
  private subscriberClient(): Redis {
    if (!this.subscriber) {
      this.subscriber = new Redis(this.url, redisOptions(this.logger));
      this.subscriber.on('error', (err) => {
        this.logger?.error({ err: err.message }, 'redis subscriber error');
      });
      this.subscriber.on('message', (channel: string, message: string) => {
        for (const handler of this.handlers.get(channel) ?? []) {
          try {
            handler(message);
          } catch (err) {
            this.logger?.error(
              { channel, err: (err as Error).message },
              'subscriber handler threw',
            );
          }
        }
      });
    }
    return this.subscriber;
  }

  // -------------------------------------------------------------------------
  // Queues
  // -------------------------------------------------------------------------

  /** Push a message. `LPUSH` + `BRPOP` gives FIFO ordering. */
  async push(queue: string, message: QueueMessage): Promise<number> {
    return this.redis.lpush(queue, JSON.stringify(message));
  }

  async pushMany(queue: string, messages: QueueMessage[]): Promise<number> {
    if (messages.length === 0) return 0;
    return this.redis.lpush(queue, ...messages.map((m) => JSON.stringify(m)));
  }

  /**
   * Block until a message arrives on any of `queues`, or `timeoutSeconds` elapses.
   *
   * A malformed message is dropped with a log line rather than throwing: it is already
   * off the queue, the durable state is untouched, and crashing the consumer over one
   * bad payload would take the whole pool down.
   */
  async pop(
    queues: string[],
    timeoutSeconds: number,
  ): Promise<{ queue: string; message: QueueMessage } | null> {
    const result = await this.blocking().brpop(...queues, timeoutSeconds);
    if (!result) return null;
    const [queue, raw] = result;
    try {
      const parsed = QueueMessageSchema.parse(JSON.parse(raw));
      return { queue, message: parsed };
    } catch (err) {
      this.logger?.warn(
        { queue, err: (err as Error).message, raw: raw.slice(0, 200) },
        'discarding malformed queue message',
      );
      return null;
    }
  }

  async queueLength(queue: string): Promise<number> {
    return this.redis.llen(queue);
  }

  async queueLengths(queues: string[]): Promise<Record<string, number>> {
    if (queues.length === 0) return {};
    const pipeline = this.redis.pipeline();
    for (const q of queues) pipeline.llen(q);
    const results = await pipeline.exec();
    const out: Record<string, number> = {};
    queues.forEach((q, i) => {
      out[q] = (results?.[i]?.[1] as number) ?? 0;
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // Pub/sub
  // -------------------------------------------------------------------------

  /**
   * Broadcast an execution event.
   *
   * Best effort by design: the durable record is `execution_event`, and a client that
   * misses a broadcast recovers by asking the API for everything after its last
   * sequence number. Publishing is therefore fire-and-forget and never blocks a
   * transaction.
   */
  async publishEvent(event: ExecutionEvent): Promise<void> {
    const payload = JSON.stringify(event);
    await Promise.all([
      this.redis.publish(CHANNELS.eventsAll, payload),
      this.redis.publish(CHANNELS.eventsForRun(event.workflowRunId), payload),
    ]).catch((err: Error) => {
      this.logger?.warn({ err: err.message }, 'event broadcast failed (non-fatal)');
    });
  }

  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    const client = this.subscriberClient();
    let handlers = this.handlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(channel, handlers);
      await client.subscribe(channel);
    }
    handlers.add(handler);

    return (): void => {
      const set = this.handlers.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(channel);
        void client.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  // -------------------------------------------------------------------------
  // Coordination
  // -------------------------------------------------------------------------

  /**
   * Best-effort mutual exclusion.
   *
   * Used only to *reduce duplicate work* — for example stopping three control-plane
   * replicas from all recomputing the same advance. It is never the mechanism that keeps
   * state correct; that is the run row lock in PostgreSQL. A lock lost to a Redis
   * failover therefore costs a wasted computation, not a corrupted run.
   */
  async tryLock(key: string, ttlMs: number): Promise<string | null> {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  /** Release a lock only if we still hold it, so a slow holder cannot free someone else's. */
  async releaseLock(key: string, token: string): Promise<boolean> {
    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
    `;
    const result = (await this.redis.eval(script, 1, key, token)) as number;
    return result === 1;
  }

  /** Cancellation flag, mirrored from PostgreSQL so a running worker can poll cheaply. */
  async setCancelFlag(runId: string, ttlSeconds = 3600): Promise<void> {
    await this.redis.set(KEYS.cancelFlag(runId), '1', 'EX', ttlSeconds);
  }

  async isCancelled(runId: string): Promise<boolean> {
    return (await this.redis.exists(KEYS.cancelFlag(runId))) === 1;
  }

  async ping(): Promise<number> {
    const started = Date.now();
    await this.redis.ping();
    return Date.now() - started;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([
      this.redis.quit(),
      this.subscriber?.quit(),
      this.blockingClient?.quit(),
    ]);
  }
}

export { CHANNELS, KEYS, QUEUES };
export type { QueueMessage, TaskDispatchMessage };
