'use client';

import { memo, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { formatDuration, shortId, stateLabel } from '@/lib/format';
import styles from './node.module.css';

/**
 * A task node in the DAG.
 *
 * Rendered for both the static definition view (no run state) and the live execution
 * view (with state, attempts, worker, duration). One component for both so the graph a
 * user authors looks exactly like the graph they later watch execute.
 */

export interface TaskNodeData extends Record<string, unknown> {
  nodeKey: string;
  type: string;
  state?: string;
  attempts?: number;
  maxAttempts?: number;
  durationMs?: number | null;
  workerId?: string | null;
  errorMessage?: string | null;
  queue?: string;
  selected?: boolean;
}

/** Map a task state onto one of the node's visual variants. */
function variantFor(state: string | undefined): string {
  switch (state) {
    case 'SUCCEEDED':
      return styles.succeeded as string;
    case 'RUNNING':
      return styles.running as string;
    case 'RETRYING':
      return styles.retrying as string;
    case 'FAILED':
    case 'TIMED_OUT':
    case 'DEAD_LETTERED':
      return styles.failed as string;
    case 'QUEUED':
    case 'READY':
      return styles.queued as string;
    case 'SKIPPED':
      return styles.skipped as string;
    default:
      return styles.idle as string;
  }
}

function TaskNodeComponent({ data, selected }: NodeProps): ReactNode {
  const node = data as TaskNodeData;
  const isRunning = node.state === 'RUNNING';
  const showAttempts = (node.attempts ?? 0) > 1;

  return (
    <div
      className={
        styles.node + ' ' + variantFor(node.state) + (selected ? ' ' + styles.selected : '')
      }
    >
      <Handle type="target" position={Position.Left} />
      <span className={styles.accent} />

      <div className={styles.body}>
        <div className={styles.header}>
          <span className={styles.key} title={node.nodeKey}>
            {node.nodeKey}
          </span>
          {showAttempts && (
            <span className={styles.attempt} title="attempts used">
              ×{node.attempts}
            </span>
          )}
        </div>

        <div className={styles.meta}>
          <span className={styles.type} title={node.type}>
            {node.type}
          </span>
          {node.state !== undefined && (
            <span className={styles.state}>{stateLabel(node.state)}</span>
          )}
        </div>

        {(node.durationMs !== undefined && node.durationMs !== null) || node.workerId ? (
          <div className={styles.meta}>
            <span className={styles.worker}>{node.workerId ? shortId(node.workerId, 8) : ''}</span>
            <span className={styles.duration}>
              {node.durationMs !== undefined && node.durationMs !== null
                ? formatDuration(node.durationMs)
                : ''}
            </span>
          </div>
        ) : null}

        {node.errorMessage && (
          <div className={styles.error} title={node.errorMessage}>
            {node.errorMessage}
          </div>
        )}
      </div>

      {isRunning && (
        <div className={styles.activity}>
          <span className={styles.activityBar} />
        </div>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// Memoised: a run with 40 nodes re-renders on every SSE event, and only the nodes whose
// data actually changed should pay for it.
export const TaskNode = memo(TaskNodeComponent);
