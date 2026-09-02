import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './page.module.css';

export const metadata = {
  title: 'FORGE — distributed workflow orchestration',
};

/**
 * Landing page.
 *
 * One screen of substance, then the architecture, then the console. No testimonials, no
 * pricing table, no "trusted by" logos — the interesting thing about FORGE is how it
 * behaves when something breaks, so the page says that and gets out of the way.
 */
export default function LandingPage(): ReactNode {
  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <span className={styles.brand}>FORGE</span>
        <div className={styles.navLinks}>
          <a href="#architecture">Architecture</a>
          <a href="#durability">Durability</a>
          <a href="#interfaces">Interfaces</a>
          <Link href="/console">Console →</Link>
        </div>
      </nav>

      <header className={styles.hero}>
        <h1 className={styles.heroTitle}>FORGE</h1>
        <p className={styles.heroTagline}>
          Distributed workflows.
          <br />
          <span className={styles.heroTaglineAccent}>Built to survive failure.</span>
        </p>
        <p className={styles.heroBody}>
          A self-hosted orchestration engine for workflows defined as directed acyclic graphs.
          Execution state lives in PostgreSQL, not in a process — so a worker can be killed
          mid-task, the API can restart, and Redis can be wiped, and every in-flight run still
          reaches a correct terminal state.
        </p>
        <div className={styles.heroActions}>
          <Link href="/console" className={styles.cta}>
            Open Console
          </Link>
          <a href="#architecture" className={styles.ctaSecondary}>
            How it works
          </a>
        </div>
      </header>

      <section className={styles.section} id="architecture">
        <div className={styles.sectionLabel}>Architecture</div>
        <h2 className={styles.sectionTitle}>Five runtimes, one source of truth</h2>
        <ArchitectureDiagram />
      </section>

      <section className={styles.section} id="durability">
        <div className={styles.sectionLabel}>Durability</div>
        <h2 className={styles.sectionTitle}>What happens when things break</h2>
        <div className={styles.features}>
          <div className={styles.feature}>
            <h3 className={styles.featureTitle}>A worker is killed mid-task</h3>
            <p className={styles.featureBody}>
              Every running task is held by a time-bounded lease that its worker renews. A worker
              that dies stops renewing; the lease expires; the control plane marks the attempt{' '}
              <code>ABANDONED</code> and returns the task to the queue. Another worker picks it up.
              No task is stuck in <code>RUNNING</code> forever, and the crash does not consume the
              retry budget the application needs.
            </p>
          </div>

          <div className={styles.feature}>
            <h3 className={styles.featureTitle}>A process dies after committing</h3>
            <p className={styles.featureBody}>
              State changes and their dispatch intent are written in the same PostgreSQL
              transaction, to a transactional outbox. A separate publisher moves rows to Redis and
              only then marks them published — so a crash between the two republishes rather than
              losing the message.
            </p>
          </div>

          <div className={styles.feature}>
            <h3 className={styles.featureTitle}>A message is delivered twice</h3>
            <p className={styles.featureBody}>
              The queue guarantees at-least-once delivery, and FORGE says so rather than claiming
              exactly-once. Duplicates are absorbed by two unique constraints: one attempt row per{' '}
              <code>(task, attempt number)</code>, and one lease per attempt. The second delivery
              loses the race and is discarded.
            </p>
          </div>

          <div className={styles.feature}>
            <h3 className={styles.featureTitle}>A task keeps failing</h3>
            <p className={styles.featureBody}>
              Retries back off exponentially with full jitter, so a fan-out failing together does
              not re-synchronise into a second stampede. When the budget is exhausted the task is
              dead-lettered with its complete attempt history, and waits for a human decision rather
              than retrying forever.
            </p>
          </div>

          <div className={styles.feature}>
            <h3 className={styles.featureTitle}>Redis is wiped</h3>
            <p className={styles.featureBody}>
              Redis carries messages; it is never consulted for state. Every consumer re-reads
              PostgreSQL before acting, the outbox republishes what was undelivered, and the
              sweepers pick up whatever the lost messages would have triggered. Latency suffers;
              correctness does not.
            </p>
          </div>

          <div className={styles.feature}>
            <h3 className={styles.featureTitle}>A workflow is edited mid-run</h3>
            <p className={styles.featureBody}>
              Definitions are immutable and content-addressed. Saving a changed graph creates a new
              version; runs already in flight keep executing the exact document they started with.
              Re-saving an unchanged graph is a no-op.
            </p>
          </div>
        </div>
      </section>

      <section className={styles.section} id="interfaces">
        <div className={styles.sectionLabel}>Interfaces</div>
        <h2 className={styles.sectionTitle}>REST, a typed SDK, and a CLI</h2>
        <div className={styles.codeGrid}>
          <pre className={styles.codeBlock}>
            <span className={styles.codeComment}>{'// TypeScript SDK\n'}</span>
            {`import { ForgeClient, defineWorkflow } from '@forge/sdk';

const forge = new ForgeClient({
  baseUrl: 'http://localhost:4000',
});

const run = await forge.runs.triggerAndWait(
  'order-fulfilment',
  { orderId: 'ord_1', amount: 4999 },
);

console.log(run.state, run.output);`}
          </pre>

          <pre className={styles.codeBlock}>
            <span className={styles.codeComment}>{'# CLI\n'}</span>
            {`$ forge run order-fulfilment \\
    '{"orderId":"ord_1"}' --watch

✓ run 06959485 (order-fulfilment v1)

  19:26:59.038  TASK_QUEUED     validate-order
  19:26:59.301  TASK_STARTED    validate-order
  19:26:59.343  TASK_COMPLETED  validate-order
  19:26:59.619  TASK_QUEUED     reserve-inventory
  19:26:59.619  TASK_QUEUED     authorise-payment

✓ SUCCEEDED in 3.23s`}
          </pre>
        </div>
      </section>

      <footer className={styles.footer}>
        <span>FORGE — distributed workflow orchestration engine</span>
        <span>PostgreSQL · Redis · NestJS · Next.js · OpenTelemetry</span>
      </footer>
    </div>
  );
}

