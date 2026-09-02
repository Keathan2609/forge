/** Errors raised by the engine. All are deterministic and carry a stable `code`. */

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** The workflow definition is structurally invalid and must not be persisted. */
export class GraphValidationError extends EngineError {
  constructor(
    message: string,
    readonly issues: ValidationIssue[],
  ) {
    super(message, 'GRAPH_INVALID', { issues });
  }
}

/**
 * A state transition was attempted that the state machine forbids.
 *
 * Reaching this in production means a caller bypassed the guarded transition helpers,
 * so it is treated as a programming error rather than a runtime condition.
 */
export class IllegalTransitionError extends EngineError {
  constructor(
    readonly entity: 'workflowRun' | 'taskRun' | 'taskAttempt',
    readonly from: string,
    readonly to: string,
  ) {
    super(`illegal ${entity} transition ${from} -> ${to}`, 'ILLEGAL_TRANSITION', {
      entity,
      from,
      to,
    });
  }
}

/** A condition expression failed to parse or evaluate. */
export class ExpressionError extends EngineError {
  constructor(
    message: string,
    readonly expression: string,
    readonly position?: number,
  ) {
    super(message, 'EXPRESSION_INVALID', { expression, position });
  }
}

/** An input mapping referenced a path that does not exist in the context. */
export class ContextResolutionError extends EngineError {
  constructor(
    readonly path: string,
    message = `cannot resolve "${path}" in execution context`,
  ) {
    super(message, 'CONTEXT_PATH_UNRESOLVED', { path });
  }
}

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: ValidationCode;
  message: string;
  /** Node key, edge descriptor or `$` for graph-level issues. */
  target: string;
}

export const ValidationCode = {
  DUPLICATE_NODE_KEY: 'DUPLICATE_NODE_KEY',
  UNKNOWN_EDGE_SOURCE: 'UNKNOWN_EDGE_SOURCE',
  UNKNOWN_EDGE_TARGET: 'UNKNOWN_EDGE_TARGET',
  DUPLICATE_EDGE: 'DUPLICATE_EDGE',
  SELF_LOOP: 'SELF_LOOP',
  CYCLE: 'CYCLE',
  NO_ENTRY_NODE: 'NO_ENTRY_NODE',
  UNREACHABLE_NODE: 'UNREACHABLE_NODE',
  INVALID_CONDITION: 'INVALID_CONDITION',
  INVALID_INPUT_REFERENCE: 'INVALID_INPUT_REFERENCE',
  UNKNOWN_TASK_TYPE: 'UNKNOWN_TASK_TYPE',
  TIMEOUT_EXCEEDS_WORKFLOW: 'TIMEOUT_EXCEEDS_WORKFLOW',
  EMPTY_GRAPH: 'EMPTY_GRAPH',
} as const;
export type ValidationCode = (typeof ValidationCode)[keyof typeof ValidationCode];
