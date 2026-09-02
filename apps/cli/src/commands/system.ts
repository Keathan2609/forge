import type { Command } from 'commander';
import { createClient, EXIT, type GlobalOptions } from '../bin';
import { colour, details, emit, formatDuration, heading, stateColour, table } from '../output';

/** `forge system …` */
export function registerSystemCommands(program: Command): void {
  const system = program.command('system').description('platform health and throughput');

  system
    .command('status', { isDefault: true })
    .description('component health check')
    .action(async () => {
      const options = program.opts<GlobalOptions>();
      const status = await createClient(options).system.status();

      emit(options.json, status, () => {
        const mark = (ok: boolean): string => (ok ? colour.green('●') : colour.red('●'));
        const c = status.components;

        return [
          heading(
            'FORGE ' +
              (status.status === 'healthy' ? colour.green('healthy') : colour.yellow('degraded')) +
              colour.dim('  v' + status.version),
          ),
          details([
            [
              'postgres',
              mark(c.database.ok) +
                '  ' +
                (c.database.ok
                  ? c.database.latencyMs + 'ms'
                  : colour.red(c.database.message ?? 'unreachable')),
            ],
            [
              'redis',
              mark(c.redis.ok) +
                '  ' +
                (c.redis.ok
                  ? c.redis.latencyMs + 'ms'
                  : colour.red(c.redis.message ?? 'unreachable')),
            ],
            [
              'workers',
              mark(c.workers.ok) +
                '  ' +
                c.workers.online +
                ' online' +
                (c.workers.unresponsive > 0
                  ? colour.yellow(', ' + c.workers.unresponsive + ' unresponsive')
                  : ''),
            ],
            [
              'outbox',
              mark(c.outbox.ok) +
                '  ' +
                c.outbox.pending +
                ' pending' +
                (c.outbox.oldestPendingAgeMs !== null
                  ? ', oldest ' + formatDuration(c.outbox.oldestPendingAgeMs)
                  : ''),
            ],
          ]),
        ].join('\n');
      });

      // Non-zero exit so `forge system status` is usable as a CI gate.
      if (status.status !== 'healthy') process.exit(EXIT.FAILED_OUTCOME);
    });

  system
    .command('stats')
    .description('throughput and success rate over the last 24 hours')
    .action(async () => {
      const options = program.opts<GlobalOptions>();
      const stats = await createClient(options).system.stats();

      emit(options.json, stats, () => {
        const sparkline = renderSparkline(stats.throughput.map((t) => t.started));

        return [
          heading('Execution'),
          details([
            ['active runs', String(stats.runs.active)],
            ['queued tasks', String(stats.runs.queuedTasks)],
            ['running tasks', String(stats.runs.runningTasks)],
            [
              'last 24h',
              stats.runs.last24h.total +
                ' runs · ' +
                colour.green(String(stats.runs.last24h.succeeded)) +
                ' succeeded · ' +
                colour.red(String(stats.runs.last24h.failed)) +
                ' failed',
            ],
            [
              'success rate',
              stats.runs.successRate === null
                ? '—'
                : (stats.runs.successRate * 100).toFixed(1) + '%',
            ],
          ]),
          heading('Fleet'),
          details([
            ['online', String(stats.workers.online)],
            ['capacity', String(stats.workers.totalCapacity)],
            ['executing', String(stats.workers.activeTasks)],
            [
              'dead letters',
              stats.deadLetters.open > 0
                ? colour.red(String(stats.deadLetters.open) + ' open')
                : '0',
            ],
            [
              'outbox',
              stats.outbox.pending +
                ' pending' +
                (stats.outbox.failed > 0 ? colour.red(', ' + stats.outbox.failed + ' failed') : ''),
            ],
          ]),
          heading('Runs started, hourly (24h)'),
          '  ' + sparkline,
          heading('Recent runs'),
          table(stats.recentRuns, [
            { header: 'RUN', value: (r) => r.id.slice(0, 8) },
            { header: 'WORKFLOW', value: (r) => r.workflowKey },
            {
              header: 'STATE',
              value: (r) => r.state,
              render: (cell) => stateColour(cell.trimEnd()) + cell.slice(cell.trimEnd().length),
            },
            { header: 'DURATION', value: (r) => formatDuration(r.durationMs), align: 'right' },
          ]),
        ].join('\n');
      });
    });
}

/**
 * A Unicode sparkline for the hourly throughput series.
 *
 * Eight block characters is enough resolution to see a shape in a terminal, and it costs
 * nothing next to pulling a charting dependency into a CLI.
 */
function renderSparkline(values: number[]): string {
  if (values.length === 0) return colour.dim('(no data)');
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...values, 1);
  return (
    values
      .map((value) => {
        if (value === 0) return colour.dim('·');
        const index = Math.min(blocks.length - 1, Math.floor((value / max) * (blocks.length - 1)));
        return blocks[index] as string;
      })
      .join('') + colour.dim('  peak ' + max + '/h')
  );
}
