import type {
  DashboardStatsView,
  DeadLetterView,
  ExecutionEvent,
  Page,
  ScheduleView,
  SystemStatusView,
  TaskAttemptView,
  WorkerView,
  WorkflowDefinition,
  WorkflowRunView,
  WorkflowSummaryView,
  WorkflowVersionView,
} from '@forge/contracts';

/**
 * Console API access.
 *
 * Two base URLs, deliberately:
 *
 *   - server components render against `FORGE_API_INTERNAL_URL` (the API's address on
 *     the container network)
 *   - the browser talks to `NEXT_PUBLIC_FORGE_API_URL` (the API's address from outside)
 *
 * Conflating them is the classic containerised-frontend bug: SSR works, the browser
 * gets `http://api:4000`, and every client-side fetch fails with a DNS error.
 */

const SERVER_BASE =
  process.env.FORGE_API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_FORGE_API_URL ??
  'http://localhost:4000';

export const CLIENT_BASE = process.env.NEXT_PUBLIC_FORGE_API_URL ?? 'http://localhost:4000';

const API_KEY = process.env.FORGE_API_KEY_WEB ?? process.env.FORGE_API_KEY;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function baseUrl(): string {
  return typeof window === 'undefined' ? SERVER_BASE : CLIENT_BASE;
}

interface FetchOptions {
  method?: string;
  body?: unknown;
  /**
   * Server-component caching. Execution state changes constantly, so the default is
   * `no-store`: a cached run list in an operations console is worse than a slow one.
   */
  cache?: RequestCache;
  revalidate?: number;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // The key is only attached server-side; it must never reach the browser bundle.
  if (API_KEY && typeof window === 'undefined') headers['x-forge-api-key'] = API_KEY;

  const response = await fetch(baseUrl() + path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    cache: options.cache ?? 'no-store',
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.revalidate !== undefined ? { next: { revalidate: options.revalidate } } : {}),
  });

  if (!response.ok) {
    let detail: unknown;
    let message = response.statusText;
    try {
      const body = (await response.json()) as { message?: string; details?: unknown };
      message = body.message ?? message;
      detail = body.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, message, detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

export const forgeApi = {
  stats: (): Promise<DashboardStatsView> => api('/v1/system/stats'),
  status: (): Promise<SystemStatusView> => api('/v1/system/status'),

  workflows: (): Promise<{ items: WorkflowSummaryView[] }> => api('/v1/workflows'),

  workflow: (
    key: string,
    version?: number,
  ): Promise<{
    key: string;
    name: string;
    version: number;
    definition: WorkflowDefinition;
    analysis: { nodes: number; edges: number; entryNodes: string[]; criticalPath: number };
  }> => api('/v1/workflows/' + encodeURIComponent(key) + (version ? '?version=' + version : '')),

  versions: (key: string): Promise<{ items: WorkflowVersionView[] }> =>
    api('/v1/workflows/' + encodeURIComponent(key) + '/versions'),

  validateWorkflow: (
    definition: WorkflowDefinition,
  ): Promise<{
    valid: boolean;
    errors: Array<{ code: string; message: string; target: string }>;
    warnings: Array<{ code: string; message: string; target: string }>;
    analysis?: { nodes: number; edges: number; entryNodes: string[]; criticalPath: number };
  }> => api('/v1/workflows/validate', { method: 'POST', body: definition }),

  saveWorkflow: (
    definition: WorkflowDefinition,
    changelog?: string,
  ): Promise<{ key: string; version: number; created: boolean }> =>
    api('/v1/workflows', { method: 'POST', body: { definition, changelog } }),

  runs: (
    query: Record<string, string | number | undefined> = {},
  ): Promise<Page<WorkflowRunView>> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return api('/v1/runs' + (qs ? '?' + qs : ''));
  },

  run: (id: string): Promise<WorkflowRunView> => api('/v1/runs/' + id),

  runEvents: (id: string, afterSeq?: number): Promise<{ items: ExecutionEvent[] }> =>
    api('/v1/runs/' + id + '/events' + (afterSeq ? '?afterSeq=' + afterSeq : '')),

  taskAttempts: async (taskRunId: string): Promise<TaskAttemptView[]> => {
    const body = await api<{ items: TaskAttemptView[] }>('/v1/tasks/' + taskRunId + '/attempts');
    return body.items;
  },

  trigger: (
    key: string,
    input: Record<string, unknown>,
  ): Promise<{ runId: string; version: number; created: boolean }> =>
    api('/v1/workflows/' + encodeURIComponent(key) + '/runs', {
      method: 'POST',
      body: { input, metadata: { source: 'console' } },
    }),

  cancelRun: (id: string, reason?: string): Promise<{ accepted: boolean; message: string }> =>
    api('/v1/runs/' + id + '/cancel', { method: 'POST', body: { reason } }),

  replayRun: (id: string, useLatestVersion = false): Promise<{ runId: string; version: number }> =>
    api('/v1/runs/' + id + '/replay', { method: 'POST', body: { useLatestVersion } }),

  workers: (): Promise<{ items: WorkerView[] }> => api('/v1/workers'),

  deadLetters: (status = 'OPEN'): Promise<Page<DeadLetterView>> =>
    api('/v1/dead-letters?status=' + status + '&limit=50'),

  retryDeadLetter: (id: string): Promise<{ retried: boolean }> =>
    api('/v1/dead-letters/' + id + '/retry', { method: 'POST', body: { resetAttempts: true } }),

  acknowledgeDeadLetter: (id: string): Promise<{ acknowledged: boolean }> =>
    api('/v1/dead-letters/' + id + '/acknowledge', { method: 'POST' }),

  schedules: (): Promise<{ items: ScheduleView[] }> => api('/v1/schedules'),

  setScheduleEnabled: (id: string, enabled: boolean): Promise<{ updated: boolean }> =>
    api('/v1/schedules/' + id, { method: 'PATCH', body: { enabled } }),
};
