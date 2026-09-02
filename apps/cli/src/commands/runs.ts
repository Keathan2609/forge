import type { Command } from 'commander';
import type { ExecutionEvent, WorkflowRunView } from '@forge/sdk';
import { createClient, EXIT, type GlobalOptions } from '../bin';
import {
  colour,
  details,
  emit,
  formatDuration,
  formatRelative,
  formatTime,
  heading,
  stateColour,
  table,
  truncate,
} from '../output';

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

/** `forge runs …` and the top-level `forge run` shortcut. */
export function registerRunCommands(program: Command): void {
  const runs = program.command('runs').description('inspect and control workflow executions');

  runs
    .command('list')
    .alias('ls')
    .description('list recent workflow runs')
    .option('-w, --workflow <key>', 'filter by workflow key')
    .option('-s, --state <state>', 'filter by run state')
    .option('-n, --limit <n>', 'number of runs to show', (v) => Number(v), 20)
    .action(async (opts: { workflow?: string; state?: string; limit: number }) => {
      const options = program.opts<GlobalOptions>();
      const page = await createClient(options).runs.list({
        ...(opts.workflow ? { workflowKey: opts.workflow } : {}),
        ...(opts.state ? { state: opts.state.toUpperCase() } : {}),
        limit: opts.limit,
      });

      emit(options.json, page, () =>
        table(page.items, [
          { header: 'RUN ID', value: (r) => r.id.slice(0, 8) },
          { header: 'WORKFLOW', value: (r) => truncate(r.workflowKey, 24) },
          { header: 'VER', value: (r) => 'v' + r.version, align: 'right' },
          {
            header: 'STATE',
            value: (r) => r.state,
            render: (cell) => stateColour(cell.trimEnd()) + cell.slice(cell.trimEnd().length),
          },
          {
            header: 'TASKS',
            value: (r) => r.counts.succeeded + '/' + r.counts.total,
            align: 'right',
          },
          { header: 'DURATION', value: (r) => formatDuration(r.durationMs), align: 'right' },
          { header: 'TRIGGERED', value: (r) => truncate(r.triggeredBy, 18) },
          { header: 'STARTED', value: (r) => formatRelative(r.createdAt) },
        ]),
      );
    });

  runs
    .command('inspect <runId>')
    .alias('get')
    .description('show a run, its tasks and its execution timeline')
    .option('--timeline', 'include the full event timeline', false)
    .option('--io', 'include task inputs and outputs', false)
    .action(async (runId: string, opts: { timeline: boolean; io: boolean }) => {
      const options = program.opts<GlobalOptions>();
      const client = createClient(options);
      const run = await client.runs.get(runId);
      const events = opts.timeline ? await client.runs.events(runId) : [];

      emit(options.json, opts.timeline ? { ...run, events } : run, () => {
        const out = [
          heading(run.workflowName + colour.dim('  ' + run.id)),
          details([
            ['state', stateColour(run.state)],
            ['workflow', run.workflowKey + ' v' + run.version],
            ['triggered by', run.triggeredBy],
            ['created', formatRelative(run.createdAt)],
            ['duration', formatDuration(run.durationMs)],
            ['trace id', run.traceId],
            ['error', run.errorMessage ? colour.red(run.errorMessage) : null],
            ['output', run.output ? JSON.stringify(run.output) : null],
          ]),
          heading('Tasks'),
          table(run.tasks ?? [], [
            { header: 'NODE', value: (t) => t.nodeKey },
            { header: 'TYPE', value: (t) => t.type },
            {
              header: 'STATE',
              value: (t) => t.state,
              render: (cell) => stateColour(cell.trimEnd()) + cell.slice(cell.trimEnd().length),
            },
            {
              header: 'ATTEMPTS',
              value: (t) => t.attempts + '/' + t.maxAttempts,
              align: 'right',
            },
            { header: 'DURATION', value: (t) => formatDuration(t.durationMs), align: 'right' },
            { header: 'WORKER', value: (t) => (t.workerId ? t.workerId.slice(0, 8) : '—') },
            { header: 'ERROR', value: (t) => truncate(t.errorMessage ?? '—', 36) },
          ]),
        ];

        if (opts.io) {
          out.push(heading('Task inputs and outputs'));
          for (const task of run.tasks ?? []) {
            out.push(
              '  ' + colour.bold(task.nodeKey),
              '    ' + colour.dim('input  ') + JSON.stringify(task.input ?? null),
              '    ' + colour.dim('output ') + JSON.stringify(task.output ?? null),
            );
          }
        }

        if (opts.timeline) {
          out.push(heading('Timeline'), renderTimeline(events));
        }

        return out.join('\n');
      });

      if (['FAILED', 'TIMED_OUT'].includes(run.state)) process.exit(EXIT.FAILED_OUTCOME);
    });

  runs
    .command('cancel <runId>')
    .description('request cancellation of a running workflow')
    .option('-r, --reason <text>', 'reason recorded on the run')
    .action(async (runId: string, opts: { reason?: string }) => {
      const options = program.opts<GlobalOptions>();
      const result = await createClient(options).runs.cancel(runId, opts.reason);

      emit(options.json, result, () =>
        result.accepted ? colour.yellow('· ') + result.message : colour.dim('· ') + result.message,
      );
      if (!result.accepted) process.exit(EXIT.FAILED_OUTCOME);
    });

  runs
    .command('replay <runId>')
    .description('start a new run from an existing one')
    .option('--latest', 'replay against the latest workflow version', false)
    .action(async (runId: string, opts: { latest: boolean }) => {
      const options = program.opts<GlobalOptions>();
      const result = await createClient(options).runs.replay(runId, {
        useLatestVersion: opts.latest,
      });
      emit(
        options.json,
        result,
        () => colour.green('✓ ') + 'replayed as ' + result.runId + ' (v' + result.version + ')',
      );
    });

  // --- top-level `forge run` -------------------------------------------------
  program
    .command('run <workflowKey> [input]')
    .description('trigger a workflow run; `input` is a JSON object')
    .option('-w, --watch', 'stream the timeline until the run finishes', false)
    .option('--wait', 'wait for completion without streaming events', false)
    .option('--version <n>', 'pin the run to a workflow version', (v) => Number(v))
    .option('--idempotency-key <key>', 'deduplicate this trigger')
    .option('--timeout <ms>', 'how long to wait', (v) => Number(v), 300_000)
    .action(
      async (
        workflowKey: string,
        input: string | undefined,
        opts: {
          watch: boolean;
          wait: boolean;
          version?: number;
          idempotencyKey?: string;
          timeout: number;
        },
      ) => {
        const options = program.opts<GlobalOptions>();
        const client = createClient(options);

        let parsedInput: Record<string, unknown> = {};
        if (input) {
          try {
            parsedInput = JSON.parse(input) as Record<string, unknown>;
          } catch {
            process.stderr.write(
              colour.red('error: ') + 'input must be a JSON object, e.g. \'{"branch":"main"}\'\n',
            );
            process.exit(EXIT.USAGE);
          }
        }

        const triggered = await client.workflows.trigger(workflowKey, parsedInput, {
          ...(opts.version !== undefined ? { version: opts.version } : {}),
          ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        });

        if (!options.json) {
          process.stdout.write(
            (triggered.created ? colour.green('✓ ') : colour.dim('· ')) +
              'run ' +
              colour.bold(triggered.runId) +
              ' (' +
              workflowKey +
              ' v' +
              triggered.version +
              ')' +
              (triggered.created ? '' : colour.dim(' — existing run returned (idempotent)')) +
              '\n',
          );
        }

        if (!opts.watch && !opts.wait) {
          if (options.json) process.stdout.write(JSON.stringify(triggered, null, 2) + '\n');
          return;
        }

        const run = opts.watch
          ? await watchRun(client, triggered.runId, opts.timeout, options.json)
          : await client.runs.wait(triggered.runId, { timeoutMs: opts.timeout });

        if (options.json) {
          process.stdout.write(JSON.stringify(run, null, 2) + '\n');
        } else {
          process.stdout.write(
            '\n' +
              (run.state === 'SUCCEEDED' ? colour.green('✓ ') : colour.red('✗ ')) +
              run.state +
              ' in ' +
              formatDuration(run.durationMs) +
              (run.errorMessage ? '\n  ' + colour.red(run.errorMessage) : '') +
              '\n',
          );
        }

        if (run.state !== 'SUCCEEDED') process.exit(EXIT.FAILED_OUTCOME);
      },
    );
}

