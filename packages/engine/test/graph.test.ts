import { describe, expect, it } from 'vitest';
import { makeDefinition, makeNode, FIXTURES } from '@forge/testing';
import {
  ValidationCode,
  compileGraph,
  criticalPathLength,
  descendantsOf,
  findCycle,
  topologicalSort,
  validateDefinition,
  GraphValidationError,
} from '../src';

describe('validateDefinition', () => {
  it('accepts a linear DAG', () => {
    const result = validateDefinition(FIXTURES.linear());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a diamond fan-out/fan-in', () => {
    expect(validateDefinition(FIXTURES.diamond()).valid).toBe(true);
  });

  it('rejects a cycle and names the nodes involved', () => {
    const result = validateDefinition(FIXTURES.cyclic());
    expect(result.valid).toBe(false);
    const cycle = result.errors.find((e) => e.code === ValidationCode.CYCLE);
    expect(cycle).toBeDefined();
    expect(cycle?.message).toContain('a');
    expect(cycle?.message).toContain('b');
    expect(cycle?.message).toContain('c');
  });

  it('rejects a two-node cycle', () => {
    const def = makeDefinition({ nodes: ['a', 'b'], edges: ['a->b', 'b->a'] });
    const result = validateDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === ValidationCode.CYCLE)).toBe(true);
  });

  it('rejects duplicate node keys', () => {
    const def = makeDefinition({ nodes: [makeNode('a'), makeNode('a')] });
    const result = validateDefinition(def);
    expect(result.errors.some((e) => e.code === ValidationCode.DUPLICATE_NODE_KEY)).toBe(true);
  });

  it('rejects edges referencing unknown nodes', () => {
    const def = makeDefinition({ nodes: ['a'], edges: [{ from: 'a', to: 'ghost' }] });
    const result = validateDefinition(def);
    expect(result.errors.some((e) => e.code === ValidationCode.UNKNOWN_EDGE_TARGET)).toBe(true);
  });

  it('rejects a self-loop', () => {
    const def = makeDefinition({ nodes: ['a'], edges: [{ from: 'a', to: 'a' }] });
    const result = validateDefinition(def);
    expect(result.errors.some((e) => e.code === ValidationCode.SELF_LOOP)).toBe(true);
  });

  it('flags a disconnected subgraph as unreachable', () => {
    // `orphan` has no incoming edge, so it *is* an entry node — but `stranded` is only
    // reachable through a cycle, which we build here as an isolated pair.
    const def = makeDefinition({
      nodes: ['a', 'b', 'x', 'y'],
      edges: ['a->b', 'x->y', 'y->x'],
    });
    const result = validateDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === ValidationCode.CYCLE)).toBe(true);
  });

  it('warns rather than errors on an unknown handler type', () => {
    const def = makeDefinition({ nodes: [makeNode('a', { type: 'charge.card' })] });
    const result = validateDefinition(def, { knownTypes: ['noop'] });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === ValidationCode.UNKNOWN_TASK_TYPE)).toBe(true);
  });

  it('treats a duplicate edge as a warning, not a failure', () => {
    const def = makeDefinition({
      nodes: ['a', 'b'],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'b' },
      ],
    });
    const result = validateDefinition(def);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === ValidationCode.DUPLICATE_EDGE)).toBe(true);
  });

  it('rejects an invalid condition expression', () => {
    const def = makeDefinition({ nodes: [makeNode('a', { condition: '$.input.x =' })] });
    const result = validateDefinition(def);
    expect(result.errors.some((e) => e.code === ValidationCode.INVALID_CONDITION)).toBe(true);
  });

  it('rejects an input mapping that reads a task it does not depend on', () => {
    // This is a genuine race, not a style preference: without the edge there is no
    // guarantee `b` has produced output when `a` runs.
    const def = makeDefinition({
      nodes: [
        makeNode('a', { input: { total: { from: '$.tasks.b.output.total' } } }),
        makeNode('b'),
      ],
    });
    const result = validateDefinition(def);
    const issue = result.errors.find((e) => e.code === ValidationCode.INVALID_INPUT_REFERENCE);
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('does not depend on it');
  });

  it('accepts an input mapping that reads a declared dependency', () => {
    const def = makeDefinition({
      nodes: [
        makeNode('a'),
        makeNode('b', { input: { total: { from: '$.tasks.a.output.total' } } }),
      ],
      edges: ['a->b'],
    });
    expect(validateDefinition(def).valid).toBe(true);
  });

  it('rejects an input reference to a task that does not exist', () => {
    const def = makeDefinition({
      nodes: [makeNode('a', { input: { v: { from: '$.tasks.ghost.output.v' } } })],
    });
    expect(
      validateDefinition(def).errors.some((e) => e.code === ValidationCode.INVALID_INPUT_REFERENCE),
    ).toBe(true);
  });

  it('warns when a node timeout exceeds the workflow timeout', () => {
    const def = makeDefinition({
      timeoutMs: 10_000,
      nodes: [makeNode('a', { timeoutMs: 60_000 })],
    });
    const result = validateDefinition(def);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === ValidationCode.TIMEOUT_EXCEEDS_WORKFLOW)).toBe(
      true,
    );
  });
});

