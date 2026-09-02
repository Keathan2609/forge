import type { ReactNode } from 'react';
import { stateLabel, stateTone, type StateTone } from '@/lib/format';
import styles from './ui.module.css';

/** Shared presentational primitives. No data fetching, no state. */

const TONE_CLASS: Record<StateTone, string> = {
  success: styles.toneSuccess as string,
  running: styles.toneRunning as string,
  warn: styles.toneWarn as string,
  error: styles.toneError as string,
  idle: styles.toneIdle as string,
};

export function StateBadge({
  state,
  label,
  pulse,
}: {
  state: string;
  label?: string;
  /** Animate the dot. Reserved for states that mean "something is happening now". */
  pulse?: boolean;
}): ReactNode {
  const tone = stateTone(state);
  const isActive = pulse ?? ['RUNNING', 'RETRYING', 'QUEUED'].includes(state);
  return (
    <span className={styles.badge + ' ' + TONE_CLASS[tone]}>
      <span className={styles.badgeDot + (isActive ? ' ' + styles.badgePulse : '')} />
      {label ?? stateLabel(state)}
    </span>
  );
}

export function Card({
  title,
  action,
  children,
  flush,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}): ReactNode {
  return (
    <section className={styles.card}>
      {title !== undefined && (
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>{title}</h2>
          {action}
        </header>
      )}
      <div className={flush ? styles.cardBodyFlush : styles.cardBody}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  meta,
  tone,
}: {
  label: string;
  value: string | number;
  meta?: string;
  tone?: 'accent' | 'success' | 'error' | 'warn';
}): ReactNode {
  const toneClass =
    tone === 'accent'
      ? styles.statAccent
      : tone === 'success'
        ? styles.statSuccess
        : tone === 'error'
          ? styles.statError
          : tone === 'warn'
            ? styles.statWarn
            : '';
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue + (toneClass ? ' ' + toneClass : '')}>{value}</span>
      {meta !== undefined && <span className={styles.statMeta}>{meta}</span>}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }): ReactNode {
  return <div className={styles.statGrid}>{children}</div>;
}

export function KeyValue({ entries }: { entries: Array<[string, ReactNode]> }): ReactNode {
  return (
    <dl className={styles.kv}>
      {entries.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt className={styles.kvKey}>{key}</dt>
          <dd className={styles.kvValue} style={{ margin: 0 }}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }): ReactNode {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{title}</div>
      {hint !== undefined && <div>{hint}</div>}
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }): ReactNode {
  return <div className={styles.errorBox}>{children}</div>;
}

export function WarnBox({ children }: { children: ReactNode }): ReactNode {
  return <div className={styles.warnBox}>{children}</div>;
}

export function CodeBlock({ children }: { children: string }): ReactNode {
  return <pre className={styles.code}>{children}</pre>;
}

export function PageHeader({
  title,
  count,
  subtitle,
  actions,
}: {
  title: string;
  /**
   * The one number that says how much there is to deal with, set directly beneath the
   * title — "12 unresolved tasks". It sits above the prose because on an operations
   * page the quantity is read first and the explanation second.
   */
  count?: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}): ReactNode {
  return (
    <header className={styles.pageHeader}>
      <div>
        <h1 className={styles.pageTitle}>{title}</h1>
        {count !== undefined && <div className={styles.pageCount}>{count}</div>}
        {subtitle !== undefined && <p className={styles.pageSubtitle}>{subtitle}</p>}
      </div>
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}

export function Spinner(): ReactNode {
  return <span className={styles.spinner} aria-label="loading" />;
}

export { styles as ui };
