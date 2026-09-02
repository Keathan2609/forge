import { describe, expect, it } from 'vitest';
import { details, formatDuration, formatRelative, table, truncate } from '../src/output';

/**
 * Terminal rendering.
 *
 * The property most worth pinning is that column widths are measured on *uncoloured*
 * text. Measuring a string containing ANSI escapes counts the escapes as characters, so
 * the table looks correct when piped to a file and ragged in an actual terminal — which
 * is precisely the case nobody checks.
 */

interface Row {
  name: string;
  state: string;
  count: number;
}

const rows: Row[] = [
  { name: 'short', state: 'SUCCEEDED', count: 1 },
  { name: 'a-much-longer-name', state: 'FAILED', count: 1234 },
];

describe('table', () => {
  it('aligns columns to the widest cell', () => {
    const output = table(rows, [
      { header: 'NAME', value: (r) => r.name },
      { header: 'STATE', value: (r) => r.state },
    ]);

    const lines = output.split('\n');
    // Header plus one line per row.
    expect(lines).toHaveLength(3);

    // The STATE column starts at the same offset on every line.
    const offsets = lines.map((line) =>
      line.indexOf('STATE') >= 0 ? line.indexOf('STATE') : line.search(/SUCCEEDED|FAILED/),
    );
    expect(new Set(offsets).size).toBe(1);
  });

  it('measures width on uncoloured text', () => {
    // `render` wraps the padded cell in escape codes *after* padding, so the escapes
    // cannot affect alignment.
    const coloured = table(rows, [
      { header: 'NAME', value: (r) => r.name },
      {
        header: 'STATE',
        value: (r) => r.state,
        render: (cell) => '[32m' + cell + '[0m',
      },
    ]);
    const plain = table(rows, [
      { header: 'NAME', value: (r) => r.name },
      { header: 'STATE', value: (r) => r.state },
    ]);

    // Stripping the escapes from the coloured render must reproduce the plain one.
    // eslint-disable-next-line no-control-regex
    const stripped = coloured.replace(/\[[0-9;]*m/g, '');
    expect(stripped).toBe(plain);
  });

  it('right-aligns numeric columns', () => {
    const output = table(rows, [
      { header: 'COUNT', value: (r) => String(r.count), align: 'right' },
    ]);
    const lines = output.split('\n');

    // "1" is padded to the width of "1234", so both end at the same column.
    expect(lines[1]?.trimEnd().endsWith('1')).toBe(true);
    expect(lines[2]?.trimEnd().endsWith('1234')).toBe(true);
    expect(lines[1]?.trimEnd().length).toBe(lines[2]?.trimEnd().length);
  });

  it('renders a placeholder for an empty result rather than a bare header', () => {
    expect(table([], [{ header: 'NAME', value: () => '' }])).toContain('(none)');
  });

  it('widens a column to fit its header', () => {
    const output = table(
      [{ name: 'a', state: '', count: 0 }],
      [
        { header: 'A_VERY_LONG_HEADER', value: (r) => r.name },
        { header: 'X', value: () => 'y' },
      ],
    );
    const lines = output.split('\n');
    expect(lines[0]?.indexOf('X')).toBe(lines[1]?.indexOf('y'));
  });
});

describe('details', () => {
  it('aligns keys and omits undefined values', () => {
    const output = details([
      ['state', 'SUCCEEDED'],
      ['duration', '1.2s'],
      ['omitted', undefined],
      ['nullish', null],
    ]);

    expect(output).toContain('SUCCEEDED');
    expect(output).not.toContain('omitted');
    // A null value renders as an em dash rather than disappearing — "we looked and there
    // is nothing" is different from "we did not look".
    expect(output).toContain('—');
  });
});

describe('formatDuration', () => {
  it.each([
    [null, '—'],
    [undefined, '—'],
    [0, '0ms'],
    [250, '250ms'],
    [1_500, '1.50s'],
    [59_000, '59.00s'],
  ])('%s -> %s', (input, expected) => {
    expect(formatDuration(input as number | null)).toBe(expected);
  });

  it('switches to minutes and seconds past a minute', () => {
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(3_601_000)).toBe('60m01s');
  });
});

describe('formatRelative', () => {
  it('renders recent times in seconds', () => {
    expect(formatRelative(new Date(Date.now() - 5_000).toISOString())).toBe('5s ago');
  });

  it('renders future times as "in"', () => {
    // Schedules show a next-run time, which is by definition in the future.
    expect(formatRelative(new Date(Date.now() + 60_000).toISOString())).toMatch(/^in /);
  });

  it('handles a missing value', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative(undefined)).toBe('—');
  });
});

describe('truncate', () => {
  it('leaves short strings alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('truncates with an ellipsis and respects the limit', () => {
    const result = truncate('a'.repeat(50), 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
  });
});
