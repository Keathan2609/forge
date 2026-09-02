/**
 * Idempotent triggering.
 *
 * Fires the same trigger five times concurrently with one idempotency key and shows that
 * exactly one run is created. This is the behaviour a client depends on when it retries a
 * request that timed out — it must not create a second run.
 *
 *   pnpm tsx examples/sdk/idempotent-trigger.ts
 */
import { ForgeClient, ForgeApiError } from '@forge/sdk';

const forge = new ForgeClient({
  baseUrl: process.env.FORGE_API_URL ?? 'http://localhost:4000',
  ...(process.env.FORGE_API_KEY ? { apiKey: process.env.FORGE_API_KEY } : {}),
});

async function main(): Promise<void> {
  const key = 'example-' + Date.now();
  const input = { orderId: 'ord_idempotent', amount: 1234, items: [] };

  console.log('firing 5 concurrent triggers with idempotency key "' + key + '"\n');

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      forge.workflows.trigger('order-fulfilment', input, { idempotencyKey: key }),
    ),
  );

  for (const [index, result] of results.entries()) {
    console.log(
      '  request ' +
        (index + 1) +
        ': ' +
        result.runId +
        (result.created ? '  ← created' : '  (existing run returned)'),
    );
  }

  const unique = new Set(results.map((r) => r.runId));
  console.log('\n' + unique.size + ' distinct run(s) created from 5 requests');
  if (unique.size !== 1) {
    console.error('expected exactly 1');
    process.exit(1);
  }

  // Reusing the key with a *different* body is a client bug. Silently returning the
  // original run would hide it, so the API rejects it.
  console.log('\nreusing the same key with a different body:');
  try {
    await forge.workflows.trigger(
      'order-fulfilment',
      { orderId: 'ord_different', amount: 9999, items: [] },
      { idempotencyKey: key },
    );
    console.error('  expected a 409');
    process.exit(1);
  } catch (err) {
    if (err instanceof ForgeApiError && err.status === 409) {
      console.log('  ✓ rejected with 409: ' + err.message);
    } else {
      throw err;
    }
  }
}

void main().catch((err: unknown) => {
  console.error('failed:', (err as Error).message);
  process.exit(1);
});
