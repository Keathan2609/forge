/**
 * Telemetry bootstrap.
 *
 * Imported first by main.ts, before any instrumentable module is loaded. The
 * OpenTelemetry auto-instrumentations patch module exports at require time, so a module
 * that has already been required cannot be instrumented afterwards.
 */
import { startTelemetry } from '@forge/observability';

startTelemetry({
  serviceName: 'forge-worker',
  serviceVersion: process.env.FORGE_VERSION ?? '0.1.0',
  namespace: process.env.OTEL_SERVICE_NAMESPACE ?? 'forge',
  ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }
    : {}),
  enabled: ['1', 'true', 'yes', 'on'].includes((process.env.OTEL_ENABLED ?? '').toLowerCase()),
});
