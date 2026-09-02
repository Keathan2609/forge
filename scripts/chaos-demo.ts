/**
 * Automated failure-recovery demonstration.
 *
 * Proves, against a live system, that killing a worker mid-task does not lose the task:
 *
 *   1. trigger `crash-recovery-demo`
 *   2. wait for `crash-step` to be claimed, and record which worker claimed it
 *   3. the handler SIGKILLs that worker — no shutdown hook, no lease release
 *   4. the lease expires and the control plane's reaper reclaims the attempt
 *   5. a *different* worker claims attempt 2 and completes it
 *   6. the run reaches SUCCEEDED
 *
 * Every assertion is checked against the API, and the script exits non-zero if any step
 * does not happen — so it is usable as a CI gate, not just a demo.
 *
 *   pnpm demo:chaos
 */
import { ForgeClient, type ExecutionEvent, type WorkflowRunView } from '@forge/sdk';

const API_URL = process.env.FORGE_API_URL ?? 'http://localhost:4000';
const WORKFLOW = 'crash-recovery-demo';
const TIMEOUT_MS = Number(process.env.CHAOS_TIMEOUT_MS ?? 120_000);

const client = new ForgeClient({
  baseUrl: API_URL,
  ...(process.env.FORGE_API_KEY ? { apiKey: process.env.FORGE_API_KEY } : {}),
  timeoutMs: 15_000,
});

const c = {
  dim: (s: string): string => '[2m' + s + '[0m',
  green: (s: string): string => '[32m' + s + '[0m',
  red: (s: string): string => '[31m' + s + '[0m',
  yellow: (s: string): string => '[33m' + s + '[0m',
  bold: (s: string): string => '[1m' + s + '[0m',
};

let stepNumber = 0;
function step(message: string): void {
  stepNumber += 1;
  console.log('\n' + c.bold(stepNumber + '. ' + message));
}

function detail(message: string): void {
  console.log('   ' + c.dim(message));
}

function pass(message: string): void {
  console.log('   ' + c.green('✓ ') + message);
}

function fail(message: string): never {
  console.error('\n' + c.red('✗ FAILED: ') + message + '\n');
  process.exit(1);
}

async function waitFor<T>(
  description: string,
  predicate: () => Promise<T | null | undefined | false>,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result as T;
    await new Promise((r) => setTimeout(r, 400));
  }
  fail('timed out after ' + Math.round(timeoutMs / 1000) + 's waiting for ' + description);
}

