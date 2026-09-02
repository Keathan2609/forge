import type { TaskRunState, WorkflowRunState } from '@forge/contracts';

/** Shared formatting. Kept in one place so a duration reads identically everywhere. */

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1) return '<1ms';
  if (ms < 1_000) return Math.round(ms) + 'ms';
  if (ms < 10_000) return (ms / 1_000).toFixed(2) + 's';
  if (ms < 60_000) return (ms / 1_000).toFixed(1) + 's';
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  if (minutes < 60) return minutes + 'm ' + seconds + 's';
  const hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm';
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 0) {
    const ahead = -delta;
    if (ahead < 60_000) return 'in ' + Math.round(ahead / 1_000) + 's';
    if (ahead < 3_600_000) return 'in ' + Math.round(ahead / 60_000) + 'm';
    if (ahead < 86_400_000) return 'in ' + Math.round(ahead / 3_600_000) + 'h';
    return 'in ' + Math.round(ahead / 86_400_000) + 'd';
  }
  if (delta < 10_000) return 'just now';
  if (delta < 60_000) return Math.round(delta / 1_000) + 's ago';
  if (delta < 3_600_000) return Math.round(delta / 60_000) + 'm ago';
  if (delta < 86_400_000) return Math.round(delta / 3_600_000) + 'h ago';
  if (delta < 604_800_000) return Math.round(delta / 86_400_000) + 'd ago';
  return new Date(iso).toISOString().slice(0, 10);
}

/** `14:02:11.482` — the timeline needs millisecond precision to be useful. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(11, 23);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '—';
  return (value * 100).toFixed(digits) + '%';
}

export function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return (value / 1_000).toFixed(value < 10_000 ? 1 : 0) + 'k';
  return (value / 1_000_000).toFixed(1) + 'M';
}

/** Short id for display. Full ids are always available on hover / in the detail panel. */
export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return '—';
  return id.slice(0, length);
}

export type StateTone = 'success' | 'running' | 'warn' | 'error' | 'idle';

/**
 * Map an execution state to a visual tone.
 *
 * Four tones rather than twelve colours: an operator scanning a list needs to answer
 * "is anything wrong?" before "which of the twelve states is this?" — and the state
 * label is always shown alongside, so the colour is reinforcement rather than the
 * only channel carrying the information.
 */
export function stateTone(state: TaskRunState | WorkflowRunState | string): StateTone {
  switch (state) {
    case 'SUCCEEDED':
      return 'success';
    case 'RUNNING':
      return 'running';
    case 'RETRYING':
      return 'warn';
    case 'FAILED':
    case 'TIMED_OUT':
    case 'DEAD_LETTERED':
      return 'error';
    case 'QUEUED':
    case 'READY':
    case 'PENDING':
      return 'running';
    case 'BLOCKED':
    case 'CANCELLED':
    case 'SKIPPED':
      return 'idle';
    case 'ONLINE':
      return 'success';
    case 'DRAINING':
      return 'warn';
    case 'UNRESPONSIVE':
      return 'error';
    case 'OFFLINE':
      return 'idle';
    default:
      return 'idle';
  }
}

/** Human label for a state. Shorter than the enum where the enum is needlessly long. */
export function stateLabel(state: string): string {
  switch (state) {
    case 'DEAD_LETTERED':
      return 'Dead letter';
    case 'TIMED_OUT':
      return 'Timed out';
    default:
      return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, ' ');
  }
}

/** Human label for an execution event type. */
export function eventLabel(type: string): string {
  return type
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function eventTone(type: string): StateTone {
  if (/COMPLETED|SUCCEEDED|RECOVERED/.test(type)) return 'success';
  if (/FAILED|DEAD_LETTER|TIMED_OUT|EXPIRED/.test(type)) return 'error';
  if (/RETRY|CANCELLED|SKIPPED|OFFLINE/.test(type)) return 'warn';
  if (/STARTED|QUEUED|ACQUIRED|PROGRESS|HEARTBEAT/.test(type)) return 'running';
  return 'idle';
}

/** Pretty-print JSON for a detail panel, with a size guard. */
export function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > 20_000 ? json.slice(0, 20_000) + '\n… truncated' : json;
  } catch {
    return String(value);
  }
}
