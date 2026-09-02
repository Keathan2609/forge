import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DeadLetterStatus,
  OutboxEventType,
  OutboxStatus,
  TaskAttemptState,
  TaskRunState,
  WorkerState,
  WorkflowRunState,
} from '@forge/contracts';

/**
 * Enum parity between `@forge/contracts` and the Prisma schema.
 *
 * The state vocabulary is declared twice — once as TypeScript constants the engine
 * reasons over, once as PostgreSQL enums the database enforces. That duplication is
 * unavoidable (Prisma generates its own types from `schema.prisma`, and the engine must
 * not depend on the database), but drift between the two is a genuinely nasty failure:
 * the engine plans a transition to a state the column cannot hold, and the write fails at
 * runtime with a driver-level error rather than at compile time.
 *
 * This test reads `schema.prisma` as text and compares the enum members, so adding a
 * state on one side without the other fails the build.
 */

const schemaPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'prisma',
  'schema.prisma',
);
const schema = readFileSync(schemaPath, 'utf8');

/** Extract the members of a Prisma `enum Name { … }` block. */
function prismaEnum(name: string): string[] {
  const match = new RegExp('enum\\s+' + name + '\\s*\\{([^}]*)\\}', 'm').exec(schema);
  if (!match?.[1]) throw new Error('enum "' + name + '" not found in schema.prisma');
  return match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0)
    .sort();
}

const CASES: Array<[string, Record<string, string>]> = [
  ['WorkflowRunState', WorkflowRunState],
  ['TaskRunState', TaskRunState],
  ['TaskAttemptState', TaskAttemptState],
  ['WorkerState', WorkerState],
  ['OutboxStatus', OutboxStatus],
  ['OutboxEventType', OutboxEventType],
  ['DeadLetterStatus', DeadLetterStatus],
];

describe('contracts and Prisma enums agree', () => {
  it.each(CASES)('%s', (name, contractEnum) => {
    const fromContracts = Object.values(contractEnum).sort();
    const fromPrisma = prismaEnum(name);

    expect(fromPrisma, name + ' differs between schema.prisma and @forge/contracts').toEqual(
      fromContracts,
    );
  });

  it('declares every enum the contracts package defines', () => {
    // Guards the opposite direction: a new contracts enum with no Prisma counterpart.
    for (const [name] of CASES) {
      expect(() => prismaEnum(name), name + ' is missing from schema.prisma').not.toThrow();
    }
  });

  it('uses the enum values as the stored representation, not integers', () => {
    // Every value must equal its key. Storing an integer would make the database
    // unreadable without the application, and a reordering would silently remap states.
    for (const [name, contractEnum] of CASES) {
      for (const [key, value] of Object.entries(contractEnum)) {
        expect(value, name + '.' + key + ' should equal its key').toBe(key);
      }
    }
  });
});
