#!/usr/bin/env node
import { Command } from 'commander';
import { ForgeApiError, ForgeClient, ForgeTimeoutError } from '@forge/sdk';
import { colour, fail } from './output';
import { registerWorkflowCommands } from './commands/workflows';
import { registerRunCommands } from './commands/runs';
import { registerOperationsCommands } from './commands/operations';
import { registerSystemCommands } from './commands/system';

/**
 * `forge` — the FORGE command line interface.
 *
 * Exit codes are part of the contract, because this is a tool people put in CI:
 *
 *   0  success
 *   1  the command ran but the outcome was a failure (a run failed, a check was not met)
 *   2  usage error — bad arguments, unknown command
 *   3  the API could not be reached, or returned an error
 *
 * Distinguishing 1 from 3 matters: "the deployment workflow failed" and "I could not
 * reach FORGE" demand completely different responses from a pipeline.
 */

export const EXIT = {
  OK: 0,
  FAILED_OUTCOME: 1,
  USAGE: 2,
  API_ERROR: 3,
} as const;

export interface GlobalOptions {
  url: string;
  apiKey?: string;
  json: boolean;
  timeout: number;
}

export function createClient(options: GlobalOptions): ForgeClient {
  return new ForgeClient({
    baseUrl: options.url,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    timeoutMs: options.timeout,
  });
}

const program = new Command();

program
  .name('forge')
  .description('Command line interface for the FORGE workflow orchestration engine.')
  .version('0.1.0')
  .option('--url <url>', 'FORGE API base URL', process.env.FORGE_API_URL ?? 'http://localhost:4000')
  .option('--api-key <key>', 'API key (or set FORGE_API_KEY)', process.env.FORGE_API_KEY)
  .option('--json', 'emit machine-readable JSON instead of tables', false)
  .option('--timeout <ms>', 'request timeout in milliseconds', (v) => Number(v), 30_000)
  .showHelpAfterError('(run `forge --help` for usage)');

registerWorkflowCommands(program);
registerRunCommands(program);
registerOperationsCommands(program);
registerSystemCommands(program);

/**
 * Turn an exception into a useful message and the right exit code.
 *
 * A CLI that prints a stack trace for "the server is not running" is a CLI people stop
 * trusting, so each failure mode gets a specific, actionable line.
 */
function handleError(err: unknown): never {
  if (err instanceof ForgeApiError) {
    fail(err.message, err.details ? JSON.stringify(err.details, null, 2) : undefined);
    if (err.status === 401) {
      process.stderr.write(colour.dim('  set FORGE_API_KEY or pass --api-key\n'));
    }
    if (err.requestId) process.stderr.write(colour.dim('  request id: ' + err.requestId + '\n'));
    process.exit(EXIT.API_ERROR);
  }

  if (err instanceof ForgeTimeoutError) {
    fail(err.message, 'increase --timeout, or check that the API is responsive');
    process.exit(EXIT.API_ERROR);
  }

  const message = (err as Error).message ?? String(err);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    fail(
      'could not reach the FORGE API',
      'is it running? try `pnpm forge:dev`, or pass --url. Current: ' +
        (program.opts().url as string),
    );
    process.exit(EXIT.API_ERROR);
  }

  fail(message);
  if (process.env.FORGE_DEBUG) process.stderr.write(String((err as Error).stack) + '\n');
  process.exit(EXIT.API_ERROR);
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // Commander throws for usage errors with its own exit code already set.
    if ((err as { code?: string }).code === 'commander.helpDisplayed') process.exit(EXIT.OK);
    handleError(err);
  }
}

void main();
