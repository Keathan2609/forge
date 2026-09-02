import { DEFAULT_RETRY_POLICY, type WorkflowDefinition, type WorkflowNode } from '@forge/contracts';

/**
 * Demo workflow definitions.
 *
 * Chosen to exercise structurally different execution shapes rather than to look
 * impressive: a long sequential chain, a fan-out/fan-in join, a conditional branch, and
 * one that fails on purpose. Between them they cover every path in the scheduler.
 *
 * Every task uses a built-in handler that simulates work locally — nothing here needs a
 * network, an account, or a paid service to run.
 */

function node(
  key: string,
  type: string,
  overrides: Partial<WorkflowNode> & { x?: number; y?: number } = {},
): WorkflowNode {
  const { x = 0, y = 0, ...rest } = overrides;
  return {
    key,
    name: rest.name ?? key.replace(/[-.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    type,
    queue: rest.queue ?? 'default',
    timeoutMs: rest.timeoutMs ?? 30_000,
    retryPolicy: rest.retryPolicy ?? DEFAULT_RETRY_POLICY,
    config: rest.config ?? {},
    input: rest.input ?? {},
    metadata: rest.metadata ?? {},
    ...(rest.condition ? { condition: rest.condition } : {}),
    ...(rest.description ? { description: rest.description } : {}),
    position: { x, y },
  };
}

const COL = 260;
const ROW = 130;

/**
 * Deployment pipeline — a long sequential chain.
 *
 * Demonstrates: strict ordering, a conditional gate (production only deploys when smoke
 * tests pass *and* the branch is `main`), and how a failure part-way through cancels
 * everything downstream instead of leaving orphans.
 */
export const deploymentPipeline: WorkflowDefinition = {
  key: 'deployment-pipeline',
  name: 'Deployment Pipeline',
  description:
    'Sequential build, test and deploy chain with a conditional production gate. Demonstrates ordering and failure propagation.',
  timeoutMs: 900_000,
  defaultRetryPolicy: DEFAULT_RETRY_POLICY,
  inputSchema: {
    branch: 'string — git branch being deployed',
    commit: 'string — commit sha',
  },
  output: {
    deployed: { from: '$.tasks.deploy-production.output' },
    stagingUrl: { from: '$.tasks.deploy-staging.output.url' },
  },
  nodes: [
    node('validate', 'validate', {
      x: 0,
      y: 0,
      description: 'Reject the run immediately if the trigger payload is incomplete.',
      config: { required: ['branch', 'commit'] },
      input: { payload: { from: '$.input' } },
      // Missing input will never become present on a retry.
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
    }),
    node('build', 'delay', {
      x: COL,
      y: 0,
      description: 'Compile the artifact.',
      config: { durationMs: 1_200 },
      timeoutMs: 60_000,
    }),
    node('test', 'delay', {
      x: COL * 2,
      y: 0,
      description: 'Run the test suite.',
      config: { durationMs: 900 },
    }),
    node('security-check', 'delay', {
      x: COL * 3,
      y: 0,
      description: 'Dependency and container scan.',
      config: { durationMs: 700 },
    }),
    node('package', 'delay', {
      x: COL * 4,
      y: 0,
      description: 'Build and push the image.',
      config: { durationMs: 600 },
    }),
    node('deploy-staging', 'http.echo', {
      x: COL * 5,
      y: 0,
      description: 'Roll out to staging.',
      config: { latencyMs: 500, status: 200, body: { url: 'https://staging.example.internal' } },
    }),
    node('smoke-test', 'delay', {
      x: COL * 6,
      y: 0,
      description: 'Verify staging responds correctly.',
      config: { durationMs: 500 },
      // A smoke test failing is usually a flaky environment, so it is worth retrying.
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3, initialDelayMs: 500 },
    }),
    node('deploy-production', 'http.echo', {
      x: COL * 7,
      y: 0,
      description: 'Production rollout — only on main.',
      // The conditional gate: everything upstream runs on every branch, production
      // deploys only on main. A non-main run leaves this SKIPPED, not failed.
      condition: "$.input.branch == 'main'",
      config: { latencyMs: 800, status: 200, body: { url: 'https://example.internal' } },
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 },
    }),
  ],
  edges: [
    { from: 'validate', to: 'build' },
    { from: 'build', to: 'test' },
    { from: 'test', to: 'security-check' },
    { from: 'security-check', to: 'package' },
    { from: 'package', to: 'deploy-staging' },
    { from: 'deploy-staging', to: 'smoke-test' },
    { from: 'smoke-test', to: 'deploy-production' },
  ],
  metadata: { category: 'ci-cd', demonstrates: 'sequential execution, conditional gate' },
};

