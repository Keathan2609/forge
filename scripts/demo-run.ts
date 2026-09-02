/**
 * Trigger a demo workflow and stream its execution to the terminal.
 *
 *   pnpm demo:run                    # order-fulfilment
 *   pnpm demo:run media-pipeline
 *   pnpm demo:run resilience-demo    # retries, backoff and a dead letter
 */
import { ForgeClient, type ExecutionEvent } from '@forge/sdk';

const API_URL = process.env.FORGE_API_URL ?? 'http://localhost:4000';

/** Representative inputs, so the script needs no arguments to be useful. */
const INPUTS: Record<string, Record<string, unknown>> = {
  'order-fulfilment': {
    orderId: 'ord_' + Math.random().toString(36).slice(2, 8),
    amount: 4999,
    items: [
      { sku: 'KB-87', qty: 1 },
      { sku: 'MS-11', qty: 2 },
    ],
  },
  'deployment-pipeline': { branch: 'main', commit: Math.random().toString(16).slice(2, 9) },
  'media-pipeline': { assetId: 'asset_demo', filename: 'keynote.mov', generatePreview: true },
  'resilience-demo': { scenario: 'retry' },
  'crash-recovery-demo': {},
};

const c = {
  dim: (s: string): string => '[2m' + s + '[0m',
  bold: (s: string): string => '[1m' + s + '[0m',
  green: (s: string): string => '[32m' + s + '[0m',
  red: (s: string): string => '[31m' + s + '[0m',
  yellow: (s: string): string => '[33m' + s + '[0m',
  cyan: (s: string): string => '[36m' + s + '[0m',
};

function tone(type: string): (s: string) => string {
  if (/COMPLETED|SUCCEEDED|RECOVERED/.test(type)) return c.green;
  if (/FAILED|DEAD_LETTER|TIMED_OUT|EXPIRED/.test(type)) return c.red;
  if (/RETRY|CANCEL|SKIP/.test(type)) return c.yellow;
  if (/STARTED|QUEUED/.test(type)) return c.cyan;
  return c.dim;
}

async function main(): Promise<void> {
  const workflowKey = process.argv[2] ?? 'order-fulfilment';
  const input = INPUTS[workflowKey] ?? {};

  const client = new ForgeClient({
    baseUrl: API_URL,
    ...(process.env.FORGE_API_KEY ? { apiKey: process.env.FORGE_API_KEY } : {}),
  });

  const workflows = await client.workflows.list().catch(() => {
    console.error(
      c.red('could not reach the FORGE API at ' + API_URL) + '\nStart it with `pnpm forge:dev`.',
    );
    process.exit(1);
  });

  if (!workflows.some((w) => w.key === workflowKey)) {
    console.error(
      c.red('workflow "' + workflowKey + '" is not installed.') +
        '\nRun `pnpm demo:seed`, or pick one of: ' +
        workflows.map((w) => w.key).join(', '),
    );
    process.exit(1);
  }

  console.log(c.bold('\n▸ ' + workflowKey));
  console.log(c.dim('  input: ' + JSON.stringify(input) + '\n'));

  const triggered = await client.workflows.trigger(workflowKey, input);
  console.log(c.dim('  run ' + triggered.runId + '\n'));

  const seen = new Set<number>();
  const render = (event: ExecutionEvent): void => {
    if (seen.has(event.seq)) return;
    seen.add(event.seq);
    const time = new Date(event.occurredAt).toISOString().slice(11, 23);
    console.log(
      '  ' +
        c.dim(time) +
        '  ' +
        tone(event.type)(event.type.padEnd(22)) +
        ' ' +
        c.bold((event.nodeKey ?? '').padEnd(20)) +
        c.dim((event.message ?? '').slice(0, 60)),
    );
  };

  const unsubscribe = client.streamRun(triggered.runId, { onEvent: render });

  try {
    const run = await client.runs.wait(triggered.runId, { timeoutMs: 180_000 });

    // The stream may lag the final poll; replay anything not yet shown so the timeline
    // is complete rather than truncated at whatever the stream managed to deliver.
    for (const event of await client.runs.events(triggered.runId)) render(event);

    const ok = run.state === 'SUCCEEDED';
    console.log(
      '\n  ' +
        (ok ? c.green('✓ ' + run.state) : c.red('✗ ' + run.state)) +
        c.dim(' in ' + run.durationMs + 'ms · ') +
        run.counts.succeeded +
        '/' +
        run.counts.total +
        ' tasks succeeded' +
        (run.counts.deadLettered > 0
          ? c.red(' · ' + run.counts.deadLettered + ' dead-lettered')
          : '') +
        (run.counts.skipped > 0 ? c.dim(' · ' + run.counts.skipped + ' skipped') : ''),
    );
    if (run.errorMessage) console.log('  ' + c.red(run.errorMessage));
    if (run.output) console.log(c.dim('  output: ' + JSON.stringify(run.output)));

    console.log(
      c.dim('\n  console: ' + API_URL.replace('4000', '3000') + '/console/runs/' + run.id + '\n'),
    );

    // A failed demo run is a legitimate outcome for `resilience-demo`, which is designed
    // to fail — so only exit non-zero when the workflow was meant to succeed.
    if (!ok && workflowKey !== 'resilience-demo') process.exit(1);
  } finally {
    unsubscribe();
  }
}

void main().catch((err: unknown) => {
  console.error(c.red('demo run failed: ') + ((err as Error).message ?? String(err)));
  process.exit(1);
});
