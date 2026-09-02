import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@forge/contracts';
import { GraphValidationError, ValidationCode, type ValidationIssue } from './errors';
import { validateExpression } from './expression';

/**
 * Graph analysis for workflow definitions.
 *
 * Everything here is pure and synchronous: given a definition it answers structural
 * questions (is it a DAG? what depends on what? in what order could it run?) without
 * touching a database, a clock or a queue. That is what makes the orchestration rules
 * exhaustively testable — see `test/graph.test.ts`.
 */

export interface CompiledGraph {
  readonly definition: WorkflowDefinition;
  readonly nodesByKey: ReadonlyMap<string, WorkflowNode>;
  /** node key -> keys it depends on (incoming edges). */
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  /** node key -> keys that depend on it (outgoing edges). */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
  /** Nodes with no dependencies. These start immediately. */
  readonly entryNodes: readonly string[];
  /** Nodes nothing depends on. Their outputs feed the run output mapping. */
  readonly terminalNodes: readonly string[];
  /** A valid execution order. Only meaningful for acyclic graphs. */
  readonly topologicalOrder: readonly string[];
  /** Edge conditions keyed by `from->to`. */
  readonly edgeConditions: ReadonlyMap<string, string>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function edgeId(edge: Pick<WorkflowEdge, 'from' | 'to'>): string {
  return edge.from + '->' + edge.to;
}

/**
 * Detect a cycle and return one concrete cycle path, not just a boolean.
 *
 * Kahn's algorithm tells you *that* a cycle exists; a user editing a 40-node graph
 * needs to know *which* nodes form it. This is an iterative DFS with an explicit
 * stack (recursion would blow up on pathological definitions) that reconstructs the
 * offending path from the colour marks.
 */
export function findCycle(
  nodeKeys: readonly string[],
  dependents: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>(nodeKeys.map((k) => [k, WHITE]));
  const parent = new Map<string, string | null>();

  for (const root of nodeKeys) {
    if (colour.get(root) !== WHITE) continue;
    const stack: Array<{ key: string; childIndex: number }> = [{ key: root, childIndex: 0 }];
    colour.set(root, GREY);
    parent.set(root, null);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { key: string; childIndex: number };
      const children = dependents.get(frame.key) ?? [];
      if (frame.childIndex >= children.length) {
        colour.set(frame.key, BLACK);
        stack.pop();
        continue;
      }
      const child = children[frame.childIndex] as string;
      frame.childIndex += 1;

      const childColour = colour.get(child);
      if (childColour === GREY) {
        // Walk back up the parent chain to materialise the cycle.
        const cycle = [child];
        let cursor: string | null | undefined = frame.key;
        while (cursor && cursor !== child) {
          cycle.push(cursor);
          cursor = parent.get(cursor) ?? null;
        }
        cycle.push(child);
        return cycle.reverse();
      }
      if (childColour === WHITE) {
        colour.set(child, GREY);
        parent.set(child, frame.key);
        stack.push({ key: child, childIndex: 0 });
      }
    }
  }
  return null;
}

/**
 * Kahn topological sort. Ties are broken by definition order so the result is
 * deterministic — important because it drives both the console layout and the
 * snapshot tests.
 */
export function topologicalSort(
  nodeKeys: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
  dependents: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const indegree = new Map<string, number>();
  for (const key of nodeKeys) indegree.set(key, (dependencies.get(key) ?? []).length);

  const order: string[] = [];
  const ready = nodeKeys.filter((k) => indegree.get(k) === 0);

  while (ready.length > 0) {
    const key = ready.shift() as string;
    order.push(key);
    for (const child of dependents.get(key) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }

  return order.length === nodeKeys.length ? order : null;
}

/** Nodes reachable from the entry set, used to flag orphaned subgraphs. */
function reachableFrom(
  entries: readonly string[],
  dependents: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const seen = new Set<string>(entries);
  const stack = [...entries];
  while (stack.length > 0) {
    const key = stack.pop() as string;
    for (const child of dependents.get(key) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        stack.push(child);
      }
    }
  }
  return seen;
}

/**
 * Validate a definition without throwing.
 *
 * The console calls this on every keystroke in the DAG editor, so it collects *all*
 * issues instead of failing on the first. `knownTypes` is supplied by the API from the
 * union of capabilities advertised by registered workers — an unknown handler type is
 * a warning rather than an error, because a worker able to run it may register later.
 */
