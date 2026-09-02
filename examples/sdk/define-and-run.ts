/**
 * Define a workflow with the builder, save it, and run it to completion.
 *
 *   pnpm tsx examples/sdk/define-and-run.ts
 */
import { ForgeClient, defineWorkflow } from '@forge/sdk';

const forge = new ForgeClient({
  baseUrl: process.env.FORGE_API_URL ?? 'http://localhost:4000',
  ...(process.env.FORGE_API_KEY ? { apiKey: process.env.FORGE_API_KEY } : {}),
});

/**
 * A small order pipeline: validate, then reserve stock and authorise payment in
 * parallel, then ship.
 *
 * The builder checks two things the JSON format cannot: that every `after` names a task
 * that exists, and that a task reading `$.tasks.x.output` actually depends on `x`. Both
 * are caught at the `.task()` call rather than as a server-side validation error at the
 * end of the file.
 */
const workflow = defineWorkflow('example-orders', 'Example Order Pipeline')
  .description('Built with the SDK. Demonstrates fan-out, fan-in and retry policy.')
  .inputSchema({ orderId: 'string', amount: 'number — minor units' })
  .task('validate', 'validate', {
    description: 'Reject the run immediately if the payload is incomplete.',
    config: { required: ['orderId', 'amount'] },
    input: { payload: '$.input' },
    // Missing input will never become present on a retry.
    retry: { maxAttempts: 1 },
  })
  .task('reserve-stock', 'delay', {
    after: 'validate',
    config: { durationMs: 600 },
  })
  .task('authorise-payment', 'http.echo', {
    after: 'validate',
    config: { latencyMs: 400, status: 200, body: { authorised: true } },
    retry: {
      maxAttempts: 4,
      initialDelayMs: 500,
      // A declined card is deterministic. Retrying it three times is pointless, and
      // looks like fraud to the issuer.
      nonRetryableErrors: ['HTTP_402', 'HTTP_400'],
    },
  })
  .task('ship', 'transform', {
    // Depends on both branches: this is the join.
    after: ['reserve-stock', 'authorise-payment'],
    input: {
      source: '$.input',
      mapping: { value: { shipmentId: 'orderId' } },
    },
  })
  .output({ shipmentId: '$.tasks.ship.output.result.shipmentId' })
  .build();

async function main(): Promise<void> {
  const saved = await forge.workflows.create(workflow, { changelog: 'from the SDK example' });
  console.log(
    saved.created
      ? '✓ saved ' + saved.key + ' as v' + saved.version
      : '· ' + saved.key + ' unchanged (identical to v' + saved.version + ')',
  );

  const run = await forge.runs.triggerAndWait(
    'example-orders',
    { orderId: 'ord_' + Date.now().toString(36), amount: 4999 },
    { timeoutMs: 60_000 },
  );

  console.log('\n' + run.state + ' in ' + run.durationMs + 'ms');
  console.log('output:', JSON.stringify(run.output));

  for (const task of run.tasks ?? []) {
    console.log(
      '  ' +
        task.nodeKey.padEnd(20) +
        task.state.padEnd(12) +
        (task.durationMs ?? 0) +
        'ms  ' +
        (task.workerId ? task.workerId.slice(0, 8) : ''),
    );
  }

  if (run.state !== 'SUCCEEDED') process.exit(1);
}

void main().catch((err: unknown) => {
  console.error('failed:', (err as Error).message);
  process.exit(1);
});