/**
 * Architecture diagram.
 *
 * Inline SVG rather than an image so it inherits the theme's colours and stays crisp at
 * any zoom. It shows the actual runtime topology, including the direction of every
 * dependency — the point being that workers talk to PostgreSQL directly for state and to
 * Redis only for messages.
 */
function ArchitectureDiagram(): ReactNode {
  const box = (
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    sublabel: string,
    accent?: string,
  ): ReactNode => (
    <g key={label + x + y}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={5}
        fill="var(--bg-raised)"
        stroke={accent ?? 'var(--border-default)'}
        strokeWidth={1}
      />
      <text
        x={x + w / 2}
        y={y + h / 2 - 4}
        textAnchor="middle"
        fill="var(--text-primary)"
        fontSize={12}
        fontWeight={600}
        fontFamily="var(--font-sans)"
      >
        {label}
      </text>
      <text
        x={x + w / 2}
        y={y + h / 2 + 11}
        textAnchor="middle"
        fill="var(--text-tertiary)"
        fontSize={9.5}
        fontFamily="var(--font-mono)"
      >
        {sublabel}
      </text>
    </g>
  );

  const arrow = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    label?: string,
    dashed?: boolean,
  ): ReactNode => (
    <g key={'a' + x1 + y1 + x2 + y2}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="var(--border-strong)"
        strokeWidth={1.2}
        markerEnd="url(#arrowhead)"
        {...(dashed ? { strokeDasharray: '4 3' } : {})}
      />
      {label && (
        <text
          x={(x1 + x2) / 2}
          y={(y1 + y2) / 2 - 5}
          textAnchor="middle"
          fill="var(--text-disabled)"
          fontSize={9}
          fontFamily="var(--font-mono)"
        >
          {label}
        </text>
      )}
    </g>
  );

  return (
    <svg
      viewBox="0 0 960 400"
      className={styles.diagram}
      role="img"
      aria-label="FORGE architecture: the web console and SDK call the API, which writes state and an outbox row to PostgreSQL in one transaction. The control plane publishes outbox rows to Redis, advances runs and reaps expired leases. Workers consume tasks from Redis and write results back to PostgreSQL."
    >
      <defs>
        <marker id="arrowhead" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
          <polygon points="0 0, 7 2.5, 0 5" fill="var(--border-strong)" />
        </marker>
      </defs>

      {/* clients */}
      {box(20, 24, 140, 46, 'Web console', 'Next.js', 'var(--accent-border)')}
      {box(20, 88, 140, 46, 'SDK / CLI', '@forge/sdk')}

      {/* api */}
      {box(224, 56, 150, 46, 'API', 'NestJS', 'var(--accent-border)')}

      {/* postgres */}
      {box(224, 176, 150, 60, 'PostgreSQL', 'source of truth', 'var(--state-success)')}
      {box(224, 254, 150, 40, 'outbox_event', 'same transaction')}

      {/* control plane */}
      {box(440, 176, 170, 60, 'Control plane', 'publisher · reaper', 'var(--accent-border)')}
      {box(440, 254, 170, 40, 'scheduler · sweepers', 'cron · retries')}

      {/* redis */}
      {box(676, 176, 130, 60, 'Redis', 'transport only', 'var(--state-warn)')}

      {/* workers */}
      {box(676, 40, 130, 40, 'worker-1', 'leases tasks')}
      {box(676, 88, 130, 40, 'worker-2', 'leases tasks')}
      {box(676, 136, 130, 26, 'worker-N', '…')}

      {/* observability */}
      {box(846, 176, 96, 60, 'OTel', 'traces · metrics')}

      {/* edges */}
      {arrow(160, 47, 220, 66)}
      {arrow(160, 111, 220, 88)}
      {arrow(299, 102, 299, 172, 'commit')}
      {arrow(374, 210, 436, 210, 'poll')}
      {arrow(610, 210, 672, 210, 'publish')}
      {arrow(741, 172, 741, 166, '')}
      {arrow(741, 176, 741, 132, 'BRPOP')}
      {/* worker → postgres: claim a lease, write the result */}
      {arrow(676, 60, 380, 190, 'claim lease · write result', true)}
      {/* api ← postgres reads */}
      {arrow(280, 172, 280, 106, 'read')}

      <text x={20} y={330} fill="var(--text-tertiary)" fontSize={11} fontFamily="var(--font-sans)">
        Solid arrows are message flow. The dashed arrow is the one that matters most:
      </text>
      <text x={20} y={348} fill="var(--text-tertiary)" fontSize={11} fontFamily="var(--font-sans)">
        workers read and write execution state directly in PostgreSQL, under a lease. Redis only
        ever tells a worker that
      </text>
      <text x={20} y={366} fill="var(--text-tertiary)" fontSize={11} fontFamily="var(--font-sans)">
        there may be work — it is never asked what the state is, which is why losing it costs
        latency rather than correctness.
      </text>
    </svg>
  );
}
