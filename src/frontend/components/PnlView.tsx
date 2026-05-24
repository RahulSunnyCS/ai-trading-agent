/**
 * PnlView — realized P&L aggregates and cumulative chart for the P&L tab.
 *
 * Data source: the shared usePaperTrades hook (polled from GET /api/trades).
 * This component NEVER fetches trades itself — TradesView and PnlView both
 * consume the same hook to avoid duplicate network calls and duplicate state.
 *
 * States rendered:
 *  1. Loading        — initial fetch in-flight; skeleton shown
 *  2. Error          — hook reported an error; visually distinct amber banner,
 *                      NEVER renders zeroed-out numbers as if no trades exist
 *  3. No closed trades — calm informational state that also notes any open
 *                        positions so the user isn't confused by blank metrics
 *  4. Data present   — aggregates + cumulative Lightweight Charts line
 *
 * P&L honesty constraints (from task contract):
 *  - The headline total is labelled "Realized P&L (closed trades)" — not "P&L"
 *    which could imply unrealized gains.
 *  - Open positions are surfaced as a separate count; we never invent an
 *    unrealized P&L number (we don't have current market prices here).
 *  - Error state must NOT render as flat 0.00 / 0% (the component must
 *    visually distinguish "real zero-activity day" from "fetch failed").
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useEffect, useMemo, useRef } from 'react';

import { usePaperTrades } from '../hooks/usePaperTrades.js';
import { formatPnl } from '../lib/format.js';
import { type PnlSeriesPoint, computePnlSummary } from '../lib/pnl.js';

// ---------------------------------------------------------------------------
// Sub-components — state-specific renders
// ---------------------------------------------------------------------------

/**
 * Shown while the very first fetch is in-flight.
 * Uses the same pulsing shimmer pattern as TradesView for visual consistency.
 */
function LoadingState() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="status" live region for loading state; <output> would alter block layout.
    <div className="space-y-3 pt-4" role="status" aria-label="Loading P&L data">
      {Array.from({ length: 4 }, (_, i) => `pnl-skeleton-${i}`).map((key) => (
        <div key={key} className="h-10 animate-pulse rounded bg-gray-800" aria-hidden="true" />
      ))}
    </div>
  );
}

/**
 * Shown when the hook reported a network or HTTP error.
 *
 * Must be visually distinct from the no-data state — amber/warning colour
 * signals a degraded system, not a calm no-activity day.
 * We deliberately do NOT show zero P&L values here because rendering
 * "Realized P&L: 0.00" during a fetch failure would be misleading.
 */
function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-4 flex items-start gap-3 rounded-lg border border-amber-800/60 bg-amber-900/20 px-4 py-3"
    >
      <svg
        className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
        />
      </svg>
      <div>
        <p className="text-sm font-medium text-amber-300">
          Couldn&apos;t load P&amp;L data — retrying&hellip;
        </p>
        <p className="mt-0.5 text-xs text-amber-600">{message}</p>
      </div>
    </div>
  );
}

/**
 * Shown when there are no closed trades yet.
 *
 * If there are open positions we mention them explicitly — otherwise the user
 * might think the entire system is idle when trades are actually running.
 */
