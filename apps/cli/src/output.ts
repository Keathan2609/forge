import pc from 'picocolors';

/**
 * Terminal output.
 *
 * Two rules the whole CLI follows:
 *
 *   1. `--json` prints machine-readable JSON to stdout and *nothing else*, so
 *      `forge runs list --json | jq` works without filtering out decoration.
 *   2. Human output goes to stdout, diagnostics to stderr, and colour is dropped when
 *      stdout is not a TTY — a piped `forge` should not emit escape codes.
 */

const isTty = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

export const colour = {
  dim: (s: string): string => (isTty ? pc.dim(s) : s),
  bold: (s: string): string => (isTty ? pc.bold(s) : s),
  green: (s: string): string => (isTty ? pc.green(s) : s),
  red: (s: string): string => (isTty ? pc.red(s) : s),
  yellow: (s: string): string => (isTty ? pc.yellow(s) : s),
  blue: (s: string): string => (isTty ? pc.blue(s) : s),
  cyan: (s: string): string => (isTty ? pc.cyan(s) : s),
  magenta: (s: string): string => (isTty ? pc.magenta(s) : s),
  grey: (s: string): string => (isTty ? pc.gray(s) : s),
};

/** Colour a state name consistently across every command. */
export function stateColour(state: string): string {
  switch (state) {
    case 'SUCCEEDED':
      return colour.green(state);
    case 'FAILED':
    case 'DEAD_LETTERED':
    case 'TIMED_OUT':
      return colour.red(state);
    case 'RUNNING':
      return colour.cyan(state);
    case 'RETRYING':
      return colour.yellow(state);
    case 'CANCELLED':
    case 'SKIPPED':
      return colour.grey(state);
    case 'QUEUED':
    case 'PENDING':
    case 'BLOCKED':
    case 'READY':
      return colour.blue(state);
    case 'ONLINE':
      return colour.green(state);
    case 'UNRESPONSIVE':
      return colour.red(state);
    case 'DRAINING':
      return colour.yellow(state);
    case 'OFFLINE':
      return colour.grey(state);
    default:
      return state;
  }
}

export interface Column<T> {
  header: string;
  /** Return the cell as a plain string; colour is applied by `render` if provided. */
  value: (row: T) => string;
  /** Optional colouriser, kept separate so width is computed on the uncoloured text. */
  render?: (cell: string, row: T) => string;
  align?: 'left' | 'right';
}

/**
 * Render a table.
 *
 * Widths are measured on the *uncoloured* text — measuring a string containing ANSI
 * escapes counts the escapes as characters and produces a table that looks fine
 * uncoloured and ragged in a terminal.
 */
export function table<T>(rows: T[], columns: Array<Column<T>>): string {
  if (rows.length === 0) return colour.dim('  (none)');

  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((r) => (r[index] ?? '').length)),
  );

  const header = columns
    .map((column, index) => pad(column.header, widths[index] as number, column.align))
    .join('  ');

  const body = rows.map((row, rowIndex) =>
    columns
      .map((column, index) => {
        const raw = cells[rowIndex]?.[index] ?? '';
        const padded = pad(raw, widths[index] as number, column.align);
        // Apply colour after padding so alignment is unaffected.
        return column.render ? column.render(padded, row) : padded;
      })
      .join('  '),
  );

  return [colour.dim(header), ...body].map((line) => '  ' + line).join('\n');
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (text.length >= width) return text;
  const padding = ' '.repeat(width - text.length);
  return align === 'right' ? padding + text : text + padding;
}

/** Key/value block for detail views. */
export function details(pairs: Array<[string, string | null | undefined]>): string {
  const width = Math.max(...pairs.map(([key]) => key.length));
  return pairs
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => '  ' + colour.dim(pad(key, width)) + '  ' + (value ?? colour.dim('—')))
    .join('\n');
}

export function heading(text: string): string {
  return '\n' + colour.bold(text);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1_000) return ms + 'ms';
  if (ms < 60_000) return (ms / 1_000).toFixed(2) + 's';
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return minutes + 'm' + String(seconds).padStart(2, '0') + 's';
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 0) return 'in ' + formatDuration(-delta);
  if (delta < 60_000) return Math.round(delta / 1_000) + 's ago';
  if (delta < 3_600_000) return Math.round(delta / 60_000) + 'm ago';
  if (delta < 86_400_000) return Math.round(delta / 3_600_000) + 'h ago';
  return Math.round(delta / 86_400_000) + 'd ago';
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(11, 23);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** Print JSON for `--json`, or run the human renderer. */
export function emit(json: boolean, data: unknown, human: () => string): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  process.stdout.write(human() + '\n');
}

export function warn(message: string): void {
  process.stderr.write(colour.yellow('warning: ') + message + '\n');
}

export function fail(message: string, detail?: string): void {
  process.stderr.write(colour.red('error: ') + message + '\n');
  if (detail) process.stderr.write(colour.dim(detail) + '\n');
}
