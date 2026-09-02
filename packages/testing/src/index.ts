import {
  DEFAULT_RETRY_POLICY,
  type TaskRunState,
  WorkflowRunState,
  type RetryPolicy,
  type WorkflowDefinition,
  type RunSnapshot,
  type TaskSnapshot,
  type WorkflowNode,
} from '@forge/contracts';

/**
 * Test fixtures shared across the engine, worker, scheduler and API suites.
 *
 * Kept in a package rather than duplicated per-suite so that a change to the workflow
 * schema breaks every consumer at compile time instead of leaving stale copies behind.
 */

let nodeCounter = 0;

export function makeNode(key: string, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  nodeCounter += 1;
  return {
    key,
    name: overrides.name ?? key,
    type: overrides.type ?? 'noop',
    queue: overrides.queue ?? 'default',
    timeoutMs: overrides.timeoutMs ?? 30_000,
    retryPolicy: overrides.retryPolicy ?? DEFAULT_RETRY_POLICY,
    config: overrides.config ?? {},
    input: overrides.input ?? {},
    metadata: overrides.metadata ?? {},
    ...(overrides.condition ? { condition: overrides.condition } : {}),
    ...(overrides.description ? { description: overrides.description } : {}),
    position: overrides.position ?? { x: nodeCounter * 220, y: 0 },
  };
}

export interface DefinitionSpec {
  key?: string;
  name?: string;
  timeoutMs?: number;
  nodes: Array<string | WorkflowNode>;
  /** `["a->b", "b->c"]` or explicit edge objects. */
  edges?: Array<string | { from: string; to: string; condition?: string }>;
}

export function makeDefinition(spec: DefinitionSpec): WorkflowDefinition {
  return {
    key: spec.key ?? 'test-workflow',
    name: spec.name ?? 'Test workflow',
    timeoutMs: spec.timeoutMs ?? 600_000,
    defaultRetryPolicy: DEFAULT_RETRY_POLICY,
    inputSchema: {},
    output: {},
    nodes: spec.nodes.map((n) => (typeof n === 'string' ? makeNode(n) : n)),
    edges: (spec.edges ?? []).map((e) => {
      if (typeof e !== 'string') return e;
      const [from, to] = e.split('->').map((s) => s.trim());
      return { from: from as string, to: to as string };
    }),
    metadata: {},
  };
}

export function makeRunSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  // Defaults to "now" so a test that does not care about timing never accidentally
  // trips the run-timeout branch. Tests that assert timing pass explicit dates.
  const createdAt = overrides.createdAt ?? new Date();
  return {
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    workflowKey: overrides.workflowKey ?? 'test-workflow',
    version: overrides.version ?? 1,
    state: overrides.state ?? WorkflowRunState.RUNNING,
    input: overrides.input ?? {},
    metadata: overrides.metadata ?? {},
    startedAt: overrides.startedAt ?? createdAt,
    createdAt,
    timeoutMs: overrides.timeoutMs ?? 600_000,
  };
}

export function makeTasks(
  states: Record<string, TaskRunState>,
  overrides: Record<string, Partial<TaskSnapshot>> = {},
): TaskSnapshot[] {
  return Object.entries(states).map(([nodeKey, state]) => ({
    nodeKey,
    state,
    output: overrides[nodeKey]?.output ?? null,
    attempts: overrides[nodeKey]?.attempts ?? 0,
    error: overrides[nodeKey]?.error ?? null,
    nextAttemptAt: overrides[nodeKey]?.nextAttemptAt ?? null,
  }));
}

export function retryPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...overrides };
}

/** Deterministic RNG for asserting jitter windows without flakiness. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32 — small, fast, and reproducible across platforms.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/** A controllable clock for tests that assert timing without sleeping. */
export class TestClock {
  constructor(private current: Date = new Date('2026-01-01T00:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }

  set(date: Date): void {
    this.current = date;
  }
}

/** Poll until `predicate` is true or the budget expires. Used by integration tests. */
export async function waitFor<T>(
  predicate: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result as T;
    last = result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    'timed out after ' +
      timeoutMs +
      'ms waiting for ' +
      (options.description ?? 'condition') +
      ' (last value: ' +
      JSON.stringify(last) +
      ')',
  );
}

export const FIXTURES = {
  /** a -> b -> c */
  linear: (): WorkflowDefinition =>
    makeDefinition({ key: 'linear', nodes: ['a', 'b', 'c'], edges: ['a->b', 'b->c'] }),

  /** root fans out to left/right, which fan back into join. */
  diamond: (): WorkflowDefinition =>
    makeDefinition({
      key: 'diamond',
      nodes: ['root', 'left', 'right', 'join'],
      edges: ['root->left', 'root->right', 'left->join', 'right->join'],
    }),

  /** A graph containing a cycle; must be rejected. */
  cyclic: (): WorkflowDefinition =>
    makeDefinition({
      key: 'cyclic',
      nodes: ['a', 'b', 'c'],
      edges: ['a->b', 'b->c', 'c->a'],
    }),
};
