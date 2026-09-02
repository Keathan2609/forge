import {
  DEFAULT_RETRY_POLICY,
  WorkflowDefinitionSchema,
  type InputMapping,
  type RetryPolicy,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@forge/contracts';

/**
 * A fluent builder for workflow definitions.
 *
 * Writing the JSON by hand is entirely supported — the API takes a plain document — but
 * the builder catches the two mistakes that JSON cannot: referencing a node that does
 * not exist, and forgetting that reading another task's output requires depending on it.
 * Both are caught here, at the call site, rather than as a validation error from the
 * server after you have already written the whole file.
 *
 *   const workflow = defineWorkflow('order-fulfilment', 'Order Fulfilment')
 *     .task('validate', 'validate', { config: { required: ['orderId'] } })
 *     .task('charge', 'http.echo', { after: 'validate', retry: { maxAttempts: 4 } })
 *     .task('ship', 'noop', { after: ['charge'] })
 *     .output({ shipped: '$.tasks.ship.output' })
 *     .build();
 */

export interface TaskOptions {
  /** Dependencies. A string or array of node keys that must resolve first. */
  after?: string | string[];
  name?: string;
  description?: string;
  queue?: string;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  /** Static handler configuration. */
  config?: Record<string, unknown>;
  /**
   * Input mapping. A string value is shorthand for a context reference; wrap a constant
   * in `{ value }` when you want a literal that happens to look like a path.
   */
  input?: Record<string, string | { value: unknown }>;
  /** Guard expression; a falsy result marks the node SKIPPED rather than failed. */
  when?: string;
  metadata?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export class WorkflowBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowBuilderError';
  }
}

export class WorkflowBuilder {
  private readonly nodes: WorkflowNode[] = [];
  private readonly edges: Array<{ from: string; to: string; condition?: string }> = [];
  private definitionTimeout = 3_600_000;
  private defaultRetry: RetryPolicy = DEFAULT_RETRY_POLICY;
  private outputMapping: InputMapping = {};
  private inputSchemaDoc: Record<string, unknown> = {};
  private descriptionText: string | undefined;
  private metadataDoc: Record<string, unknown> = {};
  /** Auto-layout cursor, so a builder-authored graph opens tidily in the editor. */
  private column = 0;

  constructor(
    private readonly key: string,
    private readonly name: string,
  ) {}

  description(text: string): this {
    this.descriptionText = text;
    return this;
  }

  timeout(ms: number): this {
    this.definitionTimeout = ms;
    return this;
  }

  /** Retry policy inherited by tasks that do not set their own. */
  defaultRetryPolicy(policy: Partial<RetryPolicy>): this {
    this.defaultRetry = { ...DEFAULT_RETRY_POLICY, ...policy };
    return this;
  }

  inputSchema(schema: Record<string, unknown>): this {
    this.inputSchemaDoc = schema;
    return this;
  }

  metadata(data: Record<string, unknown>): this {
    this.metadataDoc = data;
    return this;
  }

