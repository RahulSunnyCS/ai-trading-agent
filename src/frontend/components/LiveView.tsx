/**
 * LiveView — Real-time NIFTY index feed via WebSocket + polled straddle value.
 *
 * Two independent data sources:
 *  1. /ws/ticks  — WebSocket tick feed managed by useLiveTicks. Displays the
 *                  latest NIFTY index LTP and a small sparkline chart.
 *                  IMPORTANT: this is a SYNTHETIC dev feed (random-walk data),
 *                  never the real straddle value.
 *  2. GET /api/straddle/latest — Polled every ~10 s. Currently returns
 *                  {data: null} (stub). Will render the real value once the
 *                  straddle calculator connects.
 *
 * Chart library: lightweight-charts v4 (createChart from 'lightweight-charts').
 * The Time type in v4 is UTCTimestamp = seconds since epoch. Our tick buffer
 * stores epoch *milliseconds*, so we divide by 1000 before handing to the chart.
 */

import { useEffect, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';

import { useLiveTicks } from '../hooks/useLiveTicks.js';
import { apiGet, unwrapData } from '../lib/api.js';
import { formatIstDateTime } from '../lib/format.js';
import type { ApiEnvelope } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Straddle data shape (what /api/straddle/latest returns when connected)
// ---------------------------------------------------------------------------

/**
 * The shape of a connected straddle snapshot.
 * Currently the endpoint stubs `data: null`; when the straddle calculator
 * connects it will supply at minimum a `value` field.
 *
 * Using `unknown` for extra fields so future additions don't break the type
 * without forcing a `[key: string]: unknown` index on the whole interface.
 */
interface StraddleSnapshot {
  value: number;
  symbol?: string;
  timestamp?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Straddle poll interval. 10 s per the approved user decision — continuous
 * polling so the feed transitions from "not connected" to live automatically
 * without requiring a manual refresh.
 */
const STRADDLE_POLL_MS = 10_000;

/**
 * Lightweight-charts layout colours matching the app dark theme.
 * We set the chart background to transparent so the card bg shows through, and
 * use gray-800 for the grid lines to match Tailwind's gray-800.
 */
const CHART_LAYOUT = {
  background: { color: 'transparent' },
  textColor: '#9ca3af',       // Tailwind gray-400
} as const;

const CHART_GRID_COLOR = '#1f2937';   // Tailwind gray-800
const SERIES_LINE_COLOR = '#3b82f6';  // Tailwind blue-500

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Connection status pill.
 * Colour-coded by state:
 *  - connecting  → yellow  (amber) — expected momentary state on load/reconnect
 *  - connected   → green           — healthy
 *  - disconnected → red            — degraded, reconnecting in background
 */
function ConnectionPill({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) {
  const map = {
    connecting: {
      dot: 'bg-amber-400 animate-pulse',
      text: 'text-amber-300',
      label: 'Connecting…',
    },
    connected: {
      dot: 'bg-green-400',
      text: 'text-green-300',
      label: 'Connected',
    },
    disconnected: {
      dot: 'bg-red-400 animate-pulse',
      text: 'text-red-300',
      label: 'Disconnected — reconnecting',
    },
  } as const;

  const { dot, text, label } = map[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full bg-gray-800 px-2.5 py-1 text-xs font-medium ring-1 ring-gray-700 ${text}`}
      role="status"
      aria-label={`WebSocket status: ${label}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Straddle section
// ---------------------------------------------------------------------------

/**
 * Polls GET /api/straddle/latest on a fixed interval and renders the value,
 * or an honest "not yet connected" notice while data is null.
 *
 * Pattern mirrors usePaperTrades: AbortController aborts in-flight requests on
 * unmount, `inFlight` flag prevents overlapping polls.
 */
function StraddleSection() {
  // null = not yet received; StraddleSnapshot = live data
  const [snapshot, setSnapshot] = useState<StraddleSnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    // Guard: if a request is already in-flight, skip this tick to prevent
    // overlapping requests if the server is slow.
    let inFlight = false;

    async function poll(): Promise<void> {
      if (inFlight) return;
      inFlight = true;

      // The server wraps data in ApiEnvelope: { data: StraddleSnapshot | null, message?: string }
      const result = await apiGet<ApiEnvelope<StraddleSnapshot | null>>(
        '/api/straddle/latest',
        signal,
      );

      inFlight = false;

      // Silently ignore aborts — this is the normal cleanup path on unmount.
      if (!result.ok && result.error === 'AbortError') return;

      if (!result.ok) {
        // Show a subtle error without hiding what data we already have.
        setFetchError(result.error);
        return;
      }

      // unwrapData extracts the `data` field from the ApiEnvelope.
      const data = unwrapData(result.data);
      setFetchError(null);

      // data may be null (stub) or a real snapshot — update in both cases so
      // the component correctly transitions from null → live without a refresh.
      setSnapshot(data);
    }

    // Fire immediately on mount, then on the interval.
    void poll();
    const timerId = setInterval(() => { void poll(); }, STRADDLE_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(timerId);
    };
  }, []);

  return (
    <div className="rounded-lg bg-gray-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">NIFTY Straddle Value</h2>
        {/* Polling cadence label — reassures the user data is live */}
        <span className="text-xs text-gray-500">Polls every 10 s</span>
      </div>

      {snapshot === null ? (
        /* Honest "not yet connected" notice — this is the stub state */
        <div className="flex items-start gap-2 rounded-md border border-gray-700 bg-gray-800/50 px-3 py-2.5">
          <svg
            className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
          <div>
            <p className="text-sm text-gray-400">Straddle feed not yet connected</p>
            <p className="mt-0.5 text-xs text-gray-600">
              The straddle calculator has not connected yet. This will update
              automatically once the feed is live — no refresh needed.
            </p>
          </div>
        </div>
      ) : (
        /* Real straddle value — rendered once data becomes non-null */
        <div>
          <p className="text-3xl font-bold tabular-nums text-white">
            {new Intl.NumberFormat('en-IN', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(snapshot.value)}
          </p>
          {snapshot.symbol !== undefined && (
            <p className="mt-1 text-xs text-gray-500">{snapshot.symbol}</p>
          )}
          {snapshot.timestamp !== undefined && (
            <p className="mt-0.5 text-xs text-gray-500">
              Updated: {formatIstDateTime(snapshot.timestamp)}
            </p>
          )}
        </div>
      )}

      {/* Subtle fetch-error indicator — shown alongside data (never instead of it) */}
      {fetchError !== null && (
        <p className="mt-2 text-xs text-amber-600">
          Poll error: {fetchError}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tick chart
// ---------------------------------------------------------------------------

/**
 * Lightweight-charts sparkline of the recent NIFTY index tick buffer.
 *
 * Design decisions:
 *  - useRef for the container div: we need a stable DOM reference to pass to
 *    createChart. Putting it in state would force a re-render each time the
 *    DOM node mounts, racing the chart initialisation.
 *  - Chart and series are stored in refs (not state): they are mutable browser
 *    objects. Storing them in state would trigger unnecessary re-renders on
 *    every tick. React state is for values that should cause re-renders.
 *  - setData vs update: we call setData on every render that changes `ticks`
 *    because the hook can drop the oldest point (ring buffer), so `update`
 *    (append-only) would be incorrect. setData replaces the full series — safe
 *    for a 300-point buffer.
 *  - UTCTimestamp: lightweight-charts v4 requires time in SECONDS (not ms).
 *    Tick buffer stores epoch ms, so we divide by 1000 and cast to UTCTimestamp.
 *  - Duplicate times: the server can emit two ticks with the same epoch-second
 *    after integer division. We deduplicate by keeping the last value per
 *    second — lightweight-charts will throw on duplicate time values.
 */
function TickChart({ ticks }: { ticks: readonly { time: number; ltp: number }[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // These refs hold the chart and series instances across renders.
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  // Initialise the chart once on mount.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    const chart = createChart(el, {
      layout: CHART_LAYOUT,
      grid: {
        vertLines: { color: CHART_GRID_COLOR },
        horzLines: { color: CHART_GRID_COLOR },
      },
      // Hide the right price scale label to keep the panel compact.
      rightPriceScale: { borderColor: CHART_GRID_COLOR },
      timeScale: { borderColor: CHART_GRID_COLOR, timeVisible: true },
      // Remove the toolbar / watermark — this is an embedded panel, not a standalone chart.
      handleScale: false,
      handleScroll: false,
      // Width 0 = let the chart fill the container via CSS (auto-fit).
      width: 0,
      height: 160,
    });

    const series = chart.addLineSeries({
      color: SERIES_LINE_COLOR,
      lineWidth: 2,
      // Disable the last-price animation — it distracts in a multi-panel view.
      lastPriceAnimation: 0,
      // Hide the price line so the chart stays clean.
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // Fit the chart to its container width using ResizeObserver.
    // This is required because we initialise with width: 0 (fills CSS width).
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      chart.applyOptions({ width: entry.contentRect.width });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      // Detach series reference before removing the chart so any in-flight
      // setData calls find a null series and bail early (StrictMode safety).
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);
  // Empty deps: chart lifecycle is tied to component mount/unmount only.

  // Feed new tick data into the series whenever the buffer changes.
  useEffect(() => {
    const series = seriesRef.current;
    if (series === null) return;
    if (ticks.length === 0) return;

    // Convert epoch ms → UTCTimestamp (seconds) and deduplicate by second.
    // lightweight-charts throws if two points share the same time value.
    // We keep the LAST value for each second so the chart always shows the
    // most-recent tick for that second.
    const dedupMap = new Map<number, number>();
    for (const pt of ticks) {
      // Math.floor avoids fractional seconds that would differ per tick.
      const sec = Math.floor(pt.time / 1000);
      dedupMap.set(sec, pt.ltp);
    }

    // Convert to sorted LineData array (chart requires ascending time).
    const lineData = Array.from(dedupMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([sec, value]) => ({
        time: sec as UTCTimestamp,
        value,
      }));

    series.setData(lineData);
    // Scroll to the most-recent point so the user always sees the latest data.
    chartRef.current?.timeScale().scrollToRealTime();
  }, [ticks]);

  return (
    <div>
      {/* Synthetic feed label — required by the acceptance criteria:
          this is NOT real straddle data, just a random-walk NIFTY index ticker. */}
      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-amber-500">
        ⚠ Synthetic dev feed — not real straddle data
      </p>
      <div ref={containerRef} className="w-full rounded-md bg-gray-800" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Live tab — WebSocket tick feed + polled straddle value.
 *
 * Named export only (no default export) per project conventions.
 */
export function LiveView() {
  const { status, latestLtp, latestTimestamp, ticks } = useLiveTicks();

  // Convert epoch ms timestamp to ISO string for formatIstDateTime.
  // formatIstDateTime expects an ISO-8601 string, not epoch ms directly.
  const lastUpdateIso =
    latestTimestamp !== null ? new Date(latestTimestamp).toISOString() : null;

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------------ */}
      {/* Section 1: NIFTY index live tick (synthetic dev feed)               */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg bg-gray-900 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-white">NIFTY Index (Live Feed)</h2>
          <ConnectionPill status={status} />
        </div>

        {/* Latest LTP */}
        <div className="mb-4">
          {latestLtp !== null ? (
            <>
              <p className="text-3xl font-bold tabular-nums text-white">
                {new Intl.NumberFormat('en-IN', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }).format(latestLtp)}
              </p>
              {lastUpdateIso !== null && (
                <p className="mt-1 text-xs text-gray-500">
                  Last update: {formatIstDateTime(lastUpdateIso)}
                </p>
              )}
            </>
          ) : (
            <div>
              <p className="text-3xl font-bold tabular-nums text-gray-600">--</p>
              <p className="mt-1 text-xs text-gray-600">
                {status === 'connecting' ? 'Connecting to feed…' : 'No data received yet'}
              </p>
            </div>
          )}
        </div>

        {/* Sparkline chart — only rendered once we have at least one tick to
            avoid an empty chart flash on load. Handles 0 points gracefully
            (returns null) and 1+ points without crashing. */}
        {ticks.length > 0 && <TickChart ticks={ticks} />}

        {/* Empty state when connected but no ticks yet */}
        {ticks.length === 0 && status === 'connected' && (
          <p className="text-xs text-gray-600 italic">Waiting for first tick…</p>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section 2: Straddle value (polled, honest about current stub state) */}
      {/* ------------------------------------------------------------------ */}
      <StraddleSection />
    </div>
  );
}
