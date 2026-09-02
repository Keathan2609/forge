'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Periodically re-render a server component page.
 *
 * `router.refresh()` re-runs the server component and patches the result into the
 * existing tree, so the page updates without losing scroll position, focus, or any
 * client state. That is why the list pages use this rather than an interval + `fetch`
 * in a client component: the data-loading code stays on the server, and there is one
 * implementation of each query instead of two.
 *
 * Refresh is suspended while the tab is hidden. A console left open on a second monitor
 * for a week should not spend that week polling.
 */
export function AutoRefresh({
  intervalMs = 5_000,
  enabled = true,
}: {
  intervalMs?: number;
  enabled?: boolean;
}): ReactNode {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const refreshing = useRef(false);

  useEffect(() => {
    const onVisibility = (): void => {
      const hidden = document.visibilityState === 'hidden';
      setPaused(hidden);
      // Catch up immediately on return rather than waiting out the interval.
      if (!hidden) router.refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return (): void => document.removeEventListener('visibilitychange', onVisibility);
  }, [router]);

  useEffect(() => {
    if (!enabled || paused) return;

    const timer = setInterval(() => {
      // Skip a tick if the previous refresh has not settled, so a slow API cannot
      // queue up an unbounded backlog of refreshes.
      if (refreshing.current) return;
      refreshing.current = true;
      router.refresh();
      // `router.refresh()` has no completion signal; this is a conservative floor on
      // how often a refresh can be issued.
      setTimeout(
        () => {
          refreshing.current = false;
        },
        Math.min(intervalMs, 1_000),
      );
    }, intervalMs);

    return (): void => clearInterval(timer);
  }, [router, intervalMs, enabled, paused]);

  return null;
}
