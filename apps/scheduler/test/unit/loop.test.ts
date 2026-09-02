import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '@forge/logger';
import { Loop, LoopSupervisor } from '../../src/loop';

/**
 * The supervised polling loop.
 *
 * Every control-plane daemon is one of these, so its failure behaviour *is* the control
 * plane's failure behaviour: a loop that dies on one bad tick takes dispatching with it,
 * and one that hammers a broken dependency turns a blip into an outage.
 */

const logger = createSilentLogger();

/** Wait for a condition without coupling the test to a fixed sleep. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met within ' + timeoutMs + 'ms');
}

describe('Loop', () => {
  it('runs its tick repeatedly', async () => {
    let ticks = 0;
    const loop = new Loop({
      name: 'counter',
      intervalMs: 5,
      logger,
      tick: async () => {
        ticks += 1;
        return 0;
      },
    });

    await loop.start();
    await until(() => ticks >= 3);
    await loop.stop();

    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  it('keeps running after a tick throws', async () => {
    // A single bad tick must not take the loop down — otherwise one malformed row stops
    // the control plane until somebody notices.
    let ticks = 0;
    const loop = new Loop({
      name: 'flaky',
      intervalMs: 5,
      logger,
      tick: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error('boom');
        return 0;
      },
    });

    await loop.start();
    await until(() => ticks >= 3);
    await loop.stop();

    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  it('backs off as failures accumulate', async () => {
    // Hammering a dependency that is already failing makes the incident worse.
    const timestamps: number[] = [];
    const loop = new Loop({
      name: 'always-fails',
      intervalMs: 10,
      maxBackoffMs: 400,
      logger,
      tick: async () => {
        timestamps.push(Date.now());
        throw new Error('still broken');
      },
    });

    await loop.start();
    await until(() => timestamps.length >= 4, 4_000);
    await loop.stop();

    const gaps = timestamps.slice(1).map((t, i) => t - (timestamps[i] as number));
    // The later gaps must be meaningfully larger than the first.
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0] as number);
  });

  it('drains without sleeping while a tick reports work', async () => {
    // A burst of queued work should be consumed promptly rather than one item per tick.
    let remaining = 5;
    const started = Date.now();
    const loop = new Loop({
      name: 'drainer',
      intervalMs: 1_000,
      logger,
      tick: async () => {
        if (remaining === 0) return 0;
        remaining -= 1;
        return 1;
      },
    });

    await loop.start();
    await until(() => remaining === 0, 2_000);
    await loop.stop();

    // Five items with a 1s interval would take 5s if it slept between them.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('waits for the in-flight tick before stopping', async () => {
    // Loops hold open transactions; stopping mid-tick would abort one.
    let finished = false;
    const loop = new Loop({
      name: 'slow-tick',
      intervalMs: 5,
      logger,
      tick: async () => {
        await new Promise((r) => setTimeout(r, 120));
        finished = true;
        return 0;
      },
    });

    await loop.start();
    await new Promise((r) => setTimeout(r, 20));
    await loop.stop();

    expect(finished).toBe(true);
  });

  it('wakes early when nudged', async () => {
    let ticks = 0;
    const loop = new Loop({
      name: 'nudgeable',
      intervalMs: 10_000,
      logger,
      tick: async () => {
        ticks += 1;
        return 0;
      },
    });

    await loop.start();
    await until(() => ticks >= 1);

    loop.nudge();
    await until(() => ticks >= 2, 1_000);
    await loop.stop();

    expect(ticks).toBeGreaterThanOrEqual(2);
  });

  it('calls onStart before the first tick', async () => {
    const order: string[] = [];
    const loop = new Loop({
      name: 'ordered',
      intervalMs: 5,
      logger,
      onStart: async () => {
        order.push('start');
      },
      tick: async () => {
        order.push('tick');
        return 0;
      },
    });

    await loop.start();
    await until(() => order.includes('tick'));
    await loop.stop();

    expect(order[0]).toBe('start');
  });

  it('is idempotent to start twice', async () => {
    let ticks = 0;
    const loop = new Loop({
      name: 'once',
      intervalMs: 20,
      logger,
      tick: async () => {
        ticks += 1;
        return 0;
      },
    });

    await loop.start();
    await loop.start();
    await until(() => ticks >= 2);
    const after = ticks;
    await new Promise((r) => setTimeout(r, 60));
    await loop.stop();

    // Two concurrent runners would roughly double the rate.
    expect(ticks - after).toBeLessThan(10);
  });

  it('stopping an unstarted loop is safe', async () => {
    const loop = new Loop({ name: 'never', intervalMs: 10, logger, tick: async () => 0 });
    await expect(loop.stop()).resolves.toBeUndefined();
  });
});

describe('LoopSupervisor', () => {
  it('starts and stops every loop', async () => {
    const ticks = { a: 0, b: 0 };
    const supervisor = new LoopSupervisor();

    supervisor.add(
      new Loop({
        name: 'a',
        intervalMs: 5,
        logger,
        tick: async () => {
          ticks.a += 1;
          return 0;
        },
      }),
    );
    supervisor.add(
      new Loop({
        name: 'b',
        intervalMs: 5,
        logger,
        tick: async () => {
          ticks.b += 1;
          return 0;
        },
      }),
    );

    await supervisor.startAll();
    await until(() => ticks.a >= 2 && ticks.b >= 2);
    await supervisor.stopAll();

    const snapshot = { ...ticks };
    await new Promise((r) => setTimeout(r, 60));
    expect(ticks).toEqual(snapshot);
  });

  it('finds a loop by name', () => {
    const supervisor = new LoopSupervisor();
    const loop = new Loop({ name: 'reaper', intervalMs: 10, logger, tick: async () => 0 });
    supervisor.add(loop);

    expect(supervisor.get('reaper')).toBe(loop);
    expect(supervisor.get('nope')).toBeUndefined();
  });

  it('stops every loop even if one is slow', async () => {
    const supervisor = new LoopSupervisor();
    supervisor.add(
      new Loop({
        name: 'slow',
        intervalMs: 5,
        logger,
        tick: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return 0;
        },
      }),
    );
    supervisor.add(new Loop({ name: 'fast', intervalMs: 5, logger, tick: async () => 0 }));

    await supervisor.startAll();
    await new Promise((r) => setTimeout(r, 20));

    const stopped = vi.fn();
    await supervisor.stopAll().then(stopped);
    expect(stopped).toHaveBeenCalled();
  });
});
