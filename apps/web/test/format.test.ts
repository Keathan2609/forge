import { describe, expect, it } from 'vitest';
import {
  eventTone,
  formatCount,
  formatDuration,
  formatJson,
  formatPercent,
  formatRelative,
  shortId,
  stateLabel,
  stateTone,
} from '../src/lib/format';

/**
 * Console formatting.
 *
 * Small pure functions, but every screen depends on them — a duration that reads
 * differently on two pages makes the console feel unreliable even when the data is
 * correct.
 */

describe('formatDuration', () => {
  it.each([
    [null, '—'],
    [0.4, '<1ms'],
    [250, '250ms'],
    [1_234, '1.23s'],
    [12_300, '12.3s'],
    [90_000, '1m 30s'],
    [7_200_000, '2h 0m'],
  ])('%s -> %s', (input, expected) => {
    expect(formatDuration(input as number | null)).toBe(expected);
  });
});

describe('formatRelative', () => {
  it('collapses very recent times', () => {
    expect(formatRelative(new Date().toISOString())).toBe('just now');
  });

  it('scales the unit with the gap', () => {
    const ago = (ms: number): string => formatRelative(new Date(Date.now() - ms).toISOString());
    expect(ago(30_000)).toBe('30s ago');
    expect(ago(300_000)).toBe('5m ago');
    expect(ago(7_200_000)).toBe('2h ago');
    expect(ago(172_800_000)).toBe('2d ago');
  });

  it('falls back to an absolute date beyond a week', () => {
    // Relative time stops being useful once it reads "23d ago".
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    expect(formatRelative(old)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('renders a future time as "in"', () => {
    expect(formatRelative(new Date(Date.now() + 120_000).toISOString())).toMatch(/^in /);
  });
});

describe('formatPercent and formatCount', () => {
  it('distinguishes "no data" from zero', () => {
    // A success rate of null (nothing has finished) is not 0% (everything failed).
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(0.9567)).toBe('95.7%');
  });

  it('abbreviates large counts', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1_500)).toBe('1.5k');
    expect(formatCount(25_000)).toBe('25k');
    expect(formatCount(2_500_000)).toBe('2.5M');
  });
});

describe('state presentation', () => {
  it('maps twelve states onto four tones', () => {
    expect(stateTone('SUCCEEDED')).toBe('success');
    expect(stateTone('RUNNING')).toBe('running');
    expect(stateTone('RETRYING')).toBe('warn');
    expect(stateTone('DEAD_LETTERED')).toBe('error');
    expect(stateTone('SKIPPED')).toBe('idle');
  });

  it('gives an unknown state a defined tone rather than undefined', () => {
    expect(stateTone('SOMETHING_NEW')).toBe('idle');
  });

  it('renders readable labels for the multi-word states', () => {
    expect(stateLabel('DEAD_LETTERED')).toBe('Dead letter');
    expect(stateLabel('TIMED_OUT')).toBe('Timed out');
    expect(stateLabel('SUCCEEDED')).toBe('Succeeded');
  });

  it('tones events by meaning, not by prefix', () => {
    expect(eventTone('TASK_COMPLETED')).toBe('success');
    expect(eventTone('TASK_RECOVERED')).toBe('success');
    expect(eventTone('LEASE_EXPIRED')).toBe('error');
    expect(eventTone('TASK_RETRY_SCHEDULED')).toBe('warn');
    expect(eventTone('TASK_STARTED')).toBe('running');
  });
});

describe('shortId', () => {
  it('shortens for display but handles absence', () => {
    expect(shortId('d4ba68eb-6c57-4522')).toBe('d4ba68eb');
    expect(shortId(null)).toBe('—');
  });
});

describe('formatJson', () => {
  it('pretty-prints and handles null', () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatJson(null)).toBe('—');
  });

  it('truncates enormous payloads rather than freezing the panel', () => {
    const huge = { data: 'x'.repeat(50_000) };
    const result = formatJson(huge);
    expect(result.length).toBeLessThan(21_000);
    expect(result).toContain('truncated');
  });

  it('does not throw on a circular structure', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => formatJson(circular)).not.toThrow();
  });
});
