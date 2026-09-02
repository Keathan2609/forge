'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { SystemStatusView } from '@forge/contracts';
import { forgeApi } from '@/lib/api';
import styles from './layout.module.css';

/**
 * Console navigation and the live status strip.
 *
 * The header polls `/v1/system/status` rather than subscribing: it is one small request
 * every five seconds, it recovers on its own from any transport failure, and it does not
 * consume an SSE connection that a run page might need. Run pages, where latency
 * actually matters, use SSE.
 */

const NAV: Array<{
  group: string;
  items: Array<{ href: string; label: string; badge?: 'deadLetters' }>;
}> = [
  {
    group: 'Execution',
    items: [
      { href: '/console', label: 'Overview' },
      { href: '/console/runs', label: 'Runs' },
      { href: '/console/workflows', label: 'Workflows' },
      { href: '/console/schedules', label: 'Schedules' },
    ],
  },
  {
    group: 'Operations',
    items: [
      { href: '/console/workers', label: 'Workers' },
      { href: '/console/dead-letters', label: 'Dead letters', badge: 'deadLetters' },
      { href: '/console/system', label: 'System' },
    ],
  },
];

export function ConsoleNav({ deadLetterCount }: { deadLetterCount: number }): ReactNode {
  const pathname = usePathname();

  return (
    <nav className={styles.nav}>
      {NAV.map((group) => (
        <div key={group.group} className={styles.navGroup}>
          <div className={styles.navGroupLabel}>{group.group}</div>
          {group.items.map((item) => {
            // `/console` must only match exactly, or Overview stays highlighted everywhere.
            const active =
              item.href === '/console' ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={styles.navLink + (active ? ' ' + styles.navLinkActive : '')}
                aria-current={active ? 'page' : undefined}
              >
                <span>{item.label}</span>
                {item.badge === 'deadLetters' && deadLetterCount > 0 && (
                  <span className={styles.navBadge}>{deadLetterCount}</span>
                )}
              </Link>
            );
          })}
        </div>
      ))}

      <div className={styles.navFooter}>
        <a href="http://localhost:16686" target="_blank" rel="noreferrer">
          Traces (Jaeger) ↗
        </a>
        <a href="http://localhost:9090" target="_blank" rel="noreferrer">
          Metrics (Prometheus) ↗
        </a>
      </div>
    </nav>
  );
}

export function StatusStrip(): ReactNode {
  const [status, setStatus] = useState<SystemStatusView | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const next = await forgeApi.status();
        if (cancelled) return;
        setStatus(next);
        setUnreachable(false);
      } catch {
        if (cancelled) return;
        // Distinguish "the API says something is degraded" from "the API is gone" —
        // they look identical if you only render the last successful payload.
        setUnreachable(true);
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return (): void => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (unreachable) {
    return (
      <div className={styles.headerStatus}>
        <span className={styles.headerMetric}>
          <span className={styles.statusDot + ' ' + styles.statusDown} />
          API unreachable
        </span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className={styles.headerStatus}>
        <span className={styles.headerMetric}>connecting…</span>
      </div>
    );
  }

  const dotClass = status.status === 'healthy' ? styles.statusOk : styles.statusDegraded;

  return (
    <div className={styles.headerStatus}>
      <span className={styles.headerMetric}>
        <span className={styles.headerMetricValue}>{status.components.workers.online}</span>
        workers
      </span>
      <span className={styles.headerMetric}>
        <span className={styles.headerMetricValue}>{status.components.outbox.pending}</span>
        outbox
      </span>
      <span className={styles.headerMetric}>
        <span className={styles.headerMetricValue}>
          {status.components.database.latencyMs ?? '—'}ms
        </span>
        db
      </span>
      <span className={styles.headerMetric}>
        <span className={styles.statusDot + ' ' + dotClass} />
        {status.status}
      </span>
    </div>
  );
}
