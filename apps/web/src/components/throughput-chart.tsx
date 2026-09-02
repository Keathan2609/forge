import type { ReactNode } from 'react';
import styles from './throughput-chart.module.css';

/**
 * Hourly run throughput.
 *
 * Hand-drawn SVG rather than a charting library: this is one stacked bar series with no
 * interactivity beyond a tooltip, and pulling in a charting runtime for it would add
 * ~100KB to the console's bundle to draw forty rectangles.
 *
 * Succeeded and failed are stacked rather than shown side by side because the question
 * being asked is "how much ran, and how much of it was bad" — stacking answers both in
 * one glance; grouped bars make the reader add them up.
 */

export interface ThroughputPoint {
  bucket: string;
  started: number;
  succeeded: number;
  failed: number;
}

export function ThroughputChart({ data }: { data: ThroughputPoint[] }): ReactNode {
  if (data.length === 0) {
    return <div className={styles.empty}>No runs in the last 24 hours.</div>;
  }

  const width = 100;
  const height = 34;
  const gap = 0.4;
  const barWidth = width / data.length - gap;
  const max = Math.max(...data.map((d) => Math.max(d.started, d.succeeded + d.failed)), 1);

  // A y-axis gridline at the peak gives the bars a scale without a full axis.
  const scale = (value: number): number => (value / max) * height;

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={'0 0 ' + width + ' ' + height}
        preserveAspectRatio="none"
        className={styles.svg}
        role="img"
        aria-label={'Runs started per hour over the last 24 hours, peak ' + max}
      >
        {data.map((point, index) => {
          const x = index * (barWidth + gap);
          const succeededHeight = scale(point.succeeded);
          const failedHeight = scale(point.failed);
          // Anything started but not yet resolved (or cancelled) shows as the remainder,
          // so the bar always represents everything that started in that hour.
          const otherHeight = Math.max(0, scale(point.started) - succeededHeight - failedHeight);

          const label =
            new Date(point.bucket).toISOString().slice(11, 16) +
            ' — ' +
            point.started +
            ' started, ' +
            point.succeeded +
            ' succeeded, ' +
            point.failed +
            ' failed';

          return (
            <g key={point.bucket}>
              <title>{label}</title>
              {/* Invisible full-height target so the tooltip is easy to hit. */}
              <rect x={x} y={0} width={barWidth} height={height} className={styles.hitArea} />
              {failedHeight > 0 && (
                <rect
                  x={x}
                  y={height - failedHeight}
                  width={barWidth}
                  height={failedHeight}
                  className={styles.failed}
                />
              )}
              {succeededHeight > 0 && (
                <rect
                  x={x}
                  y={height - failedHeight - succeededHeight}
                  width={barWidth}
                  height={succeededHeight}
                  className={styles.succeeded}
                />
              )}
              {otherHeight > 0 && (
                <rect
                  x={x}
                  y={height - failedHeight - succeededHeight - otherHeight}
                  width={barWidth}
                  height={otherHeight}
                  className={styles.other}
                />
              )}
            </g>
          );
        })}
      </svg>

      <div className={styles.axis}>
        <span>24h ago</span>
        <span className={styles.legend}>
          <span className={styles.legendItem}>
            <i className={styles.swatchSucceeded} /> succeeded
          </span>
          <span className={styles.legendItem}>
            <i className={styles.swatchFailed} /> failed
          </span>
          <span className={styles.peak}>peak {max}/h</span>
        </span>
        <span>now</span>
      </div>
    </div>
  );
}
