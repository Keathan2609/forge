import Link from 'next/link';
import type { ReactNode } from 'react';
import { forgeApi } from '@/lib/api';
import { Breadcrumb, ConsoleNav, StatusStrip } from './nav';
import styles from './layout.module.css';

export const dynamic = 'force-dynamic';

/**
 * The console shell.
 *
 * A server component so the dead-letter count is correct on first paint rather than
 * appearing a moment later — the badge is a call to action, and a badge that pops in
 * after the page settles is easy to miss.
 */
export default async function ConsoleLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  let deadLetterCount = 0;
  try {
    const page = await forgeApi.deadLetters('OPEN');
    deadLetterCount = page.items.length;
  } catch {
    // The shell must render even when the API is down — otherwise the console shows a
    // blank page at exactly the moment someone needs it to explain why.
  }

  return (
    <div className={styles.shell}>
      <div className={styles.brand}>
        <Link href="/" className={styles.brandMark}>
          FORGE
        </Link>
        <span className={styles.brandVersion}>v0.1.0</span>
      </div>

      <header className={styles.header}>
        <Breadcrumb />
        <StatusStrip />
      </header>

      <ConsoleNav deadLetterCount={deadLetterCount} />

      <main className={styles.content}>{children}</main>
    </div>
  );
}
