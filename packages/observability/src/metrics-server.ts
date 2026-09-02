import { createServer, type Server } from 'node:http';
import type { ForgeMetrics } from './metrics';

/**
 * A minimal HTTP surface for processes that are not HTTP servers.
 *
 * The worker and the control plane are queue consumers, but Prometheus needs somewhere
 * to scrape and Docker/Kubernetes need somewhere to probe. Pulling in a web framework
 * for two endpoints would be the wrong trade, so this is the Node http module and
 * nothing else.
 */

export interface MetricsServerOptions {
  port: number;
  host?: string;
  metrics: ForgeMetrics;
  /** Reports readiness — used by the Docker healthcheck and the k8s readiness probe. */
  healthCheck?: () => Promise<{ ok: boolean; details?: Record<string, unknown> }>;
  onListening?: (port: number) => void;
}

export class MetricsServerError extends Error {
  constructor(
    readonly port: number,
    cause: Error,
  ) {
    super('metrics server could not bind to port ' + port + ': ' + cause.message);
    this.name = 'MetricsServerError';
  }
}

/**
 * Start the server, resolving once it is listening.
 *
 * Async rather than fire-and-forget so a bind failure (a port already taken by another
 * replica on the same host, say) surfaces as a startup error the caller can report and
 * exit on — rather than as an uncaught `EADDRINUSE` several seconds after the process
 * has claimed to be ready.
 */
export function startMetricsServerAsync(options: MetricsServerOptions): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = startMetricsServer(options);
    if (options.port <= 0) {
      resolve(server);
      return;
    }
    server.once('error', (err: Error) => reject(new MetricsServerError(options.port, err)));
    server.once('listening', () => resolve(server));
  });
}

export function startMetricsServer(options: MetricsServerOptions): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url.startsWith('/metrics')) {
      options.metrics.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': options.metrics.registry.contentType });
          res.end(body);
        })
        .catch((err: Error) => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('metrics collection failed: ' + err.message);
        });
      return;
    }

    if (url.startsWith('/health')) {
      const check =
        options.healthCheck ??
        (async (): Promise<{ ok: boolean; details?: Record<string, unknown> }> => ({ ok: true }));
      check()
        .then((result) => {
          res.writeHead(result.ok ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: result.ok ? 'ok' : 'degraded', ...result.details }));
        })
        .catch((err: Error) => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: err.message }));
        });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', available: ['/metrics', '/health'] }));
  });

  // Port 0 disables the server entirely, which is what the integration tests use so that
  // several worker instances can run in one process without fighting over a port.
  if (options.port > 0) {
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      options.onListening?.(options.port);
    });
  }

  return server;
}

export function stopMetricsServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // Don't let a lingering keep-alive connection hold shutdown open.
    server.closeAllConnections?.();
  });
}
