import { WorkerState } from '@forge/contracts';
import type { PrismaClient } from '../client';

/**
 * Worker registration and liveness.
 *
 * A worker's row is its public identity: what it can run, what it is running, and when
 * it was last heard from. Liveness is derived from `lastHeartbeatAt` rather than stored,
 * so a worker that dies without a chance to update its own state still shows up
 * correctly — the fleet view never depends on a dead process being polite.
 */

export interface RegisterWorkerInput {
  id: string;
  name: string;
  hostname: string;
  pid: number;
  version: string;
  queues: string[];
  capabilities: string[];
  concurrency: number;
}

/**
 * Register or re-register. Upsert rather than insert: a worker that restarts with the
 * same id (a Kubernetes pod keeping its identity across a crash loop) resumes its row
 * instead of colliding with it.
 */
export async function registerWorker(
  prisma: PrismaClient,
  input: RegisterWorkerInput,
): Promise<void> {
  const now = new Date();
  await prisma.worker.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      name: input.name,
      hostname: input.hostname,
      pid: input.pid,
      version: input.version,
      queues: input.queues,
      capabilities: input.capabilities,
      concurrency: input.concurrency,
      state: WorkerState.ONLINE,
      registeredAt: now,
      lastHeartbeatAt: now,
    },
    update: {
      name: input.name,
      hostname: input.hostname,
      pid: input.pid,
      version: input.version,
      queues: input.queues,
      capabilities: input.capabilities,
      concurrency: input.concurrency,
      state: WorkerState.ONLINE,
      lastHeartbeatAt: now,
      shutdownAt: null,
      // A restarted process holds nothing; the reaper reclaims whatever it was running.
      activeTasks: 0,
    },
  });
}

export async function heartbeatWorker(
  prisma: PrismaClient,
  workerId: string,
  activeTasks?: number,
): Promise<void> {
  await prisma.worker.updateMany({
    where: { id: workerId },
    data: {
      lastHeartbeatAt: new Date(),
      ...(activeTasks === undefined ? {} : { activeTasks }),
      // A worker that heartbeats after being marked unresponsive comes back online.
      state: WorkerState.ONLINE,
    },
  });
}

export async function markWorkerDraining(prisma: PrismaClient, workerId: string): Promise<void> {
  await prisma.worker.updateMany({
    where: { id: workerId },
    data: { state: WorkerState.DRAINING, lastHeartbeatAt: new Date() },
  });
}

export async function markWorkerOffline(prisma: PrismaClient, workerId: string): Promise<void> {
  await prisma.worker.updateMany({
    where: { id: workerId },
    data: { state: WorkerState.OFFLINE, shutdownAt: new Date(), activeTasks: 0 },
  });
}

/**
 * Flag workers that have stopped heartbeating.
 *
 * Purely cosmetic — task recovery is driven by lease expiry, not by this sweep. Marking
 * a worker UNRESPONSIVE does not touch its tasks, so a network blip that delays
 * heartbeats cannot itself cause work to be re-run.
 */
export async function markUnresponsiveWorkers(
  prisma: PrismaClient,
  livenessMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - livenessMs);
  const result = await prisma.worker.updateMany({
    where: { state: WorkerState.ONLINE, lastHeartbeatAt: { lt: cutoff } },
    data: { state: WorkerState.UNRESPONSIVE },
  });
  return result.count;
}

/** Remove workers that have been silent for a long time, to keep the fleet view clean. */
export async function pruneDeadWorkers(prisma: PrismaClient, olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await prisma.worker.deleteMany({
    where: {
      lastHeartbeatAt: { lt: cutoff },
      state: { in: [WorkerState.OFFLINE, WorkerState.UNRESPONSIVE] },
      // Never delete a worker still holding an unreleased lease: the reaper needs the
      // row to attribute the recovery.
      leases: { none: { releasedAt: null } },
    },
  });
  return result.count;
}

export interface FleetSummary {
  online: number;
  unresponsive: number;
  offline: number;
  totalCapacity: number;
  activeTasks: number;
}

export async function fleetSummary(prisma: PrismaClient): Promise<FleetSummary> {
  const rows = await prisma.worker.groupBy({
    by: ['state'],
    _count: { _all: true },
    _sum: { concurrency: true, activeTasks: true },
  });

  const summary: FleetSummary = {
    online: 0,
    unresponsive: 0,
    offline: 0,
    totalCapacity: 0,
    activeTasks: 0,
  };

  for (const row of rows) {
    const count = row._count._all;
    if (row.state === WorkerState.ONLINE) {
      summary.online += count;
      summary.totalCapacity += row._sum.concurrency ?? 0;
      summary.activeTasks += row._sum.activeTasks ?? 0;
    } else if (row.state === WorkerState.DRAINING) {
      summary.online += count;
      summary.activeTasks += row._sum.activeTasks ?? 0;
    } else if (row.state === WorkerState.UNRESPONSIVE) {
      summary.unresponsive += count;
    } else {
      summary.offline += count;
    }
  }

  return summary;
}
