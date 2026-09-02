#!/usr/bin/env node
/**
 * Run a command with the repository's .env loaded, if one exists.
 *
 * Prisma resolves `.env` relative to the schema, not the workspace root, and a
 * pnpm monorepo has neither. Rather than scattering `.env` copies (and risking one
 * being committed), every database script goes through this wrapper: it loads the root
 * .env when present, and is a transparent no-op inside Docker where the environment is
 * already populated. Existing environment variables always win over the file, so
 * `DATABASE_URL=... pnpm db:deploy` behaves the way you would expect.
 *
 *   node scripts/with-env.mjs prisma migrate deploy
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env');

if (existsSync(envPath)) {
  const contents = readFileSync(envPath, 'utf8');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment variables take precedence over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/with-env.mjs <command> [...args]');
  process.exit(2);
}

/**
 * On Windows the workspace binaries (`prisma`, `tsx`) are `.CMD` shims, which the OS
 * cannot execute without a command interpreter — `shell: false` fails with EINVAL. Node
 * warns about `shell: true` (DEP0190) because arguments are concatenated rather than
 * escaped; that is acceptable here because every argument comes from a literal in
 * package.json, never from user input.
 */
const child = spawn(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('failed to start "' + command + '": ' + err.message);
  process.exit(1);
});
