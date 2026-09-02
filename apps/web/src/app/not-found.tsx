import Link from 'next/link';
import type { ReactNode } from 'react';

export default function NotFound(): ReactNode {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-4)',
      }}
    >
      <h1 style={{ fontSize: 'var(--text-2xl)' }}>Not found</h1>
      <p style={{ color: 'var(--text-tertiary)' }}>That run, workflow or page does not exist.</p>
      <Link href="/console" style={{ color: 'var(--accent)' }}>
        Back to the console
      </Link>
    </div>
  );
}
