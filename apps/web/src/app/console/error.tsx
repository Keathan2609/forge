'use client';

import { useEffect, type ReactNode } from 'react';

/**
 * Console error boundary.
 *
 * Renders the actual message rather than a generic apology: the person looking at this
 * is an operator debugging their own system, and "something went wrong" wastes their
 * time. `reset()` re-runs the failed server component, which is usually enough for a
 * transient API failure.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  useEffect(() => {
    console.error('console render failed:', error);
  }, [error]);

  return (
    <div style={{ padding: 'var(--space-8)', maxWidth: '70ch' }}>
      <h1 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-3)' }}>
        This page could not be rendered
      </h1>
      <pre
        style={{
          background: 'var(--bg-input)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          padding: 'var(--space-3)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          color: 'var(--state-error)',
          whiteSpace: 'pre-wrap',
          marginBottom: 'var(--space-4)',
        }}
      >
        {error.message}
        {error.digest ? '\n\ndigest: ' + error.digest : ''}
      </pre>
      <p style={{ color: 'var(--text-tertiary)', marginBottom: 'var(--space-4)' }}>
        If the API is not running, start it with <code>pnpm forge:dev</code>.
      </p>
      <button
        onClick={reset}
        style={{
          padding: '6px 12px',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-raised)',
          color: 'var(--text-primary)',
        }}
      >
        Try again
      </button>
    </div>
  );
}
