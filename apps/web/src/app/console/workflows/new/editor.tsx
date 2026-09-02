'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DEFAULT_RETRY_POLICY, type WorkflowDefinition } from '@forge/contracts';
import { forgeApi } from '@/lib/api';
import { PageHeader, ui } from '@/components/ui';
import { TaskNode, type TaskNodeData } from '@/components/dag/task-node';
import styles from './editor.module.css';

/**
 * Visual DAG editor.
 *
 * The design decision that shapes everything else: the editor's state *is* a
 * `WorkflowDefinition`, and validation is delegated to the API — which runs the same
 * engine the executor runs. A client-side validator would be a second implementation of
 * the DAG rules, and the moment the two disagree the editor is lying about what will
 * happen. Server round-trips are debounced; correctness is not traded for latency.
 *
 * Cycles are prevented at the point of connection rather than reported afterwards: the
 * editor refuses to draw an edge that would close a loop, so an invalid graph is never
 * constructed in the first place.
 */

const NODE_TYPES = { task: TaskNode };

/** Handler types the built-in workers ship with. */
const PALETTE = [
  { type: 'noop', description: 'Succeeds immediately. Useful as a join point.' },
  { type: 'delay', description: 'Waits for `durationMs`, reporting progress.' },
  { type: 'compute', description: 'Arithmetic over `values`: sum, product, max, min, mean.' },
  { type: 'validate', description: 'Asserts that `required` fields exist on `payload`.' },
  { type: 'transform', description: 'Projects `source` through a key `mapping`.' },
  { type: 'http.echo', description: 'Synthetic HTTP response — models an API call.' },
];

interface EditorState {
  key: string;
  name: string;
  description: string;
}

export function WorkflowEditor({ initial }: { initial?: WorkflowDefinition }): ReactNode {
  return (
    <ReactFlowProvider>
      <EditorInner initial={initial} />
    </ReactFlowProvider>
  );
}

