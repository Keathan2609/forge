import type { Command } from 'commander';
import { createClient, EXIT, type GlobalOptions } from '../bin';
import {
  colour,
  details,
  emit,
  formatDuration,
  formatRelative,
  heading,
  stateColour,
  table,
  truncate,
} from '../output';

/** `forge workers`, `forge dead-letters` and `forge schedules`. */
export function registerOperationsCommands(program: Command): void {
  // --- workers ---------------------------------------------------------------
  const workers = program.command('workers').description('inspect the worker fleet');

  workers
    .command('list', { isDefault: true })
    .alias('ls')
    .description('list registered workers and what they are running')
    .option('--all', 'include offline workers', false)
    .action(async (opts: { all: boolean }) => {
      const options = program.opts<GlobalOptions>();
      const all = await createClient(options).workers.list();
      const items = opts.all ? all : all.filter((w) => w.state !== 'OFFLINE');

      emit(options.json, items, () => {
        const online = items.filter((w) => w.state === 'ONLINE');
        const capacity = online.reduce((sum, w) => sum + w.concurrency, 0);
        const active = items.reduce((sum, w) => sum + w.activeTasks, 0);

        return [
          table(items, [
            { header: 'NAME', value: (w) => truncate(w.name, 26) },
            {
              header: 'STATE',
              value: (w) => w.state,
              render: (cell) => stateColour(cell.trimEnd()) + cell.slice(cell.trimEnd().length),
            },
            { header: 'HOST', value: (w) => truncate(w.hostname, 16) },
            {
              header: 'LOAD',
              value: (w) => w.activeTasks + '/' + w.concurrency,
              align: 'right',
            },
            { header: 'DONE', value: (w) => String(w.tasksCompleted), align: 'right' },
            { header: 'FAILED', value: (w) => String(w.tasksFailed), align: 'right' },
            { header: 'QUEUES', value: (w) => truncate(w.queues.join(','), 22) },
            { header: 'UPTIME', value: (w) => formatDuration(w.uptimeSeconds * 1000) },
            { header: 'HEARTBEAT', value: (w) => formatRelative(w.lastHeartbeatAt) },
          ]),
          '',
          colour.dim(
            '  ' +
              online.length +
              ' online · capacity ' +
              capacity +
              ' · ' +
              active +
              ' task(s) executing',
          ),
        ].join('\n');
      });
    });

  // --- dead letters ----------------------------------------------------------
  const deadLetters = program
    .command('dead-letters')
    .alias('dlq')
    .description('inspect and resolve tasks that exhausted their retry budget');

  deadLetters
    .command('list', { isDefault: true })
    .alias('ls')
    .description('list dead-lettered tasks')
    .option('-s, --status <status>', 'OPEN | REPLAYED | ACKNOWLEDGED', 'OPEN')
    .option('-n, --limit <n>', 'number to show', (v) => Number(v), 20)
    .action(async (opts: { status: string; limit: number }) => {
      const options = program.opts<GlobalOptions>();
      const page = await createClient(options).deadLetters.list({
        status: opts.status.toUpperCase(),
        limit: opts.limit,
      });

      emit(options.json, page, () =>
        table(page.items, [
          { header: 'ID', value: (d) => d.id.slice(0, 8) },
          { header: 'WORKFLOW', value: (d) => truncate(d.workflowKey, 22) },
          { header: 'NODE', value: (d) => truncate(d.nodeKey, 20) },
          { header: 'ATTEMPTS', value: (d) => String(d.attempts), align: 'right' },
          { header: 'CODE', value: (d) => d.errorCode ?? '—' },
          { header: 'ERROR', value: (d) => truncate(d.errorMessage, 38) },
          { header: 'CREATED', value: (d) => formatRelative(d.createdAt) },
        ]),
      );
    });

  deadLetters
    .command('inspect <id>')
    .description('show a dead letter with its full attempt history')
    .action(async (id: string) => {
      const options = program.opts<GlobalOptions>();
      const page = await createClient(options).deadLetters.list({ limit: 100 });
      const item = page.items.find((d) => d.id === id || d.id.startsWith(id));
      if (!item) {
        process.stderr.write(colour.red('error: ') + 'dead letter "' + id + '" not found\n');
        process.exit(EXIT.FAILED_OUTCOME);
      }

      emit(options.json, item, () =>
        [
          heading(item.workflowKey + ' / ' + item.nodeKey),
          details([
            ['id', item.id],
            ['status', item.status],
            ['handler type', item.type],
            ['attempts', String(item.attempts)],
            ['error code', item.errorCode],
            ['error', colour.red(item.errorMessage)],
            ['run', item.workflowRunId],
            ['task', item.taskRunId],
            ['created', formatRelative(item.createdAt)],
            ['input', JSON.stringify(item.input)],
          ]),
          heading('Attempts'),
          table(item.attemptHistory, [
            { header: '#', value: (a) => String(a.attemptNumber), align: 'right' },
            {
              header: 'STATE',
              value: (a) => a.state,
              render: (cell) => stateColour(cell.trimEnd()) + cell.slice(cell.trimEnd().length),
            },
            { header: 'WORKER', value: (a) => (a.workerId ? a.workerId.slice(0, 8) : '—') },
            { header: 'DURATION', value: (a) => formatDuration(a.durationMs), align: 'right' },
            { header: 'ERROR', value: (a) => truncate(a.errorMessage ?? '—', 46) },
          ]),
        ].join('\n'),
      );
    });

  deadLetters
    .command('retry <id>')
    .description('return a dead-lettered task to the queue')
    .option('--keep-attempts', 'do not reset the failure counter', false)
    .action(async (id: string, opts: { keepAttempts: boolean }) => {
      const options = program.opts<GlobalOptions>();
      const result = await createClient(options).deadLetters.retry(id, {
        resetAttempts: !opts.keepAttempts,
      });
      emit(
        options.json,
        result,
        () => colour.green('✓ ') + 'task requeued in run ' + (result.workflowRunId ?? ''),
      );
    });

  deadLetters
    .command('acknowledge <id>')
    .alias('ack')
    .description('mark a dead letter as reviewed without retrying it')
    .action(async (id: string) => {
      const options = program.opts<GlobalOptions>();
      const result = await createClient(options).deadLetters.acknowledge(id);
      emit(options.json, result, () => colour.dim('· ') + 'acknowledged');
    });

  // --- schedules -------------------------------------------------------------
  const schedules = program.command('schedules').description('manage recurring workflow runs');

  schedules
    .command('list', { isDefault: true })
    .alias('ls')
    .description('list schedules')
    .action(async () => {
      const options = program.opts<GlobalOptions>();
      const items = await createClient(options).schedules.list();

      emit(options.json, items, () =>
        table(items, [
          { header: 'ID', value: (s) => s.id.slice(0, 8) },
          { header: 'NAME', value: (s) => truncate(s.name, 26) },
          { header: 'WORKFLOW', value: (s) => truncate(s.workflowKey, 22) },
          { header: 'CRON', value: (s) => s.cron ?? 'one-shot' },
          { header: 'TZ', value: (s) => s.timezone },
          {
            header: 'ENABLED',
            value: (s) => (s.enabled ? 'yes' : 'no'),
            render: (cell, s) => (s.enabled ? colour.green(cell) : colour.dim(cell)),
          },
          { header: 'NEXT RUN', value: (s) => formatRelative(s.nextRunAt) },
          { header: 'LAST RUN', value: (s) => formatRelative(s.lastRunAt) },
        ]),
      );
    });

  schedules
    .command('pause <id>')
    .description('pause a schedule')
    .action(async (id: string) => {
      const options = program.opts<GlobalOptions>();
      const result = await createClient(options).schedules.setEnabled(id, false);
      emit(options.json, result, () => colour.yellow('· ') + 'schedule paused');
    });

  schedules
    .command('resume <id>')
    .description('resume a schedule; the next run is recomputed from now')
    .action(async (id: string) => {
      const options = program.opts<GlobalOptions>();
      const result = await createClient(options).schedules.setEnabled(id, true);
      emit(options.json, result, () => colour.green('✓ ') + 'schedule resumed');
    });
}
