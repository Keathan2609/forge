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
 * The FORGE HTTP client.
 *
 * Design goals, in order: the types are the API's own contracts (no hand-maintained
 * duplicates that can drift), errors are typed and carry the server's detail, and
 * anything that can hang has a deadline. Nothing here is generated — a generated client
 * would not have `waitForRun`, and `waitForRun` is the method people actually want.
 */

export interface ForgeClientOptions {
  /** e.g. `http://localhost:4000` */
  baseUrl: string;
  apiKey?: string;
  /** Per-request timeout. Streaming calls are exempt. */
  timeoutMs?: number;
  /** Retries for idempotent (GET) requests only. */
  retries?: number;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

export class ForgeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ForgeApiError';
  }

  /** True when retrying the same request might succeed. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

export class ForgeTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly operation: string,
  ) {
    super(operation + ' timed out after ' + timeoutMs + 'ms');
    this.name = 'ForgeTimeoutError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** GETs are safe to retry; mutations are not, unless they carry an idempotency key. */
  retryable?: boolean;
  signal?: AbortSignal;
}

export class ForgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  readonly workflows: WorkflowsResource;
  readonly runs: RunsResource;
  readonly workers: WorkersResource;
  readonly deadLetters: DeadLettersResource;
  readonly schedules: SchedulesResource;
  readonly system: SystemResource;

  constructor(private readonly options: ForgeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 2;

    this.workflows = new WorkflowsResource(this);
    this.runs = new RunsResource(this);
    this.workers = new WorkersResource(this);
    this.deadLetters = new DeadLettersResource(this);
    this.schedules = new SchedulesResource(this);
    this.system = new SystemResource(this);
  }

  /** Issue a request. Public so resources can use it; not part of the intended surface. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.options.headers,
      ...options.headers,
    };
    if (this.options.apiKey) headers['x-forge-api-key'] = this.options.apiKey;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const attempts = options.retryable === false ? 1 : this.retries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // Honour a caller-supplied signal as well as the timeout.
      const onExternalAbort = (): void => controller.abort();
      options.signal?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        const response = await this.fetchImpl(url.toString(), {
          method: options.method ?? 'GET',
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await this.toApiError(response);
          // Only retry when the server says the condition is transient; retrying a 400
          // just produces the same 400 more slowly.
          if (error.retryable && attempt < attempts) {
            lastError = error;
            await backoff(attempt);
            continue;
          }
          throw error;
        }

        if (response.status === 204) return undefined as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      } catch (err) {
        if (err instanceof ForgeApiError) throw err;
        if ((err as Error).name === 'AbortError') {
          if (options.signal?.aborted) throw err;
          throw new ForgeTimeoutError(timeoutMs, (options.method ?? 'GET') + ' ' + path);
        }
        // Network-level failure: worth one more try for a safe request.
        lastError = err;
        if (attempt < attempts) {
          await backoff(attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onExternalAbort);
      }
    }

    throw lastError;
  }

  private async toApiError(response: Response): Promise<ForgeApiError> {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      /* a non-JSON error body is still an error */
    }
    return new ForgeApiError(
      response.status,
      String(body.error ?? 'HttpError'),
      String(body.message ?? response.statusText),
      body.details,
      String(body.requestId ?? response.headers.get('x-request-id') ?? ''),
    );
  }

  /**
   * Subscribe to a run's events over SSE.
   *
   * Reconnects automatically and resumes from the last sequence number seen, so a
   * dropped connection produces no gap in the caller's view. Returns an unsubscribe
   * function.
   */
  streamRun(
    runId: string,
    handlers: {
      onEvent: (event: ExecutionEvent) => void;
      onError?: (err: Error) => void;
      onOpen?: () => void;
    },
    options: { afterSeq?: number } = {},
  ): () => void {
    let closed = false;
    let lastSeq = options.afterSeq ?? 0;
    let controller: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async (): Promise<void> => {
      if (closed) return;
      controller = new AbortController();

      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (this.options.apiKey) headers['x-forge-api-key'] = this.options.apiKey;
      if (lastSeq > 0) headers['last-event-id'] = String(lastSeq);

      try {
        const response = await this.fetchImpl(this.baseUrl + '/v1/runs/' + runId + '/stream', {
          headers,
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error('stream failed with status ' + response.status);
        }
        handlers.onOpen?.();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('');
            if (data) {
              try {
                const event = JSON.parse(data) as ExecutionEvent;
                lastSeq = Math.max(lastSeq, event.seq);
                handlers.onEvent(event);
              } catch {
                /* ignore a malformed frame rather than tearing down the stream */
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (err) {
        if (closed) return;
        handlers.onError?.(err as Error);
      }

      // Reconnect and resume from `lastSeq`; the server replays what was missed.
      if (!closed) {
        reconnectTimer = setTimeout(() => void connect(), 2_000);
      }
    };

    void connect();

    return (): void => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller?.abort();
    };
  }
}

function backoff(attempt: number): Promise<void> {
  const delay = Math.min(2_000, 100 * Math.pow(2, attempt - 1));
  return new Promise((r) => setTimeout(r, delay + Math.random() * 100));
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

class WorkflowsResource {
  constructor(private readonly client: ForgeClient) {}

  async list(): Promise<WorkflowSummaryView[]> {
    const result = await this.client.request<{ items: WorkflowSummaryView[] }>('/v1/workflows');
    return result.items;
  }

  async get(
    key: string,
    version?: number,
  ): Promise<{
    key: string;
    name: string;
    version: number;
    definition: WorkflowDefinition;
    analysis: { nodes: number; edges: number; entryNodes: string[]; criticalPath: number };
  }> {
    return this.client.request('/v1/workflows/' + encodeURIComponent(key), {
      query: version === undefined ? {} : { version },
    });
  }

  async versions(key: string): Promise<WorkflowVersionView[]> {
    const result = await this.client.request<{ items: WorkflowVersionView[] }>(
      '/v1/workflows/' + encodeURIComponent(key) + '/versions',
    );
    return result.items;
  }

  /** Save a definition. Idempotent by content: an unchanged graph reuses its version. */
  async create(
    definition: WorkflowDefinition,
    options: { changelog?: string } = {},
  ): Promise<{ key: string; version: number; created: boolean; checksum: string }> {
    return this.client.request('/v1/workflows', {
      method: 'POST',
      body: { definition, ...(options.changelog ? { changelog: options.changelog } : {}) },
      retryable: false,
    });
  }

  /** Validate without saving — what the DAG editor calls while you draw. */
  async validate(definition: WorkflowDefinition): Promise<{
    valid: boolean;
    errors: Array<{ code: string; message: string; target: string }>;
    warnings: Array<{ code: string; message: string; target: string }>;
  }> {
    return this.client.request('/v1/workflows/validate', {
      method: 'POST',
      body: definition,
      retryable: false,
    });
  }

  /** Trigger a run. Returns as soon as the run is durable — it does not wait for it. */
  async trigger(
    key: string,
    input: Record<string, unknown> = {},
    options: { version?: number; idempotencyKey?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<{ runId: string; version: number; created: boolean }> {
    return this.client.request('/v1/workflows/' + encodeURIComponent(key) + '/runs', {
      method: 'POST',
      body: {
        input,
        ...(options.version !== undefined ? { version: options.version } : {}),
        metadata: options.metadata ?? {},
      },
      // With an idempotency key the request *is* safe to retry — that is the point.
      ...(options.idempotencyKey
        ? { headers: { 'idempotency-key': options.idempotencyKey }, retryable: true }
        : { retryable: false }),
    });
  }
}

class RunsResource {
  constructor(private readonly client: ForgeClient) {}

  async list(
    options: {
      workflowKey?: string;
      state?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<Page<WorkflowRunView>> {
    return this.client.request('/v1/runs', { query: options });
  }

  async get(runId: string): Promise<WorkflowRunView> {
    return this.client.request('/v1/runs/' + runId);
  }

  async events(runId: string, afterSeq?: number): Promise<ExecutionEvent[]> {
    const result = await this.client.request<{ items: ExecutionEvent[] }>(
      '/v1/runs/' + runId + '/events',
      { query: afterSeq === undefined ? {} : { afterSeq } },
    );
    return result.items;
  }

  async attempts(taskRunId: string): Promise<TaskAttemptView[]> {
    const result = await this.client.request<{ items: TaskAttemptView[] }>(
      '/v1/tasks/' + taskRunId + '/attempts',
    );
    return result.items;
  }

  async cancel(runId: string, reason?: string): Promise<{ accepted: boolean; message: string }> {
    return this.client.request('/v1/runs/' + runId + '/cancel', {
      method: 'POST',
      body: reason === undefined ? {} : { reason },
      retryable: false,
    });
  }

  async replay(
    runId: string,
    options: { useLatestVersion?: boolean; input?: Record<string, unknown> } = {},
  ): Promise<{ runId: string; version: number; replayOf: string }> {
    return this.client.request('/v1/runs/' + runId + '/replay', {
      method: 'POST',
      body: {
        useLatestVersion: options.useLatestVersion ?? false,
        ...(options.input ? { input: options.input } : {}),
      },
      retryable: false,
    });
  }

  /**
   * Block until a run reaches a terminal state.
   *
   * Polls rather than streams because a caller that just wants the result should not
   * have to keep an SSE connection alive — and because polling degrades gracefully
   * through proxies that buffer event streams. Backs off from 250ms to 2s so a fast run
   * returns promptly without a slow one hammering the API.
   */
  async wait(
    runId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<WorkflowRunView> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;
    let interval = options.pollIntervalMs ?? 250;

    for (;;) {
      const run = await this.get(runId);
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state)) return run;

      if (Date.now() >= deadline) {
        throw new ForgeTimeoutError(timeoutMs, 'waiting for run ' + runId);
      }
      if (options.signal?.aborted) throw new Error('wait aborted');

      await new Promise((r) => setTimeout(r, interval));
      if (!options.pollIntervalMs) interval = Math.min(2_000, Math.round(interval * 1.5));
    }
  }

  /** Trigger and wait, in one call. */
  async triggerAndWait(
    workflowKey: string,
    input: Record<string, unknown> = {},
    options: { timeoutMs?: number; idempotencyKey?: string; version?: number } = {},
  ): Promise<WorkflowRunView> {
    const client = this.client as ForgeClient;
    const triggered = await client.workflows.trigger(workflowKey, input, {
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.version !== undefined ? { version: options.version } : {}),
    });
    return this.wait(triggered.runId, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
}

class WorkersResource {
  constructor(private readonly client: ForgeClient) {}

  async list(): Promise<WorkerView[]> {
    const result = await this.client.request<{ items: WorkerView[] }>('/v1/workers');
    return result.items;
  }
}

class DeadLettersResource {
  constructor(private readonly client: ForgeClient) {}

  async list(
    options: { status?: string; limit?: number; cursor?: string } = {},
  ): Promise<Page<DeadLetterView>> {
    return this.client.request('/v1/dead-letters', { query: options });
  }

  async retry(
    id: string,
    options: { resetAttempts?: boolean; input?: Record<string, unknown> } = {},
  ): Promise<{ retried: boolean; taskRunId?: string; workflowRunId?: string }> {
    return this.client.request('/v1/dead-letters/' + id + '/retry', {
      method: 'POST',
      body: {
        resetAttempts: options.resetAttempts ?? true,
        ...(options.input ? { input: options.input } : {}),
      },
      retryable: false,
    });
  }

  async acknowledge(id: string): Promise<{ acknowledged: boolean }> {
    return this.client.request('/v1/dead-letters/' + id + '/acknowledge', {
      method: 'POST',
      retryable: false,
    });
  }
}

class SchedulesResource {
  constructor(private readonly client: ForgeClient) {}

  async list(): Promise<ScheduleView[]> {
    const result = await this.client.request<{ items: ScheduleView[] }>('/v1/schedules');
    return result.items;
  }

  async create(schedule: {
    workflowKey: string;
    name: string;
    cron?: string;
    runAt?: string;
    timezone?: string;
    input?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<{ id: string; nextRunAt: string | null }> {
    return this.client.request('/v1/schedules', {
      method: 'POST',
      body: { timezone: 'UTC', input: {}, enabled: true, ...schedule },
      retryable: false,
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<{ updated: boolean }> {
    return this.client.request('/v1/schedules/' + id, {
      method: 'PATCH',
      body: { enabled },
      retryable: false,
    });
  }
}

class SystemResource {
  constructor(private readonly client: ForgeClient) {}

  async status(): Promise<SystemStatusView> {
    return this.client.request('/v1/system/status');
  }

  async stats(): Promise<DashboardStatsView> {
    return this.client.request('/v1/system/stats');
  }

  async health(): Promise<{ status: string; version: string; uptimeSeconds: number }> {
    return this.client.request('/health');
  }
}
