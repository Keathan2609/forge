import type { PrismaClient } from './client';

/**
 * Test-only helpers.
 *
 * Integration suites assert on exact state ("this task is QUEUED and nothing has claimed
 * it"), so each must start from a clean slate. Without this, leftover rows from a
 * previous suite starve the next: its outbox publisher claims the *old* suite's pending
 * rows, its advancer consumes the resulting messages, and the run it actually cares about
 * never gets advanced before the assertion times out.
 *
 * This is exported from the database package rather than duplicated per test package,
 * because the safety guard below is the important part and must not be reimplemented.
 */

/**
 * Names a database is allowed to have for `resetTestDatabase` to touch it.
 *
 * A truncate helper pointed at the wrong `DATABASE_URL` destroys a real environment, and
 * the failure is silent until someone notices the data is gone. Requiring the name to
 * say "test" makes that mistake impossible rather than unlikely.
 */
const TEST_DATABASE_PATTERN = /(^|[_-])test(\d*)?$/i;

export class NotATestDatabaseError extends Error {
  constructor(database: string) {
    super(
      'refusing to reset "' +
        database +
        '": the database name must end in `test` (e.g. forge_test). ' +
        'This guard exists so a misconfigured DATABASE_URL cannot wipe a real environment.',
    );
    this.name = 'NotATestDatabaseError';
  }
}

/**
 * Delete every row, in an order that respects foreign keys.
 *
 * `TRUNCATE … CASCADE` in one statement is both faster than per-table deletes and immune
 * to ordering mistakes, and `RESTART IDENTITY` resets sequences so ids do not drift
 * between runs.
 */
export async function resetTestDatabase(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ current_database: string }>>`
    SELECT current_database()
  `;
  const database = rows[0]?.current_database ?? '';
  if (!TEST_DATABASE_PATTERN.test(database)) throw new NotATestDatabaseError(database);

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      execution_event,
      task_attempt,
      worker_lease,
      dead_letter,
      task_run,
      workflow_run,
      workflow_schedule,
      workflow_edge,
      workflow_node,
      workflow_version,
      workflow_definition,
      outbox_event,
      idempotency_record,
      worker
    RESTART IDENTITY CASCADE
  `);
}
