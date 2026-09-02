import { Prisma, PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient };
export type * from '@prisma/client';

/**
 * Prisma client factory and transaction helpers.
 *
 * Every process creates exactly one client. In development the instance is cached on
 * `globalThis` so `tsx watch` reloads do not open a new pool on every file save — a
 * surprisingly effective way to exhaust `max_connections` in an afternoon.
 */

export type Tx = Prisma.TransactionClient;

export interface CreateClientOptions {
  databaseUrl?: string;
  /** Emits every statement at debug level. Off by default: it is very loud. */
  logQueries?: boolean;
}

/**
 * Cached per connection string, not globally.
 *
 * Keying on the URL matters as soon as one process talks to two databases — the
 * integration suite does exactly that, checking service availability against the test
 * database while a dev client may already exist. A single global slot would silently
 * hand back a client pointed at the wrong database, and the resulting failures look
 * like data corruption rather than a caching bug.
 */
const globalForPrisma = globalThis as unknown as {
  __forgePrisma?: Map<string, PrismaClient>;
};

export function createPrismaClient(options: CreateClientOptions = {}): PrismaClient {
  const cacheKey = options.databaseUrl ?? process.env.DATABASE_URL ?? 'default';
  const cached = globalForPrisma.__forgePrisma?.get(cacheKey);
  if (cached) return cached;

  const client = new PrismaClient({
    ...(options.databaseUrl ? { datasources: { db: { url: options.databaseUrl } } } : {}),
    log: options.logQueries
      ? [{ emit: 'stdout', level: 'query' }, 'warn', 'error']
      : ['warn', 'error'],
  });

  // Cached only outside production: the point is to stop `tsx watch` reloads from
  // opening a new pool on every file save, which exhausts `max_connections` in an
  // afternoon. A production process creates its client once anyway.
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.__forgePrisma ??= new Map();
    globalForPrisma.__forgePrisma.set(cacheKey, client);
  }
  return client;
}

/**
 * PostgreSQL error codes we handle by name rather than by string matching.
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const PG_ERROR = {
  UNIQUE_VIOLATION: 'P2002',
  RECORD_NOT_FOUND: 'P2025',
  FOREIGN_KEY_VIOLATION: 'P2003',
  TRANSACTION_CONFLICT: 'P2034',
} as const;

export function isUniqueViolation(err: unknown, target?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== PG_ERROR.UNIQUE_VIOLATION) return false;
  if (!target) return true;
  const meta = err.meta as { target?: string[] | string } | undefined;
  const fields = Array.isArray(meta?.target) ? meta.target : meta?.target ? [meta.target] : [];
  return fields.some((f) => f.includes(target));
}

export function isNotFound(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === PG_ERROR.RECORD_NOT_FOUND
  );
}

/** Serialisation failure — safe to retry the whole transaction. */
export function isSerialisationFailure(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === PG_ERROR.TRANSACTION_CONFLICT) return true;
  }
  const code = (err as { code?: string })?.code;
  // 40001 serialization_failure, 40P01 deadlock_detected
  return code === '40001' || code === '40P01';
}

export interface TransactionOptions {
  /** Milliseconds Prisma waits for a free connection before giving up. */
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Retries on serialisation failures / deadlocks. */
  retries?: number;
}

/**
 * Run a transaction, retrying serialisation failures with jittered backoff.
 *
 * The advance path locks the run row, so genuine conflicts are rare — but the reaper,
 * the retry sweeper and a completing worker can all target the same run within the same
 * millisecond, and a bare failure there would strand a run until the next sweep.
 */
export async function withTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        maxWait: options.maxWait ?? 5_000,
        timeout: options.timeout ?? 15_000,
        ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
      });
    } catch (err) {
      lastError = err;
      if (!isSerialisationFailure(err) || attempt === retries) throw err;
      const backoff = Math.round(Math.random() * 25 * Math.pow(2, attempt));
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastError;
}

/**
 * Take a row-level lock on a workflow run for the remainder of the transaction.
 *
 * This is the concurrency control for orchestration: two control-plane instances
 * advancing the same run serialise here rather than racing to write overlapping
 * transitions. `NOWAIT` is deliberately not used — a short wait is cheaper than
 * re-delivering the advance message.
 */
export async function lockWorkflowRun(tx: Tx, workflowRunId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM workflow_run WHERE id = ${workflowRunId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}

/**
 * Try to take a session-level advisory lock. Used by singleton loops (the cron
 * scheduler) so running three control-plane replicas does not fire a schedule
 * three times. Released with `releaseAdvisoryLock`, or automatically on disconnect.
 */
export async function tryAdvisoryLock(prisma: PrismaClient, key: bigint): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${key}::bigint) AS locked
  `;
  return rows[0]?.locked === true;
}

export async function releaseAdvisoryLock(prisma: PrismaClient, key: bigint): Promise<void> {
  await prisma.$queryRaw`SELECT pg_advisory_unlock(${key}::bigint)`;
}

/** Stable 64-bit key from a name, so advisory lock ids are readable in code. */
export function advisoryLockKey(name: string): bigint {
  let hash = 0n;
  const prime = 1099511628211n;
  const mask = (1n << 63n) - 1n;
  for (const char of name) {
    hash = ((hash ^ BigInt(char.charCodeAt(0))) * prime) & mask;
  }
  return hash;
}

/** Round-trip check used by health endpoints. */
export async function pingDatabase(prisma: PrismaClient): Promise<number> {
  const started = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  return Date.now() - started;
}
