'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { formatDateTime, formatRelative } from '@/lib/format';

/**
 * A relative timestamp that does not break hydration.
 *
 * "3m ago" is derived from `Date.now()`, which differs between the server render and the
 * client's hydration render — React sees two different strings for the same node and
 * throws a hydration mismatch. (This is exactly the bug this component was written to
 * fix; it showed up as a minified React #418 on every list page.)
 *
 * The fix is to render something *deterministic* on the first pass — the absolute
 * timestamp, which is a pure function of the prop — and switch to the relative form only
 * after mount, when server and client no longer need to agree. The absolute time stays
 * available as a tooltip, which is what you want when comparing two events anyway.
 */
export function TimeAgo({
  iso,
  /** How often to re-render. Timestamps in a live view should not go stale. */
  refreshMs = 30_000,
}: {
  iso: string | null | undefined;
  refreshMs?: number;
}): ReactNode {
  const [mounted, setMounted] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    setMounted(true);
    if (!iso) return;
    const timer = setInterval(() => setTick((n) => n + 1), refreshMs);
    return (): void => clearInterval(timer);
  }, [iso, refreshMs]);

  if (!iso) return <span>—</span>;

  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {mounted ? formatRelative(iso) : formatDateTime(iso).slice(0, 16)}
    </time>
  );
}