/**
 * Order fulfilment — fan-out and fan-in.
 *
 * Demonstrates: two independent branches running concurrently on different workers, a
 * join that waits for both, and a node that reads the outputs of both parents.
 */
export const orderFulfilment: WorkflowDefinition = {
  key: 'order-fulfilment',
  name: 'Order Fulfilment',
  description:
    'Validates an order, then reserves inventory and authorises payment in parallel before shipping. Demonstrates fan-out and fan-in.',
  timeoutMs: 600_000,
  defaultRetryPolicy: DEFAULT_RETRY_POLICY,
  inputSchema: {
    orderId: 'string',
    amount: 'number — order total in minor units',
    items: 'array — line items',
  },
  output: {
    orderId: { from: '$.input.orderId' },
    shipmentId: { from: '$.tasks.prepare-shipment.output.result.shipmentId' },
  },
  nodes: [
    node('validate-order', 'validate', {
      x: 0,
      y: ROW,
      description: 'Structural validation of the order payload.',
      config: { required: ['orderId', 'amount'] },
      input: { payload: { from: '$.input' } },
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
    }),
    node('reserve-inventory', 'delay', {
      x: COL,
      y: 0,
      description: 'Hold stock for the order.',
      config: { durationMs: 800 },
    }),
    node('authorise-payment', 'http.echo', {
      x: COL,
      y: ROW * 2,
      description: 'Authorise the customer payment method.',
      config: { latencyMs: 600, status: 200, body: { authorised: true } },
      // Payment providers are the canonical flaky dependency; give it a real budget.
      retryPolicy: {
        ...DEFAULT_RETRY_POLICY,
        maxAttempts: 4,
        initialDelayMs: 500,
        multiplier: 2,
        // A declined card is deterministic — retrying it three times is pointless and
        // looks like fraud to the issuer.
        nonRetryableErrors: ['HTTP_402', 'HTTP_400'],
      },
    }),
    node('prepare-shipment', 'transform', {
      x: COL * 2,
      y: ROW,
      description: 'Join point: combines the inventory hold and the payment authorisation.',
      // Reads both parents — the validator enforces that both are declared dependencies.
      input: {
        source: { from: '$.input' },
        mapping: { value: { shipmentId: 'orderId', total: 'amount' } },
      },
    }),
    node('send-confirmation', 'http.echo', {
      x: COL * 3,
      y: ROW,
      description: 'Notify the customer.',
      config: { latencyMs: 300, status: 200 },
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 5, initialDelayMs: 250 },
    }),
  ],
  edges: [
    { from: 'validate-order', to: 'reserve-inventory' },
    { from: 'validate-order', to: 'authorise-payment' },
    { from: 'reserve-inventory', to: 'prepare-shipment' },
    { from: 'authorise-payment', to: 'prepare-shipment' },
    { from: 'prepare-shipment', to: 'send-confirmation' },
  ],
  metadata: { category: 'commerce', demonstrates: 'fan-out, fan-in, non-retryable errors' },
};

/**
 * Media pipeline — wide fan-out on a dedicated queue.
 *
 * Demonstrates: three concurrent branches, per-node queue routing (`media`), and a
 * conditional branch that is pruned rather than failed when the input says so.
 */
