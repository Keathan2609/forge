import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry bootstrap.
 *
 * MUST be started before the application imports anything it wants instrumented — the
 * auto-instrumentations work by monkey-patching module exports, and a module already
 * required is already un-patchable. Every runtime therefore calls `startTelemetry()`
 * from a tiny `telemetry.ts` that is the first import in `main.ts`.
 */

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  namespace?: string;
  endpoint?: string;
  enabled?: boolean;
}

let sdk: NodeSDK | null = null;

export function startTelemetry(options: TelemetryOptions): void {
  if (options.enabled === false) return;
  if (sdk) return;

  const exporter = new OTLPTraceExporter({
    url: (options.endpoint ?? 'http://localhost:4318').replace(/\/$/, '') + '/v1/traces',
  });

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.1.0',
      'service.namespace': options.namespace ?? 'forge',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem spans drown out everything interesting and are never the answer to
        // "why was this workflow slow".
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // DNS lookups per Redis command are similarly pure noise.
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          // Health and metrics endpoints are scraped every few seconds; tracing them
          // would make the trace list unusable.
          ignoreIncomingRequestHook: (req) => {
            const url = req.url ?? '';
            return url.startsWith('/health') || url.startsWith('/metrics');
          },
        },
      }),
    ],
  });

  try {
    sdk.start();
  } catch (err) {
    // Telemetry is never allowed to prevent the service from starting.

    console.warn('[forge] telemetry failed to start: ' + (err as Error).message);
    sdk = null;
  }
}

/** Flush pending spans. Called from the shutdown path so a short-lived run is not lost. */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // Ignore: the process is going away regardless.
  } finally {
    sdk = null;
  }
}