function EditorInner({ initial }: { initial?: WorkflowDefinition }): ReactNode {
  const router = useRouter();

  const [meta, setMeta] = useState<EditorState>({
    key: initial?.key ?? 'my-workflow',
    name: initial?.name ?? 'My Workflow',
    description: initial?.description ?? '',
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TaskNodeData>>(
    initial
      ? initial.nodes.map((node) => ({
          id: node.key,
          type: 'task',
          position: node.position ?? { x: 0, y: 0 },
          data: { nodeKey: node.key, type: node.type, queue: node.queue },
        }))
      : [
          {
            id: 'start',
            type: 'task',
            position: { x: 0, y: 0 },
            data: { nodeKey: 'start', type: 'noop', queue: 'default' },
          },
        ],
  );

  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    initial
      ? initial.edges.map((edge) => ({
          id: edge.from + '->' + edge.to,
          source: edge.from,
          target: edge.to,
          type: 'smoothstep',
        }))
      : [],
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [validation, setValidation] = useState<{
    valid: boolean;
    errors: Array<{ code: string; message: string; target: string }>;
    warnings: Array<{ code: string; message: string; target: string }>;
    analysis?: { nodes: number; edges: number; entryNodes: string[]; criticalPath: number };
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Per-node configuration that the graph itself does not carry. */
  const [config, setConfig] = useState<
    Record<
      string,
      { timeoutMs: number; maxAttempts: number; queue: string; condition: string; config: string }
    >
  >(() => {
    const initialConfig: Record<
      string,
      { timeoutMs: number; maxAttempts: number; queue: string; condition: string; config: string }
    > = {};
    for (const node of initial?.nodes ?? []) {
      initialConfig[node.key] = {
        timeoutMs: node.timeoutMs,
        maxAttempts: node.retryPolicy.maxAttempts,
        queue: node.queue,
        condition: node.condition ?? '',
        config: JSON.stringify(node.config ?? {}, null, 2),
      };
    }
    return initialConfig;
  });

  const nodeConfig = (
    key: string,
  ): { timeoutMs: number; maxAttempts: number; queue: string; condition: string; config: string } =>
    config[key] ?? {
      timeoutMs: 60_000,
      maxAttempts: 3,
      queue: 'default',
      condition: '',
      config: '{}',
    };

  /** Assemble the current graph into a definition document. */
  const definition = useMemo((): WorkflowDefinition => {
    return {
      key: meta.key,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      timeoutMs: 3_600_000,
      defaultRetryPolicy: DEFAULT_RETRY_POLICY,
      inputSchema: {},
      output: {},
      nodes: nodes.map((node) => {
        const settings = nodeConfig(node.id);
        let parsedConfig: Record<string, unknown> = {};
        try {
          parsedConfig = JSON.parse(settings.config) as Record<string, unknown>;
        } catch {
          // A half-typed config must not crash the editor; validation surfaces it.
        }
        return {
          key: node.id,
          name: node.id,
          type: (node.data as TaskNodeData).type,
          queue: settings.queue,
          timeoutMs: settings.timeoutMs,
          retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: settings.maxAttempts },
          config: parsedConfig,
          input: {},
          metadata: {},
          ...(settings.condition ? { condition: settings.condition } : {}),
          position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
        };
      }),
      edges: edges.map((edge) => ({ from: edge.source, to: edge.target })),
      metadata: {},
    };
  }, [meta, nodes, edges, config]);

  // Validate against the API — the same engine that will execute this graph.
  useEffect(() => {
    const timer = setTimeout(() => {
      void forgeApi
        .validateWorkflow(definition)
        .then(setValidation)
        .catch(() => setValidation(null));
    }, 400);
    return (): void => clearTimeout(timer);
  }, [definition]);

  /** Would adding `source -> target` create a cycle? */
  const wouldCycle = useCallback(
    (source: string, target: string): boolean => {
      if (source === target) return true;
      // Walk forward from `target`; reaching `source` means the new edge closes a loop.
      const adjacency = new Map<string, string[]>();
      for (const edge of edges) {
        const list = adjacency.get(edge.source) ?? [];
        list.push(edge.target);
        adjacency.set(edge.source, list);
      }
      const seen = new Set<string>();
      const stack = [target];
      while (stack.length > 0) {
        const current = stack.pop() as string;
        if (current === source) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        stack.push(...(adjacency.get(current) ?? []));
      }
      return false;
    },
    [edges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (wouldCycle(connection.source, connection.target)) {
        setSaveError(
          'That connection would create a cycle (' +
            connection.source +
            ' → ' +
            connection.target +
            '). Workflows must be acyclic.',
        );
        setTimeout(() => setSaveError(null), 4_000);
        return;
      }
      setSaveError(null);
      setEdges((current) => addEdge({ ...connection, type: 'smoothstep' }, current));
    },
    [wouldCycle, setEdges],
  );

  const addNode = (type: string): void => {
    // Derive a unique key from the handler type: `http.echo` → `http-echo-2`.
    const base = type.replace(/[^a-z0-9]+/g, '-');
    let key = base;
    let suffix = 2;
    while (nodes.some((n) => n.id === key)) key = base + '-' + suffix++;

    const column = nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.position.x)) + 260;
    setNodes((current) => [
      ...current,
      {
        id: key,
        type: 'task',
        position: { x: column, y: 0 },
        data: { nodeKey: key, type, queue: 'default' },
      },
    ]);
    setSelected(key);
  };

  const removeNode = (key: string): void => {
    setNodes((current) => current.filter((n) => n.id !== key));
    setEdges((current) => current.filter((e) => e.source !== key && e.target !== key));
    if (selected === key) setSelected(null);
  };

  const updateConfig = (
    key: string,
    patch: Partial<{
      timeoutMs: number;
      maxAttempts: number;
      queue: string;
      condition: string;
      config: string;
    }>,
  ): void => {
    setConfig((current) => ({ ...current, [key]: { ...nodeConfig(key), ...patch } }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await forgeApi.saveWorkflow(definition, 'created in the console');
      router.push('/console/workflows/' + result.key);
    } catch (err) {
      setSaveError((err as Error).message);
      setSaving(false);
    }
  };

  const canSave = validation?.valid === true && !saving;

  return (
    <>
      <PageHeader
        title="Workflow editor"
        subtitle="Compose a DAG, validate it against the engine, and save it as a new version"
        actions={
          <>
            {saveError && <span style={{ color: 'var(--state-error)' }}>{saveError}</span>}
            <button
              className={ui.button + ' ' + ui.buttonPrimary}
              onClick={() => void save()}
              disabled={!canSave}
              title={
                validation?.valid === false ? 'Fix the validation errors before saving' : undefined
              }
            >
              {saving ? 'Saving…' : 'Save workflow'}
            </button>
          </>
        }
      />

      <div className={styles.toolbar}>
        <input
          className={ui.input}
          style={{ maxWidth: 220 }}
          value={meta.key}
          onChange={(e) => setMeta({ ...meta, key: e.target.value })}
          placeholder="workflow-key"
          aria-label="Workflow key"
        />
        <input
          className={ui.input}
          style={{ maxWidth: 280 }}
          value={meta.name}
          onChange={(e) => setMeta({ ...meta, name: e.target.value })}
          placeholder="Display name"
          aria-label="Workflow name"
        />
        <input
          className={ui.input}
          value={meta.description}
          onChange={(e) => setMeta({ ...meta, description: e.target.value })}
          placeholder="Description (optional)"
          aria-label="Workflow description"
        />
      </div>

      <div className={styles.layout}>
        {/* --- palette + structure ------------------------------------------ */}
        <div className={styles.panel}>
          <div className={styles.panelHeader}>Task types</div>
          <div className={styles.panelBody}>
            {PALETTE.map((entry) => (
              <button
                key={entry.type}
                className={styles.paletteItem}
                onClick={() => addNode(entry.type)}
              >
                <span className={styles.paletteType}>{entry.type}</span>
                <span className={styles.paletteDescription}>{entry.description}</span>
              </button>
            ))}

            <div
              className={styles.panelHeader}
              style={{ padding: 'var(--space-4) 0 var(--space-2)' }}
            >
              Nodes ({nodes.length})
            </div>
            <div className={styles.nodeList}>
              {nodes.map((node) => (
                <div
                  key={node.id}
                  className={
                    styles.nodeItem + (selected === node.id ? ' ' + styles.nodeItemActive : '')
                  }
                >
                  <button
                    onClick={() => setSelected(node.id)}
                    style={{ flex: 1, textAlign: 'left' }}
                  >
                    <span className={styles.nodeItemKey}>{node.id}</span>{' '}
                    <span className={styles.nodeItemType}>{(node.data as TaskNodeData).type}</span>
                  </button>
                  <button
                    className={styles.deleteButton}
                    onClick={() => removeNode(node.id)}
                    aria-label={'Remove ' + node.id}
                    title="Remove node"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {edges.length > 0 && (
              <>
                <div
                  className={styles.panelHeader}
                  style={{ padding: 'var(--space-4) 0 var(--space-2)' }}
                >
                  Dependencies ({edges.length})
                </div>
                <div className={styles.edgeList}>
                  {edges.map((edge) => (
                    <div key={edge.id} className={styles.edgeItem}>
                      <span>
                        {edge.source} → {edge.target}
                      </span>
                      <button
                        className={styles.deleteButton}
                        onClick={() =>
                          setEdges((current) => current.filter((e) => e.id !== edge.id))
                        }
                        aria-label={'Remove edge ' + edge.id}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* --- canvas -------------------------------------------------------- */}
        <div className={styles.panel + ' ' + styles.canvasWrap}>
          <ReactFlow
            nodes={nodes.map((n) => ({ ...n, selected: n.id === selected }))}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelected(node.id)}
            onPaneClick={() => setSelected(null)}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={1.6}
            nodesConnectable
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {/* --- inspector ----------------------------------------------------- */}
        <div className={styles.panel + ' ' + styles.inspector}>
          <div className={styles.panelHeader}>{selected ? 'Node · ' + selected : 'Validation'}</div>
          <div className={styles.panelBody}>
            {selected ? (
              <NodeInspector
                nodeKey={selected}
                settings={nodeConfig(selected)}
                onChange={(patch) => updateConfig(selected, patch)}
                onDone={() => setSelected(null)}
              />
            ) : (
              <ValidationPanel validation={validation} />
            )}
          </div>
        </div>
      </div>

      <p className={ui.hint} style={{ marginTop: 'var(--space-3)' }}>
        Drag from a node&apos;s right handle to another node&apos;s left handle to add a dependency.
        Connections that would create a cycle are refused. Validation runs against the API, using
        the same engine that executes the workflow.
      </p>
    </>
  );
}

function ValidationPanel({
  validation,
}: {
  validation: {
    valid: boolean;
    errors: Array<{ code: string; message: string; target: string }>;
    warnings: Array<{ code: string; message: string; target: string }>;
    analysis?: { nodes: number; edges: number; entryNodes: string[]; criticalPath: number };
  } | null;
}): ReactNode {
  if (!validation) {
    return <p className={ui.muted}>Validating…</p>;
  }

  return (
    <div className={styles.issues}>
      {validation.valid && validation.errors.length === 0 && (
        <>
          <span className={styles.valid}>✓ Valid DAG</span>
          {validation.analysis && (
            <div className={styles.validMeta}>
              {validation.analysis.nodes} nodes · {validation.analysis.edges} edges · critical path{' '}
              {validation.analysis.criticalPath} deep
              <br />
              Entry: {validation.analysis.entryNodes.join(', ') || '—'}
            </div>
          )}
        </>
      )}

      {validation.errors.map((issue, index) => (
        <div key={'e' + index} className={styles.issue + ' ' + styles.issueError}>
          <span className={styles.issueTarget}>{issue.target}</span>
          {issue.message}
        </div>
      ))}

      {validation.warnings.map((issue, index) => (
        <div key={'w' + index} className={styles.issue + ' ' + styles.issueWarning}>
          <span className={styles.issueTarget}>{issue.target}</span>
          {issue.message}
        </div>
      ))}
    </div>
  );
}

function NodeInspector({
  nodeKey,
  settings,
  onChange,
  onDone,
}: {
  nodeKey: string;
  settings: {
    timeoutMs: number;
    maxAttempts: number;
    queue: string;
    condition: string;
    config: string;
  };
  onChange: (patch: Partial<typeof settings>) => void;
  onDone: () => void;
}): ReactNode {
  return (
    <>
      <div className={ui.field}>
        <label className={ui.label} htmlFor={'queue-' + nodeKey}>
          Queue
        </label>
        <input
          id={'queue-' + nodeKey}
          className={ui.input}
          value={settings.queue}
          onChange={(e) => onChange({ queue: e.target.value })}
        />
        <p className={ui.hint}>Only workers subscribed to this queue will run the node.</p>
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor={'timeout-' + nodeKey}>
          Timeout (ms)
        </label>
        <input
          id={'timeout-' + nodeKey}
          className={ui.input}
          type="number"
          min={100}
          value={settings.timeoutMs}
          onChange={(e) => onChange({ timeoutMs: Number(e.target.value) })}
        />
        <p className={ui.hint}>Wall-clock budget for a single attempt.</p>
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor={'attempts-' + nodeKey}>
          Max attempts
        </label>
        <input
          id={'attempts-' + nodeKey}
          className={ui.input}
          type="number"
          min={1}
          max={20}
          value={settings.maxAttempts}
          onChange={(e) => onChange({ maxAttempts: Number(e.target.value) })}
        />
        <p className={ui.hint}>
          Exponential backoff: 1s, 2s, 4s… Exceeding this dead-letters the task.
        </p>
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor={'condition-' + nodeKey}>
          Condition (optional)
        </label>
        <input
          id={'condition-' + nodeKey}
          className={ui.input}
          value={settings.condition}
          onChange={(e) => onChange({ condition: e.target.value })}
          placeholder="$.input.branch == 'main'"
        />
        <p className={ui.hint}>A falsy result skips the node without failing the run.</p>
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor={'config-' + nodeKey}>
          Handler config (JSON)
        </label>
        <textarea
          id={'config-' + nodeKey}
          className={ui.textarea}
          value={settings.config}
          onChange={(e) => onChange({ config: e.target.value })}
          spellCheck={false}
          rows={6}
        />
      </div>

      <button className={ui.button} onClick={onDone}>
        Back to validation
      </button>
    </>
  );
}
