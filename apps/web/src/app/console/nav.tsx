'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { SystemStatusView } from '@forge/contracts';
import { forgeApi } from '@/lib/api';
import styles from './layout.module.css';

/**
 * Console navigation, the location breadcrumb, and the live telemetry strip.
 *
 * The navigation is indexed. Numbering the destinations costs nothing and does two
 * useful things: it gives the column a fixed left edge to align against, and it makes
 * the sections referable — "06" is a shorter thing to say than "dead letters" when
 * someone is reading over your shoulder.
 *
 * The telemetry strip polls `/v1/system/status` rather than subscribing: it is one small
 * request every five seconds, it recovers on its own from any transport failure, and it
 * does not consume an SSE connection that a run page might need. Run pages, where
 * latency actually matters, use SSE.
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

/** `/console` must only match exactly, or Overview stays highlighted everywhere. */
function isActive(href: string, pathname: string): boolean {
  return href === '/console' ? pathname === href : pathname.startsWith(href);
}

export function ConsoleNav({ deadLetterCount }: { deadLetterCount: number }): ReactNode {
  const pathname = usePathname();
  // Numbered continuously across groups, so the index is a stable address for a
  // destination rather than a position within its section.
  let index = 0;

  return (
    <nav className={styles.nav}>
      {NAV.map((group) => (
        <div key={group.group} className={styles.navGroup}>
          <div className={styles.navGroupLabel}>{group.group}</div>
          {group.items.map((item) => {
            index += 1;
            const active = isActive(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={styles.navLink + (active ? ' ' + styles.navLinkActive : '')}
                aria-current={active ? 'page' : undefined}
              >
                <span className={styles.navIndex} aria-hidden="true">
                  {String(index).padStart(2, '0')}
                </span>
                <span className={styles.navLabel}>{item.label}</span>
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
          Traces ↗
        </a>
        <a href="http://localhost:9090" target="_blank" rel="noreferrer">
          Metrics ↗
        </a>
      </div>
    </nav>
  );
}

/**
 * Where you are, as `FORGE / SECTION`.
 *
 * Derived from the navigation table rather than from a per-page prop, so a page cannot
 * disagree with the sidebar about which section it belongs to.
 */
export function Breadcrumb(): ReactNode {
  const pathname = usePathname();
  const current = NAV.flatMap((g) => g.items).find((item) => isActive(item.href, pathname));

  return (
    <div className={styles.breadcrumb}>
      <span className={styles.breadcrumbRoot}>Forge</span>
      <span className={styles.breadcrumbSep} aria-hidden="true">
        /
      </span>
      <span>{current?.label ?? 'Console'}</span>
    </div>
  );
}

/** One reading in the telemetry strip: a legend above a monospace value. */
function Metric({
  label,
  children,
  strong,
}: {
  label: string;
  children: ReactNode;
  strong?: boolean;
}): ReactNode {
  return (
    <div className={styles.headerMetric}>
      <span className={styles.headerMetricLabel}>{label}</span>
      <span className={styles.headerMetricValue + (strong ? ' ' + styles.headerMetricStrong : '')}>
        {children}
      </span>
    </div>
  );
}

/** Counts are zero-padded so the strip does not reflow as numbers cross a digit. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
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
        <Metric label="System">
          <span className={styles.statusDot + ' ' + styles.statusDown} />
          Unreachable
        </Metric>
      </div>
    );
  }

  if (!status) {
    return (
      <div className={styles.headerStatus}>
        <Metric label="System">—</Metric>
      </div>
    );
  }

  const dotClass = status.status === 'healthy' ? styles.statusOk : styles.statusDegraded;

  return (
    <div className={styles.headerStatus}>
      <Metric label="Workers" strong>
        {pad(status.components.workers.online)}
      </Metric>
      <Metric label="Outbox">{pad(status.components.outbox.pending)}</Metric>
      <Metric label="DB">
        {status.components.database.latencyMs === null
          ? '—'
          : pad(status.components.database.latencyMs) + 'ms'}
      </Metric>
      <Metric label="System" strong>
        <span className={styles.statusDot + ' ' + dotClass} />
        {status.status}
      </Metric>
    </div>
  );
}
