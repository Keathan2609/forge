import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/styles/global.css';

export const metadata: Metadata = {
  title: {
    default: 'FORGE',
    template: '%s · FORGE',
  },
  description:
    'FORGE — a distributed workflow orchestration engine with durable execution, worker leasing and a transactional outbox.',
  applicationName: 'FORGE',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#08090b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
