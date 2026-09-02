import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { WorkflowDefinition } from '@forge/sdk';
import { createClient, EXIT, type GlobalOptions } from '../bin';
import {
  colour,
  details,
  emit,
  formatDuration,
  formatRelative,
  heading,
  table,
  truncate,
} from '../output';

/** `forge workflows …` */
export function registerWorkflowCommands(program: Command): void {
  const workflows = program.command('workflows').description('manage workflow definitions');

  workflows
    .command('list')
    .alias('ls')
    .description('list workflow definitions with their run statistics')
    .action(async () => {
      const options = program.opts<GlobalOptions>();
      const items = await createClient(options).workflows.list();

      emit(options.json, items, () =>
        items.length === 0
          ? colour.dim('  no workflows defined — try `pnpm demo:seed`')
          : table(items, [
              { header: 'KEY', value: (w) => w.key },
              { header: 'NAME', value: (w) => truncate(w.name, 28) },
              { header: 'VER', value: (w) => 'v' + w.latestVersion, align: 'right' },
              { header: 'NODES', value: (w) => String(w.nodeCount), align: 'right' },
              { header: 'RUNS', value: (w) => String(w.stats.total), align: 'right' },
              {
                header: 'SUCCESS',
                value: (w) =>
                  w.stats.successRate === null ? '—' : (w.stats.successRate * 100).toFixed(1) + '%',
                align: 'right',
                render: (cell, w) =>
                  w.stats.successRate === null
                    ? colour.dim(cell)
                    : w.stats.successRate >= 0.95
                      ? colour.green(cell)
                      : w.stats.successRate >= 0.8
                        ? colour.yellow(cell)
                        : colour.red(cell),
              },
              {
                header: 'AVG',
                value: (w) => formatDuration(w.stats.p50DurationMs),
                align: 'right',
              },
              { header: 'UPDATED', value: (w) => formatRelative(w.updatedAt) },
            ]),
      );
    });

  workflows
    .command('inspect <key>')
    .description('show a workflow definition, its graph shape and version history')
    .option('--version <n>', 'inspect a specific version', (v) => Number(v))
    .option('--definition', 'print the raw definition document', false)
    .action(async (key: string, opts: { version?: number; definition: boolean }) => {
      const options = program.opts<GlobalOptions>();
      const client = createClient(options);

      const workflow = await client.workflows.get(key, opts.version);
      const versions = await client.workflows.versions(key);

      if (opts.definition) {
        process.stdout.write(JSON.stringify(workflow.definition, null, 2) + '\n');
        return;
      }

      emit(options.json, { ...workflow, versions }, () => {
        const definition = workflow.definition;
        const out = [
          heading(workflow.name + colour.dim('  (' + workflow.key + ' v' + workflow.version + ')')),
          details([
            ['description', definition.description ?? null],
            ['nodes', String(workflow.analysis.nodes)],
            ['edges', String(workflow.analysis.edges)],
            ['entry nodes', workflow.analysis.entryNodes.join(', ')],
            ['critical path', workflow.analysis.criticalPath + ' tasks deep'],
            ['run timeout', formatDuration(definition.timeoutMs)],
          ]),
          heading('Tasks'),
          table(definition.nodes, [
            { header: 'KEY', value: (n) => n.key },
            { header: 'TYPE', value: (n) => n.type },
            { header: 'QUEUE', value: (n) => n.queue },
            { header: 'TIMEOUT', value: (n) => formatDuration(n.timeoutMs), align: 'right' },
            {
              header: 'RETRIES',
              value: (n) => String(n.retryPolicy.maxAttempts),
              align: 'right',
            },
            {
              header: 'DEPENDS ON',
              value: (n) =>
                definition.edges
                  .filter((e) => e.to === n.key)
                  .map((e) => e.from)
                  .join(', ') || '—',
            },
            { header: 'CONDITION', value: (n) => (n.condition ? truncate(n.condition, 34) : '—') },
          ]),
          heading('Versions'),
          table(versions.slice(0, 10), [
            { header: 'VERSION', value: (v) => 'v' + v.version, align: 'right' },
            { header: 'CREATED', value: (v) => formatRelative(v.createdAt) },
            { header: 'CHECKSUM', value: (v) => v.checksum.slice(0, 12) },
            { header: 'CHANGELOG', value: (v) => truncate(v.changelog ?? '—', 40) },
          ]),
        ];
        return out.join('\n');
      });
    });

  workflows
    .command('apply <file>')
    .description('create or update a workflow from a JSON definition file')
    .option('--changelog <text>', 'note recorded against the new version')
    .option('--dry-run', 'validate without saving', false)
    .action(async (file: string, opts: { changelog?: string; dryRun: boolean }) => {
      const options = program.opts<GlobalOptions>();
      const client = createClient(options);

      let definition: WorkflowDefinition;
      try {
        definition = JSON.parse(await readFile(file, 'utf8')) as WorkflowDefinition;
      } catch (err) {
        process.stderr.write(
          colour.red('error: ') + 'could not read ' + file + ': ' + (err as Error).message + '\n',
        );
        process.exit(EXIT.USAGE);
      }

      if (opts.dryRun) {
        const result = await client.workflows.validate(definition);
        emit(options.json, result, () => {
          if (result.valid) {
            const warnings = result.warnings
              .map((w) => '  ' + colour.yellow('warning ') + w.target + ': ' + w.message)
              .join('\n');
            return colour.green('✓ definition is valid') + (warnings ? '\n' + warnings : '');
          }
          return (
            colour.red('✗ definition is invalid') +
            '\n' +
            result.errors.map((e) => '  ' + colour.red(e.target) + ': ' + e.message).join('\n')
          );
        });
        if (!result.valid) process.exit(EXIT.FAILED_OUTCOME);
        return;
      }

      const result = await client.workflows.create(definition, {
        ...(opts.changelog ? { changelog: opts.changelog } : {}),
      });

      emit(options.json, result, () =>
        result.created
          ? colour.green('✓ ') + result.key + ' saved as v' + result.version
          : colour.dim('· ') +
            result.key +
            ' unchanged (identical to v' +
            result.version +
            ') — nothing to do',
      );
    });

  workflows
    .command('validate <file>')
    .description('validate a definition file without saving it')
    .action(async (file: string) => {
      // Thin alias for `apply --dry-run`; validation is the command people reach for by
      // name, and making them discover a flag for it is needless friction.
      await program.parseAsync(['workflows', 'apply', file, '--dry-run'], { from: 'user' });
    });
}
