#!/usr/bin/env node
/**
 * Prepare the integration-test environment.
 *
 * Integration tests get their own PostgreSQL database and their own Redis database
 * index, for one reason: they assert on exact state ("this task is QUEUED, and no worker
 * has claimed it"). Sharing the development database with a running `pnpm forge:dev`
 * means the live control plane advances the test's runs and live workers claim its
 * tasks — the tests then fail for reasons that have nothing to do with the code.
 *
 * Isolating them also means `pnpm forge:dev` and `pnpm test:integration` can run at the
 * same time, which matters when you are iterating on a failing test.
 *
 *   node scripts/test-env.mjs          # create the database and apply migrations
 *   node scripts/test-env.mjs --reset  # drop and recreate it first
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const TEST_DB = process.env.TEST_DB_NAME ?? 'forge_test';
const CONTAINER = process.env.FORGE_PG_CONTAINER ?? 'forge-postgres';
const reset = process.argv.includes('--reset');

/**
 * Derive the test connection string from the development one, so a machine that has
 * moved PostgreSQL to a different port does not need a second variable configured.
 */
function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base =
    process.env.DATABASE_URL ?? 'postgresql://forge:forge@localhost:5435/forge?schema=public';
  const url = new URL(base);
  url.pathname = '/' + TEST_DB;
  return url.toString();
}

function psql(database, sql) {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'forge', '-d', database, '-tAc', sql],
    { encoding: 'utf8' },
  ).trim();
}

function main() {
  const url = testDatabaseUrl();

  try {
    if (reset) {
      console.log('dropping ' + TEST_DB + '…');
      // Terminate stragglers first; DROP DATABASE fails while any session is attached.
      psql(
        'postgres',
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '" +
          TEST_DB +
          "' AND pid <> pg_backend_pid()",
      );
      psql('postgres', 'DROP DATABASE IF EXISTS ' + TEST_DB);
    }

    const exists = psql('postgres', "SELECT 1 FROM pg_database WHERE datname = '" + TEST_DB + "'");
    if (exists !== '1') {
      console.log('creating ' + TEST_DB + '…');
      psql('postgres', 'CREATE DATABASE ' + TEST_DB);
    }
  } catch (err) {
    console.error(
      'could not reach PostgreSQL in container "' +
        CONTAINER +
        '".\nStart it with `pnpm forge:infra`, or set FORGE_PG_CONTAINER.\n' +
        String(err.message ?? err),
    );
    process.exit(1);
  }

  console.log('applying migrations to ' + TEST_DB + '…');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: resolve(root, 'packages', 'database'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  console.log('\ntest environment ready');
  console.log('  TEST_DATABASE_URL=' + url.replace(/:[^:@]*@/, ':***@'));
  console.log('  TEST_REDIS_URL=' + (process.env.TEST_REDIS_URL ?? 'redis://localhost:6381/1'));
}

main();
