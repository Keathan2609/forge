import { ExecutionEventType, TaskRunState } from '@forge/contracts';
import { assertTaskTransition } from '@forge/engine';
import { type Prisma, type PrismaClient, withTransaction } from '../client';
import { recordEvent } from '../events';
import { signalAdvance } from './runs';
import { requeueTaskDispatch } from './tasks';

/**
 * Dead-letter operations.
 *
 * A dead letter is a task that exhausted its retry budget. It is deliberately *not*
 * deleted or auto-retried: the point of the queue is that a human decides whether the
 * underlying cause has been fixed. Retrying is therefore an explicit operator action
 * with an audit trail.
 */

export interface RetryDeadLetterResult {
  retried: boolean;
  reason?: 'not-found' | 'already-resolved' | 'run-terminal' | 'illegal-state';
  taskRunId?: string;
  workflowRunId?: string;
}

/**
 * Return a dead-lettered task to the queue, in place, inside its original run.
 *
 * `resetAttempts` clears the failure counter so the node gets its full retry budget
 * again. Without it the task would be re-queued and immediately dead-letter on its
 * first failure, which is almost never what an operator wants after fixing a bug.
 */
export async function retryDeadLetter(
  prisma: PrismaClient,
  deadLetterId: string,
  options: { resetAttempts?: boolean; input?: Record<string, unknown>; actor?: string } = {},
): Promise<RetryDeadLetterResult> {
  return withTransaction(prisma, async (tx) => {
    const dl = await tx.deadLetter.findUnique({
      where: { id: deadLetterId },
      select: {
        id: true,
        status: true,
        taskRunId: true,
        workflowRunId: true,
        nodeKey: true,
        run: { select: { state: true, cancelRequested: true } },
      },
    });
    if (!dl) return { retried: false, reason: 'not-found' };
    if (dl.status !== 'OPEN') return { retried: false, reason: 'already-resolved' };

    const runTerminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(dl.run.state);
    if (runTerminal || dl.run.cancelRequested) {
      // A finished run cannot absorb new work: the replay endpoint (which starts a
      // fresh run) is the right tool here, and the API surfaces that distinction.
      return { retried: false, reason: 'run-terminal' };
    }

    await tx.$queryRaw`SELECT id FROM task_run WHERE id = ${dl.taskRunId}::uuid FOR UPDATE`;

    const task = await tx.taskRun.findUnique({
      where: { id: dl.taskRunId },
      select: { id: true, state: true },
    });
    if (!task) return { retried: false, reason: 'not-found' };

    const from = task.state as TaskRunState;
    if (
      from !== TaskRunState.DEAD_LETTERED &&
      from !== TaskRunState.FAILED &&
      from !== TaskRunState.TIMED_OUT
    ) {
      return { retried: false, reason: 'illegal-state' };
    }
    assertTaskTransition(from, TaskRunState.QUEUED);

    await tx.taskRun.updateMany({
      where: { id: dl.taskRunId, state: from },
      data: {
        state: TaskRunState.QUEUED,
        ...(options.resetAttempts === false ? {} : { failures: 0 }),
        ...(options.input ? { input: options.input as Prisma.InputJsonValue } : {}),
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        nextAttemptAt: null,
        queuedAt: new Date(),
      },
    });

    await tx.deadLetter.update({
      where: { id: dl.id },
      data: {
        status: 'REPLAYED',
        resolvedAt: new Date(),
        resolvedBy: options.actor ?? 'operator',
      },
    });

    await recordEvent(tx, {
      workflowRunId: dl.workflowRunId,
      type: ExecutionEventType.DEAD_LETTER_REPLAYED,
      taskRunId: dl.taskRunId,
      nodeKey: dl.nodeKey,
      message: dl.nodeKey + ' replayed from the dead-letter queue',
      payload: {
        resetAttempts: options.resetAttempts !== false,
        actor: options.actor ?? 'operator',
      },
    });

    await requeueTaskDispatch(tx, dl.taskRunId);
    await signalAdvance(tx, dl.workflowRunId, 'dead-letter-replay');

    return { retried: true, taskRunId: dl.taskRunId, workflowRunId: dl.workflowRunId };
  });
}

/** Acknowledge a dead letter without retrying — "we know, we are not going to fix it". */
export async function acknowledgeDeadLetter(
  prisma: PrismaClient,
  deadLetterId: string,
  actor = 'operator',
): Promise<boolean> {
  return withTransaction(prisma, async (tx) => {
    const dl = await tx.deadLetter.findUnique({
      where: { id: deadLetterId },
      select: { id: true, status: true, workflowRunId: true, nodeKey: true, taskRunId: true },
    });
    if (!dl || dl.status !== 'OPEN') return false;

    await tx.deadLetter.update({
      where: { id: dl.id },
      data: { status: 'ACKNOWLEDGED', resolvedAt: new Date(), resolvedBy: actor },
    });

    await recordEvent(tx, {
      workflowRunId: dl.workflowRunId,
      type: ExecutionEventType.DEAD_LETTER_ACKNOWLEDGED,
      taskRunId: dl.taskRunId,
      nodeKey: dl.nodeKey,
      message: dl.nodeKey + ' dead letter acknowledged by ' + actor,
    });

    return true;
  });
}

export async function countOpenDeadLetters(prisma: PrismaClient): Promise<number> {
  return prisma.deadLetter.count({ where: { status: 'OPEN' } });
}