function EmptyClosedState({ openCount }: { openCount: number }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <svg
        className="mb-3 h-10 w-10 text-gray-700"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
        />
      </svg>
      <p className="text-sm font-medium text-gray-400">No closed trades yet.</p>
      <p className="mt-1 text-xs text-gray-600">
        Realized P&amp;L will appear once the first position is closed.
      </p>
      {/* Surface open positions so the user understands the system is active */}
      {openCount > 0 && (
        <p className="mt-2 text-xs text-blue-400">
          {openCount} open position{openCount !== 1 ? 's' : ''} currently running.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card — reusable metric tile
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: string;
  /** Optional colour override for the value text. Defaults to text-gray-100. */
  valueClass?: string;
  /** Optional small note rendered below the value. */
  note?: string;
}

/**
 * A simple metric tile used in the summary row.
 * Consistent padding and typography so all cards align visually.
 */
function StatCard({ label, value, valueClass = 'text-gray-100', note }: StatCardProps) {
  return (
    <div className="rounded-lg bg-gray-800 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
      {note !== undefined && <p className="mt-0.5 text-xs text-gray-600">{note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cumulative P&L chart
// ---------------------------------------------------------------------------

interface CumulativeChartProps {
  series: PnlSeriesPoint[];
}

/**
 * Renders the cumulative P&L line using Lightweight Charts v4.
 *
 * Follows the same split-effect pattern as TickChart in LiveView.tsx:
 *  - Effect 1 (empty deps): creates the chart, line series, and ResizeObserver
 *    exactly once on mount, stores them in refs, and cleans them up on unmount.
 *  - Effect 2 ([series] dep): pushes new data into the existing series via
 *    seriesRef.current.setData(). Because the chart instance is never torn down
 *    between polls, the user's zoom/scroll position is preserved across every
 *    10 s update.
 *
 * Edge-case handling:
 *  - 0 points: the parent gates rendering behind closedCount > 0, so
 *    CumulativeChart only mounts when there is at least one closed trade.
 *    The data effect still guards series.length === 0 for safety.
 *  - 1 point: setData([single]) is valid in LWC v4; it renders a single dot.
 *  - Many points: normal line chart.
 *
 * Why a separate component: the chart imperative setup is complex enough to
 * isolate.  It also lets PnlView stay a clean declarative shell.
 */
function CumulativeChart({ series }: CumulativeChartProps) {
  // Ref to the DOM container element that Lightweight Charts mounts into.
  const containerRef = useRef<HTMLDivElement>(null);
  // Chart and series instances stored in refs so the data-update effect can
  // reach them without re-triggering the mount effect.
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  // Effect 1: create the chart + series + ResizeObserver exactly once on mount.
  // Empty deps array ensures this runs only at mount/unmount — not on every poll.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    // Create the chart instance. We size it to the container's width and use
    // a fixed height. Dark-theme colours match the rest of the dashboard
    // (bg-gray-900 background, gray-700 grid/border lines).
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 200,
      layout: {
        background: { color: '#111827' }, // bg-gray-900 equivalent
        textColor: '#9ca3af', // text-gray-400 equivalent
      },
      grid: {
        vertLines: { color: '#1f2937' }, // gray-800 — subtle grid
        horzLines: { color: '#1f2937' },
      },
      rightPriceScale: {
        borderColor: '#374151', // gray-700
      },
      timeScale: {
        borderColor: '#374151',
        // Leave a small gap on the right so the last label is not clipped.
        rightOffset: 2,
      },
    });

    // Add the line series. We colour it green for profit — the value label
    // makes the sign clear when the running total goes negative.
    const lineSeries = chart.addLineSeries({
      color: '#4ade80', // green-400 — visible on dark background
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
    });

    chartRef.current = chart;
    seriesRef.current = lineSeries;

    // Resize observer: keep the chart width in sync if the container resizes.
    // Without this the chart overflows or leaves blank space on window resize.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    observer.observe(container);

    // Cleanup: null the refs first (guards in-flight setData calls in
    // StrictMode double-invoke), then disconnect the observer and remove
    // the chart from the DOM.
    return () => {
      seriesRef.current = null;
      chartRef.current = null;
      observer.disconnect();
      chart.remove();
    };
  }, []); // Empty deps: chart lifecycle is tied to mount/unmount only.

  // Effect 2: push new data into the existing series whenever `series` changes.
  // The chart instance is NOT recreated — only its data is updated — so the
  // user's zoom/scroll position survives each 10 s poll cycle.
  useEffect(() => {
    const lineSeries = seriesRef.current;
    if (lineSeries === null) return;
    // PnlSeriesPoint.time is YYYY-MM-DD which LWC v4 accepts as `Time`.
    // setData replaces the full series; safe here because P&L points can be
    // re-ordered/backdated on the same day if new closed trades arrive.
    if (series.length > 0) {
      lineSeries.setData(series);
      // Fit all points into the visible window after loading data.
      chartRef.current?.timeScale().fitContent();
    }
  }, [series]);

  return (
    <div
      ref={containerRef}
      className="w-full"
      // Explicit min-height prevents a zero-height container flash before
      // Lightweight Charts measures and sets the width/height.
      style={{ minHeight: 200 }}
      aria-label="Cumulative P&L chart"
    />
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * P&L tab — consumes the shared usePaperTrades hook and displays:
 *   • Realized P&L total (closed trades only)
 *   • Today's realized P&L (IST date)
 *   • Win rate
 *   • Open and closed position counts
 *   • Cumulative P&L line chart (Lightweight Charts v4)
 *
 * Named export — no default export per project convention.
 */
export function PnlView() {
  const { trades, loading, error } = usePaperTrades();

  // Memoize the summary so that computePnlSummary returns a stable object
  // reference when `trades` has not changed. Without this, every render
  // (including React StrictMode double-invokes) produces a new `summary`
  // object with a new `cumulativeSeries` array reference, which triggers
  // CumulativeChart's data effect on every poll cycle — causing the chart
  // to flash and lose user zoom. useMemo ensures the reference only changes
  // when `trades` identity changes (i.e. when the hook receives new data).
  const summary = useMemo(() => computePnlSummary(trades), [trades]);

  // Colour-code the total P&L value: green = profit, red = loss, neutral = zero.
  function totalPnlClass(): string {
    if (summary.totalRealizedPnl > 0) return 'text-green-400';
    if (summary.totalRealizedPnl < 0) return 'text-red-400';
    return 'text-gray-100';
  }

  function todayPnlClass(): string {
    if (summary.todayRealizedPnl > 0) return 'text-green-400';
    if (summary.todayRealizedPnl < 0) return 'text-red-400';
    return 'text-gray-100';
  }

  return (
    <div className="rounded-lg bg-gray-900 p-4">
      <h2 className="text-lg font-semibold text-white">P&amp;L Summary</h2>

      {/* Loading skeleton — only shown on the initial fetch before any data arrives. */}
      {loading && trades.length === 0 && <LoadingState />}

      {/* Error banner — always shown when the hook has an error.
          We render the banner but NOT the metrics/chart so the user cannot
          misread a stale-zeroed-out value as a real no-activity state. */}
      {error !== null && <ErrorState message={error} />}

      {/* Empty state — only when not loading, no error, and no closed trades. */}
      {!loading && error === null && summary.closedCount === 0 && (
        <EmptyClosedState openCount={summary.openCount} />
      )}

      {/* Metrics and chart — shown when there are closed trades.
          We render these even if there is also an error (stale-but-visible
          is better than blank for a trading dashboard), but the error banner
          above makes the data freshness clear. */}
      {summary.closedCount > 0 && (
        <div className="mt-4 space-y-4">
          {/* Summary metric row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {/* Total realized P&L — labelled explicitly to avoid implying unrealized */}
            <StatCard
              label="Realized P&L (closed trades)"
              value={formatPnl(summary.totalRealizedPnl)}
              valueClass={totalPnlClass()}
            />

            {/* Today's realized P&L — IST calendar date */}
            <StatCard
              label="Today's P&L (IST)"
              value={formatPnl(summary.todayRealizedPnl)}
              valueClass={todayPnlClass()}
            />

            {/* Win rate as a percentage */}
            <StatCard label="Win Rate" value={`${(summary.winRate * 100).toFixed(1)}%`} />

            {/* Closed count */}
            <StatCard label="Closed Trades" value={String(summary.closedCount)} />

            {/* Open count — explicitly separate to avoid implying unrealized P&L.
                We show this even when 0 so the grid is stable. */}
            <StatCard
              label="Open Positions"
              value={String(summary.openCount)}
              note="Unrealized P&L not shown"
            />
          </div>

          {/* Cumulative P&L chart */}
          <div className="rounded-lg bg-gray-800 p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">
              Cumulative Realized P&amp;L
            </p>
            <CumulativeChart series={summary.cumulativeSeries} />
          </div>
        </div>
      )}
    </div>
  );
}
