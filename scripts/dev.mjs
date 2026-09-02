#!/usr/bin/env node
/**
 * `pnpm forge:dev` — run the whole platform locally, outside Docker.
 *
 * Starts PostgreSQL/Redis/Jaeger in containers (they have no business running from
 * source), applies migrations, then runs the API, control plane, three workers and the
 * web console as child processes with live reload. Output from every process is
 * interleaved into one stream with a coloured prefix, because the interesting moments in
 * a distributed system are precisely the ones that span two processes — a worker dying
 * and the control plane reclaiming its lease is unreadable in two separate terminals.
 *
 * Ctrl-C stops everything, in reverse dependency order.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const compose = resolve(root, 'infra', 'docker', 'docker-compose.yml');

const COLOURS = {
  api: '[36m', // cyan
  scheduler: '[35m', // magenta
  'worker-1': '[32m', // green
  'worker-2': '[33m', // yellow
  'worker-3': '[34m', // blue
  web: '[38;5;208m', // orange
  infra: '[90m', // grey
};
const RESET = '[0m';
const DIM = '[2m';

const children = [];
let shuttingDown = false;

function log(name, line) {
  const colour = COLOURS[name] ?? '';
  const label = name.padEnd(9);
  // Structured logs are pretty-printed by pino in dev; anything else passes through.
  process.stdout.write(colour + label + RESET + DIM + ' | ' + RESET + line + '\n');
}

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => log(name, line));
  }

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(name, 'exited with ' + (signal ?? 'code ' + code));
    // A crashed dependency makes the rest of the stack meaningless; stop cleanly rather
    // than leaving half a platform running and a confusing error somewhere else.
    if (code !== 0 && name !== 'web') void shutdown(1);
  });

  children.push({ name, child });
  return child;
}

function runOnce(name, command, args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (line) => log(name, line));
    }
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(name + ' exited with code ' + code)),
    );
    child.on('error', reject);
  });
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('infra', 'shutting down…');

  // Reverse order: workers finish in-flight tasks, then the control plane, then the API.
  for (const { name, child } of [...children].reverse()) {
    if (child.exitCode !== null) continue;
    log('infra', 'stopping ' + name);
    child.kill('SIGTERM');
  }

  // Give the workers their drain window before forcing the issue.
  await new Promise((r) => setTimeout(r, 3_000));
  for (const { child } of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  log('infra', 'containers are still running — stop them with `pnpm forge:down`');
  process.exit(exitCode);
}

async function main() {
  if (!existsSync(resolve(root, '.env'))) {
    log('infra', 'no .env found — copying .env.example');
    const { copyFileSync } = await import('node:fs');
    copyFileSync(resolve(root, '.env.example'), resolve(root, '.env'));
  }

  log('infra', 'starting postgres, redis and jaeger…');
  await runOnce('infra', 'docker', [
    'compose',
    '-f',
    compose,
    'up',
    '-d',
    'postgres',
    'redis',
    'jaeger',
  ]);

  // `--wait` above is not used deliberately: on a cold start the image pull can take
  // longer than the compose timeout, and the explicit poll below gives a clearer error.
  log('infra', 'waiting for postgres…');
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await runOnce('infra', 'docker', ['exec', 'forge-postgres', 'pg_isready', '-U', 'forge']);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  log('infra', 'applying migrations…');
  await runOnce('infra', 'pnpm', ['--filter', '@forge/database', 'run', 'deploy']);

  log('infra', 'building workspace packages…');
  await runOnce('infra', 'pnpm', ['turbo', 'run', 'build', '--filter=./packages/*']);

  const shared = {
    NODE_ENV: 'development',
    FORGE_DEMO_MODE: 'true',
    FORGE_AUTH_ENABLED: 'false',
  };

  run('api', 'pnpm', ['--filter', '@forge/api', 'dev'], shared);
  run('scheduler', 'pnpm', ['--filter', '@forge/scheduler', 'dev'], shared);

  // Three workers, each on its own metrics port, so the console's fleet view has
  // something to show and killing one demonstrates recovery.
  for (let i = 1; i <= 3; i++) {
    run('worker-' + i, 'pnpm', ['--filter', '@forge/worker', 'dev'], {
      ...shared,
      FORGE_WORKER_NAME: 'worker-' + i,
      FORGE_WORKER_METRICS_PORT: String(9100 + i),
      FORGE_WORKER_QUEUES: 'default,media,deploy',
    });
  }

  run('web', 'pnpm', ['--filter', '@forge/web', 'dev'], shared);

  log('infra', '');
  log('infra', 'FORGE is starting up:');
  log('infra', '  console      http://localhost:3000');
  log('infra', '  api          http://localhost:4000');
  log('infra', '  traces       http://localhost:16686');
  log('infra', '  metrics      http://localhost:4000/metrics');
  log('infra', '');
  log('infra', 'seed demo data with:  pnpm demo:seed');
  log('infra', 'press Ctrl-C to stop');
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

main().catch((err) => {
  log('infra', 'startup failed: ' + err.message);
  void shutdown(1);
});