export const mediaPipeline: WorkflowDefinition = {
  key: 'media-pipeline',
  name: 'Media Processing Pipeline',
  description:
    'Ingests an upload then extracts metadata, generates a thumbnail and transcodes a preview concurrently. Demonstrates wide fan-out and queue routing.',
  timeoutMs: 900_000,
  defaultRetryPolicy: DEFAULT_RETRY_POLICY,
  inputSchema: { assetId: 'string', filename: 'string', generatePreview: 'boolean' },
  output: {
    assetId: { from: '$.input.assetId' },
    metadata: { from: '$.tasks.extract-metadata.output' },
  },
  nodes: [
    node('upload', 'delay', {
      x: 0,
      y: ROW,
      description: 'Receive and persist the source asset.',
      config: { durationMs: 600 },
    }),
    node('extract-metadata', 'compute', {
      x: COL,
      y: 0,
      queue: 'media',
      description: 'Probe the asset for codec and duration information.',
      config: { operation: 'sum', values: [1, 2, 3, 4] },
    }),
    node('generate-thumbnail', 'delay', {
      x: COL,
      y: ROW,
      queue: 'media',
      description: 'Render a poster frame.',
      config: { durationMs: 1_100 },
    }),
    node('transcode-preview', 'delay', {
      x: COL,
      y: ROW * 2,
      queue: 'media',
      description: 'Produce a low-bitrate preview. Skipped when not requested.',
      // A pruned branch: SKIPPED, and the join still completes.
      condition: '$.input.generatePreview == true',
      config: { durationMs: 1_800 },
      timeoutMs: 120_000,
    }),
    node('finalise', 'noop', {
      x: COL * 2,
      y: ROW,
      description: 'Join point: publishes the asset once every branch has resolved.',
    }),
  ],
  edges: [
    { from: 'upload', to: 'extract-metadata' },
    { from: 'upload', to: 'generate-thumbnail' },
    { from: 'upload', to: 'transcode-preview' },
    { from: 'extract-metadata', to: 'finalise' },
    { from: 'generate-thumbnail', to: 'finalise' },
    { from: 'transcode-preview', to: 'finalise' },
  ],
  metadata: { category: 'media', demonstrates: 'wide fan-out, queue routing, branch pruning' },
};

/**
 * Resilience demo — deliberately unreliable.
 *
 * This is the workflow the failure-recovery demo drives. `flaky-step` fails twice and
 * succeeds on its third attempt (a visible exponential backoff in the timeline), and
 * `always-fails` exhausts its budget and lands in the dead-letter queue.
 *
 * Uses the `simulate.*` handlers, which only exist when FORGE_DEMO_MODE=true.
 */
export const resilienceDemo: WorkflowDefinition = {
  key: 'resilience-demo',
  name: 'Resilience Demo',
  description:
    'Deliberately unreliable workflow used to demonstrate retries, exponential backoff, timeouts and the dead-letter queue.',
  timeoutMs: 300_000,
  defaultRetryPolicy: DEFAULT_RETRY_POLICY,
  inputSchema: { scenario: 'string — retry | timeout | dead-letter | crash' },
  output: {},
  nodes: [
    node('start', 'noop', { x: 0, y: ROW, description: 'Entry point.' }),
    node('flaky-step', 'simulate.flaky', {
      x: COL,
      y: 0,
      description: 'Fails twice, then succeeds — produces a real retry sequence.',
      config: { succeedOnAttempt: 3, durationMs: 200 },
      retryPolicy: {
        ...DEFAULT_RETRY_POLICY,
        maxAttempts: 5,
        initialDelayMs: 1_000,
        multiplier: 2,
        jitter: false, // Deterministic delays make the demo timeline legible.
      },
    }),
    node('slow-step', 'simulate.slow', {
      x: COL,
      y: ROW,
      description: 'Runs longer than one lease TTL, exercising lease renewal.',
      config: { durationMs: 20_000 },
      timeoutMs: 60_000,
    }),
    node('always-fails', 'simulate.fail', {
      x: COL,
      y: ROW * 2,
      description: 'Exhausts its retry budget and is dead-lettered.',
      config: { message: 'this task always fails, by design', code: 'SIMULATED_FAILURE' },
      retryPolicy: {
        ...DEFAULT_RETRY_POLICY,
        maxAttempts: 3,
        initialDelayMs: 500,
        multiplier: 2,
        jitter: false,
      },
    }),
    node('never-runs', 'noop', {
      x: COL * 2,
      y: ROW,
      description: 'Cancelled by failure propagation once `always-fails` is dead-lettered.',
    }),
  ],
  edges: [
    { from: 'start', to: 'flaky-step' },
    { from: 'start', to: 'slow-step' },
    { from: 'start', to: 'always-fails' },
    { from: 'flaky-step', to: 'never-runs' },
    { from: 'slow-step', to: 'never-runs' },
    { from: 'always-fails', to: 'never-runs' },
  ],
  metadata: {
    category: 'demo',
    demonstrates: 'retries, exponential backoff, dead letters, failure propagation',
    requiresDemoMode: true,
  },
};