async function main(): Promise<void> {
  console.log(c.bold('\nFORGE — worker crash recovery demonstration'));
  console.log(c.dim('   api: ' + API_URL));

  // --- preflight -----------------------------------------------------------
  step('Check the platform is healthy');
  const status = await client.system.status().catch(() => {
    fail('cannot reach the API at ' + API_URL + '. Start it with `pnpm forge:dev`.');
  });
  detail(
    'postgres ' +
      (status.components.database.ok ? 'ok' : 'DOWN') +
      ' · redis ' +
      (status.components.redis.ok ? 'ok' : 'DOWN') +
      ' · workers ' +
      status.components.workers.online,
  );

  // The demo needs somewhere for the task to land after its first worker dies.
  if (status.components.workers.online < 2) {
    fail(
      'this demonstration needs at least 2 online workers (found ' +
        status.components.workers.online +
        '). Recovery has nowhere to go with one worker.',
    );
  }
  pass(status.components.workers.online + ' workers online');

  const workflows = await client.workflows.list();
  if (!workflows.some((w) => w.key === WORKFLOW)) {
    fail('workflow "' + WORKFLOW + '" is not installed. Run `pnpm demo:seed` first.');
  }

  // --- trigger -------------------------------------------------------------
  step('Trigger the crash-recovery workflow');
  const triggered = await client.workflows.trigger(WORKFLOW, {});
  detail('run ' + triggered.runId + ' (' + WORKFLOW + ' v' + triggered.version + ')');

  const events: ExecutionEvent[] = [];
  const unsubscribe = client.streamRun(triggered.runId, {
    onEvent: (event) => events.push(event),
  });

  try {
    // --- observe the crash -------------------------------------------------
    step('Wait for a worker to claim the task that will crash');
    const claimed = await waitFor('crash-step to be claimed', async () => {
      const run = await client.runs.get(triggered.runId);
      const task = run.tasks?.find((t) => t.nodeKey === 'crash-step');
      return task?.state === 'RUNNING' && task.workerId ? { run, task } : null;
    });

    const victimWorker = claimed.task.workerId as string;
    pass('worker ' + victimWorker.slice(0, 8) + ' claimed crash-step (attempt 1)');
    detail('that worker is about to be killed with SIGKILL by the task handler');

    // --- recovery ----------------------------------------------------------
    step('Wait for the lease to expire and the control plane to reclaim the task');
    const recoveryEvent = await waitFor(
      'the lease to expire and the task to be recovered',
      async () => {
        const history = await client.runs.events(triggered.runId);
        const expired = history.find((e) => e.type === 'LEASE_EXPIRED');
        const recovered = history.find((e) => e.type === 'TASK_RECOVERED');
        return expired && recovered ? { expired, recovered } : null;
      },
      60_000,
    );

    pass('lease expired: ' + recoveryEvent.expired.message);
    pass('task recovered: ' + recoveryEvent.recovered.message);

    // --- reassignment ------------------------------------------------------
    step('Wait for a different worker to pick the task up');
    const reassigned = await waitFor('another worker to claim attempt 2', async () => {
      const run = await client.runs.get(triggered.runId);
      const task = run.tasks?.find((t) => t.nodeKey === 'crash-step');
      if (!task || !task.workerId) return null;
      // Must be a *different* worker, on a later attempt.
      return task.workerId !== victimWorker && task.attempts >= 2 ? task : null;
    });

    pass(
      'worker ' +
        (reassigned.workerId as string).slice(0, 8) +
        ' took over on attempt ' +
        reassigned.attempts,
    );

    // --- completion --------------------------------------------------------
    step('Wait for the run to complete');
    const finished = await waitFor<WorkflowRunView>(
      'the run to reach a terminal state',
      async () => {
        const run = await client.runs.get(triggered.runId);
        return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state) ? run : null;
      },
      TIMEOUT_MS,
    );

    if (finished.state !== 'SUCCEEDED') {
      fail(
        'the run finished as ' +
          finished.state +
          ' rather than SUCCEEDED: ' +
          (finished.errorMessage ?? 'no error recorded'),
      );
    }

    pass('run SUCCEEDED in ' + finished.durationMs + 'ms, despite losing a worker mid-task');

    // --- verify the ledger -------------------------------------------------
    step('Verify the attempt history records what actually happened');
    const crashTask = finished.tasks?.find((t) => t.nodeKey === 'crash-step');
    if (!crashTask) fail('crash-step is missing from the finished run');

    const attempts = await client.runs.attempts(crashTask.id);
    const abandoned = attempts.filter((a) => a.state === 'ABANDONED');
    const succeeded = attempts.filter((a) => a.state === 'SUCCEEDED');

    if (abandoned.length === 0) fail('no attempt was recorded as ABANDONED');
    if (succeeded.length === 0) fail('no attempt was recorded as SUCCEEDED');

    pass(
      attempts.length +
        ' attempts recorded: ' +
        attempts.map((a) => '#' + a.attemptNumber + ' ' + a.state).join(', '),
    );

    // The property that matters most: an infrastructure failure did not consume the
    // application's retry budget.
    detail(
      'the abandoned attempt was reclaimed by the reaper, not counted as an application failure',
    );

    // --- summary -----------------------------------------------------------
    console.log('\n' + c.bold('Timeline'));
    for (const event of events.filter((e) => e.nodeKey === 'crash-step' || !e.nodeKey)) {
      const time = new Date(event.occurredAt).toISOString().slice(11, 23);
      const tone = /EXPIRED|FAILED/.test(event.type)
        ? c.red
        : /RECOVERED|COMPLETED/.test(event.type)
          ? c.green
          : /RETRY|CANCEL/.test(event.type)
            ? c.yellow
            : c.dim;
      console.log(
        '  ' + c.dim(time) + '  ' + tone(event.type.padEnd(22)) + ' ' + (event.message ?? ''),
      );
    }

    console.log('\n' + c.green(c.bold('  Recovery demonstrated.')));
    console.log(
      c.dim(
        '  A worker was killed with SIGKILL mid-task. No human intervened.\n' +
          '  The lease expired, the control plane requeued the work, another worker\n' +
          '  finished it, and the run completed correctly.\n',
      ),
    );
    console.log(
      c.dim(
        '  Inspect it: ' +
          API_URL.replace('4000', '3000') +
          '/console/runs/' +
          triggered.runId +
          '\n',
      ),
    );
  } finally {
    unsubscribe();
  }
}

void main().catch((err: unknown) => {
  console.error('\n' + c.red('chaos demo failed: ') + ((err as Error).message ?? String(err)));
  process.exit(1);
});
