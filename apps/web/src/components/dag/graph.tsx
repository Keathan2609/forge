'use client';

import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { TaskRunView, WorkflowDefinition } from '@forge/contracts';
import { TaskNode, type TaskNodeData } from './task-node';
import styles from './graph.module.css';

/**
 * Workflow DAG renderer.
 *
 * Node positions come from the definition when the author placed them, and from an
 * automatic layered layout otherwise — so a workflow created through the SDK or CLI
 * still opens as a readable graph rather than a pile at the origin.
 *
 * The layout is a simple longest-path layering (Sugiyama's first phase). A full
 * crossing-minimisation pass would produce prettier graphs, but layering alone gets
 * left-to-right dependency order right, which is the property that actually matters
 * when you are reading an execution.
 */

const NODE_TYPES = { task: TaskNode };

const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 116;

/**
 * Below this zoom a node's labels stop being readable, so fitting the whole graph
 * stops being useful. Measured against the 196px node at the console's type sizes.
 */
const MIN_LEGIBLE_ZOOM = 0.55;

export interface DagGraphProps {
  definition: WorkflowDefinition;
  /** Live task state, keyed by node key. Omit for a static definition view. */
  tasks?: Record<string, TaskRunView>;
  selectedKey?: string | null;
  onSelect?: (nodeKey: string | null) => void;
  /** Show the minimap. Off for small graphs where it is pure clutter. */
  minimap?: boolean;
  height?: number | string;
}

/** Longest-path layering: a node sits one column right of its deepest dependency. */
function autoLayout(definition: WorkflowDefinition): Map<string, { x: number; y: number }> {
  const dependencies = new Map<string, string[]>();
  for (const node of definition.nodes) dependencies.set(node.key, []);
  for (const edge of definition.edges) {
    dependencies.get(edge.to)?.push(edge.from);
  }

  const depth = new Map<string, number>();
  const resolve = (key: string, seen: Set<string>): number => {
    const cached = depth.get(key);
    if (cached !== undefined) return cached;
    // `seen` guards against a cycle. The API rejects cyclic definitions, but the editor
    // renders drafts that may transiently contain one.
    if (seen.has(key)) return 0;
    seen.add(key);
    const deps = dependencies.get(key) ?? [];
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((d) => resolve(d, seen))) + 1;
    seen.delete(key);
    depth.set(key, value);
    return value;
  };

  for (const node of definition.nodes) resolve(node.key, new Set());

  // Group by column, then space vertically and centre each column.
  const byColumn = new Map<number, string[]>();
  for (const node of definition.nodes) {
    const column = depth.get(node.key) ?? 0;
    const list = byColumn.get(column) ?? [];
    list.push(node.key);
    byColumn.set(column, list);
  }

  const tallest = Math.max(...[...byColumn.values()].map((c) => c.length), 1);
  const positions = new Map<string, { x: number; y: number }>();

  for (const [column, keys] of byColumn) {
    const offset = ((tallest - keys.length) * ROW_HEIGHT) / 2;
    keys.forEach((key, index) => {
      positions.set(key, { x: column * COLUMN_WIDTH, y: offset + index * ROW_HEIGHT });
    });
  }

  return positions;
}

function buildNodes(
  definition: WorkflowDefinition,
  tasks: Record<string, TaskRunView> | undefined,
): Array<Node<TaskNodeData>> {
  // Use author-placed positions only when they are actually present and non-degenerate;
  // a definition where every node sits at (0,0) is worse than an automatic layout.
  const authored = definition.nodes.filter((n) => n.position !== undefined);
  const distinct = new Set(authored.map((n) => n.position?.x + ':' + n.position?.y));
  const useAuthored = authored.length === definition.nodes.length && distinct.size > 1;
  const layout = useAuthored ? null : autoLayout(definition);

  return definition.nodes.map((node) => {
    const task = tasks?.[node.key];
    const position = useAuthored
      ? (node.position as { x: number; y: number })
      : (layout?.get(node.key) ?? { x: 0, y: 0 });

    return {
      id: node.key,
      type: 'task',
      position,
      data: {
        nodeKey: node.key,
        type: node.type,
        queue: node.queue,
        ...(task
          ? {
              state: task.state,
              attempts: task.attempts,
              maxAttempts: task.maxAttempts,
              durationMs: task.durationMs,
              workerId: task.workerId,
              errorMessage: task.errorMessage,
            }
          : {}),
      },
    };
  });
}