/**
 * Crash-recovery demo.
 *
 * `crash-step` kills its worker mid-task with SIGKILL. The lease expires, the reaper
 * returns the task to the queue, another worker picks it up and the run completes. This
 * is the scenario `scripts/chaos-demo.ts` automates and `docs/system-design.md` walks
 * through.
 */
export const crashRecoveryDemo: WorkflowDefinition = {
  key: 'crash-recovery-demo',
  name: 'Crash Recovery Demo',
  description:
    'A worker is killed mid-task. The lease expires, the control plane requeues the work and another worker completes it.',
  timeoutMs: 300_000,
  defaultRetryPolicy: DEFAULT_RETRY_POLICY,
  inputSchema: {},
  output: { recovered: { from: '$.tasks.after-crash.output' } },
  nodes: [
    node('before-crash', 'delay', {
      x: 0,
      y: 0,
      description: 'Ordinary work that completes normally.',
      config: { durationMs: 400 },
    }),
    node('crash-step', 'simulate.crash', {
      x: COL,
      y: 0,
      description:
        'Kills its worker with SIGKILL on the first attempt. Recovery is driven by lease expiry; the recovered attempt completes normally.',
      config: { afterMs: 800, crashUntilAttempt: 1 },
      timeoutMs: 120_000,
      // Recovery does not consume the application retry budget, so a single attempt is
      // enough — the point is that the task survives the worker, not that it is retried.
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, initialDelayMs: 500 },
    }),
    node('after-crash', 'noop', {
      x: COL * 2,
      y: 0,
      description: 'Proves the run continued past the crash.',
    }),
  ],
  edges: [
    { from: 'before-crash', to: 'crash-step' },
    { from: 'crash-step', to: 'after-crash' },
  ],
  metadata: {
    category: 'demo',
    demonstrates: 'worker crash, lease expiry, task recovery',
    requiresDemoMode: true,
  },
};

/** Every demo workflow, in the order the seed installs them. */
export const DEMO_WORKFLOWS: WorkflowDefinition[] = [
  orderFulfilment,
  deploymentPipeline,
  mediaPipeline,
  resilienceDemo,
  crashRecoveryDemo,
];

/** Representative trigger payloads, used by the seed and the CLI's `--example` flag. */
export const DEMO_INPUTS: Record<string, Record<string, unknown>> = {
  'order-fulfilment': {
    orderId: 'ord_7f3a91',
    amount: 4999,
    items: [
      { sku: 'KB-87', qty: 1 },
      { sku: 'MS-11', qty: 2 },
    ],
  },
  'deployment-pipeline': { branch: 'main', commit: 'a3f91c2' },
  'media-pipeline': { assetId: 'asset_2291', filename: 'keynote.mov', generatePreview: true },
  'resilience-demo': { scenario: 'retry' },
  'crash-recovery-demo': {},
};