  task(key: string, type: string, options: TaskOptions = {}): this {
    if (this.nodes.some((n) => n.key === key)) {
      throw new WorkflowBuilderError('duplicate task key "' + key + '"');
    }

    const dependencies = options.after
      ? Array.isArray(options.after)
        ? options.after
        : [options.after]
      : [];

    for (const dependency of dependencies) {
      if (!this.nodes.some((n) => n.key === dependency)) {
        // Caught here rather than at build() so the stack trace points at the offending
        // `.task()` call instead of the end of the chain.
        throw new WorkflowBuilderError(
          'task "' + key + '" depends on "' + dependency + '", which has not been defined yet',
        );
      }
    }

    const input: InputMapping = {};
    for (const [field, value] of Object.entries(options.input ?? {})) {
      input[field] = typeof value === 'string' ? { from: value } : value;
    }

    // Reading another task's output without depending on it is a race. The server
    // rejects it too; failing here gives a better message.
    for (const [field, mapping] of Object.entries(input)) {
      if (!('from' in mapping)) continue;
      const match = /^\$\.tasks\.([A-Za-z0-9_-]+)/.exec(mapping.from);
      if (match && !dependencies.includes(match[1] as string)) {
        throw new WorkflowBuilderError(
          'task "' +
            key +
            '" reads $.tasks.' +
            match[1] +
            ' in input "' +
            field +
            '" but does not declare it in `after` — add it, or the value may not exist when this task runs',
        );
      }
    }

    this.nodes.push({
      key,
      name: options.name ?? key,
      type,
      queue: options.queue ?? 'default',
      timeoutMs: options.timeoutMs ?? 60_000,
      retryPolicy: { ...this.defaultRetry, ...options.retry },
      config: options.config ?? {},
      input,
      metadata: options.metadata ?? {},
      ...(options.when ? { condition: options.when } : {}),
      ...(options.description ? { description: options.description } : {}),
      position: options.position ?? this.nextPosition(dependencies),
    });

    for (const dependency of dependencies) {
      this.edges.push({ from: dependency, to: key });
    }

    return this;
  }

  /** Add a conditional edge between two existing tasks. */
  edge(from: string, to: string, condition?: string): this {
    for (const key of [from, to]) {
      if (!this.nodes.some((n) => n.key === key)) {
        throw new WorkflowBuilderError('edge references unknown task "' + key + '"');
      }
    }
    const existing = this.edges.find((e) => e.from === from && e.to === to);
    if (existing) {
      if (condition) existing.condition = condition;
      return this;
    }
    this.edges.push({ from, to, ...(condition ? { condition } : {}) });
    return this;
  }

  /** Map task outputs into the run's output document. */
  output(mapping: Record<string, string | { value: unknown }>): this {
    for (const [field, value] of Object.entries(mapping)) {
      this.outputMapping[field] = typeof value === 'string' ? { from: value } : value;
    }
    return this;
  }

  /**
   * Produce the definition, validating it against the same schema the API uses.
   * A builder that produces an invalid document is a bug worth surfacing immediately.
   */
  build(): WorkflowDefinition {
    if (this.nodes.length === 0) {
      throw new WorkflowBuilderError('workflow "' + this.key + '" has no tasks');
    }

    const draft = {
      key: this.key,
      name: this.name,
      ...(this.descriptionText ? { description: this.descriptionText } : {}),
      timeoutMs: this.definitionTimeout,
      defaultRetryPolicy: this.defaultRetry,
      inputSchema: this.inputSchemaDoc,
      output: this.outputMapping,
      nodes: this.nodes,
      edges: this.edges,
      metadata: this.metadataDoc,
    };

    const result = WorkflowDefinitionSchema.safeParse(draft);
    if (!result.success) {
      throw new WorkflowBuilderError(
        'workflow "' +
          this.key +
          '" is not valid:\n' +
          result.error.issues
            .map((i) => '  - ' + (i.path.join('.') || '$') + ': ' + i.message)
            .join('\n'),
      );
    }
    return result.data;
  }

  /** Lay out a new node to the right of its deepest dependency. */
  private nextPosition(dependencies: string[]): { x: number; y: number } {
    if (dependencies.length === 0) {
      const y = this.nodes.filter((n) => (n.position?.x ?? 0) === 0).length * 130;
      return { x: 0, y };
    }
    const depth = Math.max(
      ...dependencies.map((d) => this.nodes.find((n) => n.key === d)?.position?.x ?? 0),
    );
    const x = depth + 260;
    const siblings = this.nodes.filter((n) => (n.position?.x ?? 0) === x).length;
    this.column = Math.max(this.column, x);
    return { x, y: siblings * 130 };
  }
}

export function defineWorkflow(key: string, name: string): WorkflowBuilder {
  return new WorkflowBuilder(key, name);
}