export function validateDefinition(
  definition: WorkflowDefinition,
  options: { knownTypes?: readonly string[] } = {},
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const push = (
    bucket: ValidationIssue[],
    code: ValidationCode,
    target: string,
    message: string,
    severity: 'error' | 'warning',
  ): void => {
    bucket.push({ severity, code, target, message });
  };

  if (definition.nodes.length === 0) {
    push(errors, ValidationCode.EMPTY_GRAPH, '$', 'a workflow needs at least one node', 'error');
    return { valid: false, errors, warnings };
  }

  // --- node keys must be unique -------------------------------------------
  const nodesByKey = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (nodesByKey.has(node.key)) {
      push(
        errors,
        ValidationCode.DUPLICATE_NODE_KEY,
        node.key,
        'duplicate node key "' + node.key + '"',
        'error',
      );
      continue;
    }
    nodesByKey.set(node.key, node);
  }

  // --- edges must reference existing nodes, exactly once -------------------
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const edgeConditions = new Map<string, string>();
  for (const key of nodesByKey.keys()) {
    dependencies.set(key, []);
    dependents.set(key, []);
  }

  const seenEdges = new Set<string>();
  for (const edge of definition.edges) {
    const id = edgeId(edge);
    if (!nodesByKey.has(edge.from)) {
      push(
        errors,
        ValidationCode.UNKNOWN_EDGE_SOURCE,
        id,
        'edge source "' + edge.from + '" is not a node in this workflow',
        'error',
      );
      continue;
    }
    if (!nodesByKey.has(edge.to)) {
      push(
        errors,
        ValidationCode.UNKNOWN_EDGE_TARGET,
        id,
        'edge target "' + edge.to + '" is not a node in this workflow',
        'error',
      );
      continue;
    }
    if (edge.from === edge.to) {
      push(errors, ValidationCode.SELF_LOOP, id, 'a node cannot depend on itself', 'error');
      continue;
    }
    if (seenEdges.has(id)) {
      push(warnings, ValidationCode.DUPLICATE_EDGE, id, 'duplicate edge ignored', 'warning');
      continue;
    }
    seenEdges.add(id);
    (dependencies.get(edge.to) as string[]).push(edge.from);
    (dependents.get(edge.from) as string[]).push(edge.to);
    if (edge.condition) {
      edgeConditions.set(id, edge.condition);
      const check = validateExpression(edge.condition);
      if (!check.ok) {
        push(
          errors,
          ValidationCode.INVALID_CONDITION,
          id,
          'edge condition is invalid: ' + check.message,
          'error',
        );
      }
    }
  }

  // --- per-node checks -----------------------------------------------------
  for (const node of nodesByKey.values()) {
    if (node.condition) {
      const check = validateExpression(node.condition);
      if (!check.ok) {
        push(
          errors,
          ValidationCode.INVALID_CONDITION,
          node.key,
          'condition is invalid: ' + check.message,
          'error',
        );
      }
    }
    for (const [field, mapping] of Object.entries(node.input)) {
      if ('from' in mapping) {
        const ref = mapping.from;
        if (!ref.startsWith('$.')) {
          push(
            errors,
            ValidationCode.INVALID_INPUT_REFERENCE,
            node.key,
            'input "' + field + '" must reference a context path starting with "$."',
            'error',
          );
          continue;
        }
        // `$.tasks.<key>...` must name a real upstream node. Keys are slugs, so the
        // pattern admits hyphens — `$.tasks.prepare-shipment.output`.
        const match = /^\$\.tasks\.([A-Za-z0-9_-]+)/.exec(ref);
        if (match) {
          const referenced = match[1] as string;
          if (!nodesByKey.has(referenced)) {
            push(
              errors,
              ValidationCode.INVALID_INPUT_REFERENCE,
              node.key,
              'input "' + field + '" references unknown task "' + referenced + '"',
              'error',
            );
          } else if (!(dependencies.get(node.key) ?? []).includes(referenced)) {
            // Reading a task you do not depend on is a race, not a preference.
            push(
              errors,
              ValidationCode.INVALID_INPUT_REFERENCE,
              node.key,
              'input "' +
                field +
                '" reads task "' +
                referenced +
                '" but does not depend on it — add an edge ' +
                referenced +
                ' -> ' +
                node.key,
              'error',
            );
          }
        }
      }
    }
    if (node.timeoutMs > definition.timeoutMs) {
      push(
        warnings,
        ValidationCode.TIMEOUT_EXCEEDS_WORKFLOW,
        node.key,
        'node timeout (' +
          node.timeoutMs +
          'ms) exceeds the workflow timeout (' +
          definition.timeoutMs +
          'ms)',
        'warning',
      );
    }
    if (options.knownTypes && !options.knownTypes.includes(node.type)) {
      push(
        warnings,
        ValidationCode.UNKNOWN_TASK_TYPE,
        node.key,
        'no registered worker currently advertises handler type "' + node.type + '"',
        'warning',
      );
    }
  }

  // --- run output mapping --------------------------------------------------
  // Validated with the same rigour as node inputs. Skipping this was a real bug: an
  // output mapping naming a node that did not exist parsed fine and then failed at the
  // moment the run completed — the worst possible time to discover a typo, because
  // every task had already done its work.
  for (const [field, mapping] of Object.entries(definition.output)) {
    if (!('from' in mapping)) continue;
    const ref = mapping.from;
    if (!ref.startsWith('$.')) {
      push(
        errors,
        ValidationCode.INVALID_INPUT_REFERENCE,
        '$.output.' + field,
        'output "' + field + '" must reference a context path starting with "$."',
        'error',
      );
      continue;
    }
    const check = validateExpression(ref);
    if (!check.ok) {
      push(
        errors,
        ValidationCode.INVALID_INPUT_REFERENCE,
        '$.output.' + field,
        'output "' + field + '" is not a valid path: ' + check.message,
        'error',
      );
      continue;
    }
    const match = /^\$\.tasks\.([A-Za-z0-9_-]+)/.exec(ref);
    if (match && !nodesByKey.has(match[1] as string)) {
      push(
        errors,
        ValidationCode.INVALID_INPUT_REFERENCE,
        '$.output.' + field,
        'output "' + field + '" references unknown task "' + match[1] + '"',
        'error',
      );
    }
  }

  // --- structural checks ---------------------------------------------------
  const nodeKeys = [...nodesByKey.keys()];
  const cycle = findCycle(nodeKeys, dependents);
  if (cycle) {
    push(
      errors,
      ValidationCode.CYCLE,
      cycle.join(' -> '),
      'the graph contains a cycle: ' + cycle.join(' -> '),
      'error',
    );
  }

  const entryNodes = nodeKeys.filter((k) => (dependencies.get(k) ?? []).length === 0);
  if (entryNodes.length === 0 && !cycle) {
    push(
      errors,
      ValidationCode.NO_ENTRY_NODE,
      '$',
      'no entry node — every node has a dependency',
      'error',
    );
  }

  if (!cycle && entryNodes.length > 0) {
    const reachable = reachableFrom(entryNodes, dependents);
    for (const key of nodeKeys) {
      if (!reachable.has(key)) {
        push(
          errors,
          ValidationCode.UNREACHABLE_NODE,
          key,
          'node "' + key + '" is not reachable from any entry node',
          'error',
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate and compile a definition into the lookup structures the orchestrator uses.
 * Throws `GraphValidationError` when the definition is not executable.
 */
export function compileGraph(
  definition: WorkflowDefinition,
  options: { knownTypes?: readonly string[] } = {},
): CompiledGraph {
  const result = validateDefinition(definition, options);
  if (!result.valid) {
    throw new GraphValidationError(
      'workflow "' + definition.key + '" is not a valid DAG',
      result.errors,
    );
  }

  const nodesByKey = new Map<string, WorkflowNode>(definition.nodes.map((n) => [n.key, n]));
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const edgeConditions = new Map<string, string>();
  for (const key of nodesByKey.keys()) {
    dependencies.set(key, []);
    dependents.set(key, []);
  }
  const seen = new Set<string>();
  for (const edge of definition.edges) {
    const id = edgeId(edge);
    if (seen.has(id)) continue;
    seen.add(id);
    (dependencies.get(edge.to) as string[]).push(edge.from);
    (dependents.get(edge.from) as string[]).push(edge.to);
    if (edge.condition) edgeConditions.set(id, edge.condition);
  }

  const nodeKeys = definition.nodes.map((n) => n.key);
  const order = topologicalSort(nodeKeys, dependencies, dependents);
  if (!order) {
    throw new GraphValidationError('workflow "' + definition.key + '" contains a cycle', [
      {
        severity: 'error',
        code: ValidationCode.CYCLE,
        target: '$',
        message: 'cycle detected during topological sort',
      },
    ]);
  }

  return {
    definition,
    nodesByKey,
    dependencies,
    dependents,
    entryNodes: nodeKeys.filter((k) => (dependencies.get(k) as string[]).length === 0),
    terminalNodes: nodeKeys.filter((k) => (dependents.get(k) as string[]).length === 0),
    topologicalOrder: order,
    edgeConditions,
  };
}

/** All nodes downstream of `key`, transitively. Used for cancellation propagation. */
export function descendantsOf(graph: CompiledGraph, key: string): string[] {
  const out = new Set<string>();
  const stack = [...(graph.dependents.get(key) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (out.has(next)) continue;
    out.add(next);
    stack.push(...(graph.dependents.get(next) ?? []));
  }
  return [...out];
}

/**
 * Longest dependency chain, in nodes. A useful proxy for "how deep is this workflow"
 * and shown in the console next to the node count.
 */
export function criticalPathLength(graph: CompiledGraph): number {
  const depth = new Map<string, number>();
  let max = 0;
  for (const key of graph.topologicalOrder) {
    const deps = graph.dependencies.get(key) ?? [];
    const d = deps.length === 0 ? 1 : Math.max(...deps.map((k) => depth.get(k) ?? 1)) + 1;
    depth.set(key, d);
    if (d > max) max = d;
  }
  return max;
}
