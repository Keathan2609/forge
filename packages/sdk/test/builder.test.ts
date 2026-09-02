import { describe, expect, it } from 'vitest';
import { WorkflowBuilderError, defineWorkflow } from '../src';

/**
 * The workflow builder.
 *
 * Its value over hand-written JSON is catching, at the call site, the two mistakes the
 * JSON format cannot express: depending on a task that does not exist, and reading a
 * task's output without declaring the dependency. The second is a genuine race, not a
 * style preference — without the edge there is no guarantee the value exists yet.
 */

describe('defineWorkflow', () => {
  it('builds a valid linear workflow', () => {
    const workflow = defineWorkflow('orders', 'Orders')
      .task('validate', 'validate')
      .task('charge', 'http.echo', { after: 'validate' })
      .build();

    expect(workflow.key).toBe('orders');
    expect(workflow.nodes).toHaveLength(2);
    expect(workflow.edges).toEqual([{ from: 'validate', to: 'charge' }]);
  });

  it('supports fan-out and fan-in', () => {
    const workflow = defineWorkflow('diamond', 'Diamond')
      .task('root', 'noop')
      .task('left', 'noop', { after: 'root' })
      .task('right', 'noop', { after: 'root' })
      .task('join', 'noop', { after: ['left', 'right'] })
      .build();

    expect(workflow.edges).toHaveLength(4);
    expect(workflow.edges.filter((e) => e.to === 'join')).toHaveLength(2);
  });

  it('rejects a dependency on a task that has not been defined', () => {
    // Caught here rather than at build(), so the stack trace points at the offending
    // `.task()` call instead of the end of the chain.
    expect(() => defineWorkflow('bad', 'Bad').task('a', 'noop', { after: 'nonexistent' })).toThrow(
      WorkflowBuilderError,
    );
  });

  it('rejects a duplicate task key', () => {
    expect(() => defineWorkflow('dupe', 'Dupe').task('a', 'noop').task('a', 'noop')).toThrow(
      /duplicate task key/,
    );
  });

  it('rejects reading a task output without depending on it', () => {
    expect(() =>
      defineWorkflow('race', 'Race')
        .task('producer', 'noop')
        .task('consumer', 'noop', { input: { value: '$.tasks.producer.output.v' } }),
    ).toThrow(/does not declare it in `after`/);
  });

  it('accepts reading a task output when the dependency is declared', () => {
    const workflow = defineWorkflow('safe', 'Safe')
      .task('producer', 'noop')
      .task('consumer', 'noop', {
        after: 'producer',
        input: { value: '$.tasks.producer.output.v' },
      })
      .build();

    expect(workflow.nodes[1]?.input.value).toEqual({ from: '$.tasks.producer.output.v' });
  });

  it('accepts reading a hyphenated task key', () => {
    // Node keys are slugs; the reference syntax has to cope with that.
    const workflow = defineWorkflow('slug', 'Slug')
      .task('prepare-shipment', 'noop')
      .task('notify', 'noop', {
        after: 'prepare-shipment',
        input: { id: '$.tasks.prepare-shipment.output.id' },
      })
      .build();

    expect(workflow.edges).toEqual([{ from: 'prepare-shipment', to: 'notify' }]);
  });

  it('distinguishes a reference from a literal', () => {
    const workflow = defineWorkflow('lit', 'Literal')
      .task('a', 'noop', { input: { ref: '$.input.x', constant: { value: '$.not.a.ref' } } })
      .build();

    expect(workflow.nodes[0]?.input.ref).toEqual({ from: '$.input.x' });
    expect(workflow.nodes[0]?.input.constant).toEqual({ value: '$.not.a.ref' });
  });

  it('merges the default retry policy with per-task overrides', () => {
    const workflow = defineWorkflow('retry', 'Retry')
      .defaultRetryPolicy({ maxAttempts: 5 })
      .task('a', 'noop')
      .task('b', 'noop', { retry: { initialDelayMs: 250 } })
      .build();

    expect(workflow.nodes[0]?.retryPolicy.maxAttempts).toBe(5);
    expect(workflow.nodes[1]?.retryPolicy.maxAttempts).toBe(5);
    expect(workflow.nodes[1]?.retryPolicy.initialDelayMs).toBe(250);
  });

  it('lays nodes out left to right by dependency depth', () => {
    // So a workflow authored through the SDK opens as a readable graph rather than a
    // pile at the origin.
    const workflow = defineWorkflow('layout', 'Layout')
      .task('a', 'noop')
      .task('b', 'noop', { after: 'a' })
      .task('c', 'noop', { after: 'b' })
      .build();

    const x = workflow.nodes.map((n) => n.position?.x ?? 0);
    expect(x[0]).toBeLessThan(x[1] as number);
    expect(x[1]).toBeLessThan(x[2] as number);
  });

  it('adds a conditional edge between existing tasks', () => {
    const workflow = defineWorkflow('cond', 'Conditional')
      .task('check', 'noop')
      .task('escalate', 'noop')
      .edge('check', 'escalate', '$.tasks.check.output.risk > 0.8')
      .build();

    expect(workflow.edges[0]?.condition).toBe('$.tasks.check.output.risk > 0.8');
  });

  it('rejects an edge referencing an unknown task', () => {
    expect(() => defineWorkflow('bad-edge', 'Bad').task('a', 'noop').edge('a', 'ghost')).toThrow(
      /unknown task/,
    );
  });

  it('rejects a workflow with no tasks', () => {
    expect(() => defineWorkflow('empty', 'Empty').build()).toThrow(/has no tasks/);
  });

  it('validates the finished document against the same schema the API uses', () => {
    // A builder that can produce a document the server rejects is worse than no builder.
    expect(() => defineWorkflow('BAD KEY', 'Bad').task('a', 'noop').build()).toThrow(
      WorkflowBuilderError,
    );
  });

  it('reports every schema problem at once', () => {
    try {
      defineWorkflow('ok', 'Ok').task('a', 'noop', { timeoutMs: 1 }).build();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('timeoutMs');
    }
  });

  it('carries the output mapping through', () => {
    const workflow = defineWorkflow('out', 'Out')
      .task('ship', 'noop')
      .output({ shipped: '$.tasks.ship.output', version: { value: 2 } })
      .build();

    expect(workflow.output.shipped).toEqual({ from: '$.tasks.ship.output' });
    expect(workflow.output.version).toEqual({ value: 2 });
  });
});
