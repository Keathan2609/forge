/**
 * Stream a run's events live.
 *
 * The subscription reconnects on its own and resumes from the last sequence number seen,
 * so a dropped connection produces no gap — the server replays exactly what was missed.
 *
 *   pnpm tsx examples/sdk/stream-events.ts [workflowKey]
 */
import { ForgeClient } from '@forge/sdk';

const forge = new ForgeClient({
  baseUrl: process.env.FORGE_API_URL ?? 'http://localhost:4000',
  ...(process.env.FORGE_API_KEY ? { apiKey: process.env.FORGE_API_KEY } : {}),
});

async function main(): Promise<void> {
  const workflowKey = process.argv[2] ?? 'media-pipeline';

  const { runId } = await forge.workflows.trigger(workflowKey, {
    assetId: 'asset_stream_example',
    filename: 'demo.mov',
    generatePreview: true,
  });
  console.log('watching ' + runId + '\n');

  const stop = forge.streamRun(runId, {
    onOpen: () => console.log('[stream open]'),
    onEvent: (event) => {
      const time = new Date(event.occurredAt).toISOString().slice(11, 23);
      console.log(
        time +
          '  ' +
          String(event.seq).padStart(3) +
          '  ' +
          event.type.padEnd(22) +
          (event.nodeKey ?? '').padEnd(20) +
          (event.message ?? ''),
      );
    },
    onError: (err) => console.warn('[stream error, will reconnect]', err.message),
  });

  try {
    // Polling for completion alongside the stream is deliberate: the stream tells you
    // what happened, the poll tells you when it is over. Relying on the stream alone
    // means a dropped connection at the wrong moment hangs forever.
    const run = await forge.runs.wait(runId, { timeoutMs: 120_000 });
    console.log('\n' + run.state + ' in ' + run.durationMs + 'ms');
  } finally {
    stop();
  }
}

void main().catch((err: unknown) => {
  console.error('failed:', (err as Error).message);
  process.exit(1);
});