function buildEdges(
  definition: WorkflowDefinition,
  tasks: Record<string, TaskRunView> | undefined,
): Edge[] {
  return definition.edges.map((edge) => {
    const source = tasks?.[edge.from];
    const target = tasks?.[edge.to];
    // Animate only the edges along which work is *currently* flowing: the source has
    // finished and the target is live. Animating every edge would be decoration.
    const flowing =
      source?.state === 'SUCCEEDED' && (target?.state === 'RUNNING' || target?.state === 'QUEUED');

    return {
      id: edge.from + '->' + edge.to,
      source: edge.from,
      target: edge.to,
      animated: flowing,
      type: 'smoothstep',
      ...(edge.condition
        ? { label: edge.condition, labelStyle: { fill: 'var(--text-tertiary)', fontSize: 10 } }
        : {}),
      style:
        target?.state === 'SKIPPED'
          ? { stroke: 'var(--border-subtle)', strokeDasharray: '4 4' }
          : undefined,
    };
  });
}

function GraphInner({
  definition,
  tasks,
  selectedKey,
  onSelect,
  minimap,
}: DagGraphProps): ReactNode {
  const initialNodes = useMemo(() => buildNodes(definition, tasks), [definition, tasks]);
  const initialEdges = useMemo(() => buildEdges(definition, tasks), [definition, tasks]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const { fitView } = useReactFlow();

  // Patch node *data* in place as live state arrives rather than replacing the node
  // array. Replacing it would reset positions, drop the user's pan/zoom and blow away
  // the selection every time a task changed state — on a live run, several times a
  // second.
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        const next = initialNodes.find((n) => n.id === node.id);
        if (!next) return node;
        return { ...node, data: next.data };
      }),
    );
  }, [initialNodes, setNodes]);

  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  /**
   * Fit the graph — but never below a legible zoom.
   *
   * A long sequential pipeline is ~2000px wide; fitting it into a 400px-tall panel
   * lands at 0.2 zoom, where the node labels are unreadable and the graph conveys
   * nothing. Past that point, showing part of a graph you can actually read beats
   * showing all of one you cannot, so we clamp the zoom and anchor on the entry nodes,
   * leaving the rest to panning and the minimap.
   *
   * Re-fits only when the graph's *shape* changes, never on a state update — refitting
   * as tasks complete would fight the user for control of the viewport.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      // `minZoom` on fitView is the right lever: React Flow clamps and centres rather
      // than zooming out past legibility, so a long pipeline opens readable and panned
      // to its start instead of fitted and unreadable.
      void fitView({ padding: 0.18, duration: 200, minZoom: MIN_LEGIBLE_ZOOM });
    }, 60);
    return (): void => clearTimeout(timer);
  }, [definition.key, definition.nodes.length, definition.edges.length, fitView]);

  const handleNodeClick = useCallback((_: unknown, node: Node) => onSelect?.(node.id), [onSelect]);

  const handlePaneClick = useCallback(() => onSelect?.(null), [onSelect]);

  const nodesWithSelection = useMemo(
    () => nodes.map((n) => ({ ...n, selected: n.id === selectedKey })),
    [nodes, selectedKey],
  );

  return (
    <ReactFlow
      nodes={nodesWithSelection}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      nodeTypes={NODE_TYPES}
      // Deliberately NOT the `fitView` boolean prop: React Flow re-fits whenever the
      // node array changes, which on a live run means the viewport is yanked back to
      // centre every time a task changes state. The effect above fits once per graph
      // shape instead, leaving the user in control of pan and zoom.
      fitViewOptions={{ padding: 0.18, minZoom: MIN_LEGIBLE_ZOOM }}
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: false }}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      <Controls showInteractive={false} />
      {minimap && <MiniMap pannable zoomable nodeColor={() => 'var(--border-strong)'} />}
    </ReactFlow>
  );
}

export function DagGraph(props: DagGraphProps): ReactNode {
  return (
    <div className={styles.canvas} style={{ height: props.height ?? 460 }}>
      <ReactFlowProvider>
        <GraphInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
