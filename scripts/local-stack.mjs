#!/usr/bin/env node
/**
 * Run the compiled backend (control plane + N workers) as one supervised process.
 *
 * `scripts/dev.mjs` is the developer-facing entry point and runs everything with live
 * reload. This one runs the *built* output and is what the verification and chaos
 * scripts drive: no watchers, no rebuild races, and one PID to stop.
 *
 *   node scripts/local-stack.mjs [--workers 3] [--no-scheduler]
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const workerCount = Number(args[args.indexOf('--workers') + 1]) || 3;
const withScheduler = !args.includes('--no-scheduler');

const children = [];
let stopping = false;

function start(name, entry, env) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      process.stdout.write('[' + name + '] ' + line + '\n');
    });
  }

  child.on('exit', (code, signal) => {
    if (stopping) return;
    process.stdout.write('[' + name + '] exited ' + (signal ?? 'code ' + code) + '\n');
    // A worker killed by the chaos demo is expected; the supervisor restarts it so the
    // fleet returns to full strength, exactly as an orchestrator would.
    if (name.startsWith('worker') && signal === 'SIGKILL') {
      process.stdout.write('[' + name + '] restarting after crash\n');
      setTimeout(() => {
        const index = children.findIndex((c) => c.name === name);
        if (index !== -1) children.splice(index, 1);
        startWorker(Number(name.split('-')[1]));
      }, 1_000);
    }
  });

  children.push({ name, child });
  return child;
}

function startWorker(index) {
  return start('worker-' + index, resolve(root, 'apps/worker/dist/main.js'), {
    FORGE_WORKER_NAME: 'worker-' + index,
    FORGE_WORKER_METRICS_PORT: String(9110 + index),
    FORGE_WORKER_QUEUES: process.env.FORGE_WORKER_QUEUES ?? 'default,media,deploy',
    FORGE_WORKER_CAPABILITIES:
      process.env.FORGE_WORKER_CAPABILITIES ??
      'noop,delay,compute,http.echo,transform,validate,simulate.flaky,simulate.fail,simulate.timeout,simulate.crash,simulate.slow',
    FORGE_DEMO_MODE: 'true',
  });
}

if (withScheduler) {
  start('scheduler', resolve(root, 'apps/scheduler/dist/main.js'), {
    FORGE_SCHEDULER_METRICS_PORT: process.env.FORGE_SCHEDULER_METRICS_PORT ?? '9102',
  });
}

for (let i = 1; i <= workerCount; i++) startWorker(i);

function stop() {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL');
    process.exit(0);
  }, 5_000);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