/**
 * Stream a run's timeline until it finishes.
 *
 * Uses the SSE stream for immediacy but *also* polls the run: the stream tells you what
 * happened, the poll tells you when it is over. Relying on the stream alone would mean a
 * dropped connection at the wrong moment leaves the CLI hanging forever.
 */
async function watchRun(
  client: ReturnType<typeof createClient>,
  runId: string,
  timeoutMs: number,
  json: boolean,
): Promise<WorkflowRunView> {
  if (!json) process.stdout.write(colour.dim('  watching…\n\n'));

  const unsubscribe = client.streamRun(runId, {
    onEvent: (event) => {
      if (json) return;
      process.stdout.write(renderEvent(event) + '\n');
    },
    onError: () => {
      // The stream reconnects on its own; the poll below is the authority on completion.
    },
  });

  try {
    return await client.runs.wait(runId, { timeoutMs });
  } finally {
    unsubscribe();
  }
}

function renderTimeline(events: ExecutionEvent[]): string {
  if (events.length === 0) return colour.dim('  (no events)');
  return events.map((e) => renderEvent(e)).join('\n');
}

function renderEvent(event: ExecutionEvent): string {
  const time = colour.dim(formatTime(event.occurredAt));
  const type = eventColour(event.type).padEnd(0);
  const node = event.nodeKey ? colour.bold(event.nodeKey) : '';
  return (
    '  ' +
    time +
    '  ' +
    type +
    (node ? '  ' + node : '') +
    (event.message ? '  ' + colour.dim(truncate(event.message, 76)) : '')
  );
}

function eventColour(type: string): string {
  const padded = type.padEnd(22);
  if (type.includes('COMPLETED') || type.includes('SUCCEEDED')) return colour.green(padded);
  if (type.includes('FAILED') || type.includes('DEAD_LETTER') || type.includes('TIMED_OUT')) {
    return colour.red(padded);
  }
  if (type.includes('RETRY') || type.includes('EXPIRED') || type.includes('RECOVERED')) {
    return colour.yellow(padded);
  }
  if (type.includes('STARTED') || type.includes('QUEUED')) return colour.cyan(padded);
  return colour.dim(padded);
}

export { TERMINAL };