describe('findCycle', () => {
  it('returns null for an acyclic graph', () => {
    const dependents = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', []],
    ]);
    expect(findCycle(['a', 'b', 'c'], dependents)).toBeNull();
  });

  it('returns the concrete cycle path', () => {
    const dependents = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    const cycle = findCycle(['a', 'b', 'c'], dependents);
    expect(cycle).not.toBeNull();
    // First and last element close the loop.
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('handles a graph with multiple roots where only one branch cycles', () => {
    const dependents = new Map([
      ['root', ['clean']],
      ['clean', []],
      ['x', ['y']],
      ['y', ['x']],
    ]);
    expect(findCycle(['root', 'clean', 'x', 'y'], dependents)).not.toBeNull();
  });
});

describe('topologicalSort', () => {
  it('orders dependencies before dependents', () => {
    const deps = new Map([
      ['a', []],
      ['b', ['a']],
      ['c', ['b']],
    ]);
    const dependents = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', []],
    ]);
    expect(topologicalSort(['a', 'b', 'c'], deps, dependents)).toEqual(['a', 'b', 'c']);
  });

  it('returns null when a cycle makes ordering impossible', () => {
    const deps = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const dependents = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    expect(topologicalSort(['a', 'b'], deps, dependents)).toBeNull();
  });

  it('is deterministic for a diamond', () => {
    const graph = compileGraph(FIXTURES.diamond());
    expect(graph.topologicalOrder).toEqual(['root', 'left', 'right', 'join']);
  });
});

describe('compileGraph', () => {
  it('exposes dependencies, dependents, entry and terminal nodes', () => {
    const graph = compileGraph(FIXTURES.diamond());
    expect(graph.entryNodes).toEqual(['root']);
    expect(graph.terminalNodes).toEqual(['join']);
    expect(graph.dependencies.get('join')).toEqual(['left', 'right']);
    expect(graph.dependents.get('root')).toEqual(['left', 'right']);
  });

  it('throws GraphValidationError with issues for an invalid definition', () => {
    expect(() => compileGraph(FIXTURES.cyclic())).toThrow(GraphValidationError);
    try {
      compileGraph(FIXTURES.cyclic());
    } catch (err) {
      expect((err as GraphValidationError).issues.length).toBeGreaterThan(0);
      expect((err as GraphValidationError).code).toBe('GRAPH_INVALID');
    }
  });

  it('preserves edge conditions', () => {
    const def = makeDefinition({
      nodes: ['a', 'b'],
      edges: [{ from: 'a', to: 'b', condition: '$.tasks.a.output.ok == true' }],
    });
    const graph = compileGraph(def);
    expect(graph.edgeConditions.get('a->b')).toBe('$.tasks.a.output.ok == true');
  });
});

describe('graph analysis helpers', () => {
  it('descendantsOf walks transitively', () => {
    const graph = compileGraph(FIXTURES.diamond());
    expect(new Set(descendantsOf(graph, 'root'))).toEqual(new Set(['left', 'right', 'join']));
    expect(descendantsOf(graph, 'join')).toEqual([]);
  });

  it('criticalPathLength measures the longest chain, not the node count', () => {
    expect(criticalPathLength(compileGraph(FIXTURES.diamond()))).toBe(3);
    expect(criticalPathLength(compileGraph(FIXTURES.linear()))).toBe(3);
  });

  it('handles a wide fan-out without inflating the critical path', () => {
    const def = makeDefinition({
      nodes: ['root', 'a', 'b', 'c', 'd'],
      edges: ['root->a', 'root->b', 'root->c', 'root->d'],
    });
    expect(criticalPathLength(compileGraph(def))).toBe(2);
  });
});
