import type { Logger } from '@forge/logger';

/**
 * Task handler registry.
 *
 * A node's `type` is a *key into this map*, never anything the worker interprets, spawns
 * or evaluates. A workflow definition therefore cannot cause code execution: the worst a
 * malicious definition achieves is naming a type nothing has registered, which fails the
 * task with `UNKNOWN_HANDLER` and never reaches a shell, a module loader or an eval.
 * That constraint is why FORGE can accept workflow definitions over an HTTP API at all.
 */

export interface TaskContext {
  workflowRunId: string;
  taskRunId: string;
  workflowKey: string;
  nodeKey: string;
  attempt: number;
  workerId: string;
  logger: Logger;
  /** Aborts when the task times out, the lease is lost, or the run is cancelled. */
  signal: AbortSignal;
  /** Report intermediate progress; surfaced on the run timeline. */
  progress: (percent: number, message?: string) => void;
  /** Resolves true once cancellation has been requested. */
  isCancelled: () => boolean;
}

export type TaskHandler = (
  input: Record<string, unknown>,
  context: TaskContext,
) => Promise<unknown>;

export interface HandlerDefinition {
  type: string;
  description: string;
  handler: TaskHandler;
  /** Only registered when the process is running in demo mode. */
  demoOnly?: boolean;
}

export class UnknownHandlerError extends Error {
  readonly code = 'UNKNOWN_HANDLER';
  constructor(
    readonly type: string,
    readonly available: string[],
  ) {
    super(
      'no handler registered for task type "' +
        type +
        '" (this worker advertises: ' +
        (available.length > 0 ? available.join(', ') : 'none') +
        ')',
    );
    this.name = 'UnknownHandlerError';
  }
}

/**
 * A task that failed for a reason retrying cannot fix.
 *
 * Handlers throw this for deterministic failures (bad input, a 4xx from a downstream
 * service) so the retry policy can skip the budget entirely rather than burning three
 * attempts on a certainty.
 */
export class NonRetryableError extends Error {
  constructor(
    message: string,
    readonly code = 'NON_RETRYABLE',
  ) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export class HandlerRegistry {
  private readonly handlers = new Map<string, HandlerDefinition>();

  constructor(private readonly options: { demoMode: boolean; logger: Logger }) {}

  register(definition: HandlerDefinition): this {
    if (definition.demoOnly && !this.options.demoMode) {
      this.options.logger.debug(
        { type: definition.type },
        'skipping demo-only handler (FORGE_DEMO_MODE is off)',
      );
      return this;
    }
    if (this.handlers.has(definition.type)) {
      throw new Error('handler "' + definition.type + '" is already registered');
    }
    this.handlers.set(definition.type, definition);
    return this;
  }

  registerAll(definitions: HandlerDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  /**
   * Restrict the registry to the types this worker is configured to advertise.
   *
   * Lets one image serve several worker pools: a `media` pool advertises only the
   * transcode handlers, so the control plane never routes a payment task to it.
   */
  restrictTo(types: string[]): this {
    if (types.length === 0) return this;
    const allowed = new Set(types);
    for (const type of [...this.handlers.keys()]) {
      if (!allowed.has(type)) this.handlers.delete(type);
    }
    for (const type of allowed) {
      if (!this.handlers.has(type)) {
        this.options.logger.warn(
          { type },
          'configured capability has no registered handler and will not be advertised',
        );
      }
    }
    return this;
  }

  get(type: string): HandlerDefinition {
    const handler = this.handlers.get(type);
    if (!handler) throw new UnknownHandlerError(type, this.types());
    return handler;
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  /** The capability list advertised to the control plane. */
  types(): string[] {
    return [...this.handlers.keys()].sort();
  }

  describe(): Array<{ type: string; description: string }> {
    return [...this.handlers.values()].map((h) => ({ type: h.type, description: h.description }));
  }
}
