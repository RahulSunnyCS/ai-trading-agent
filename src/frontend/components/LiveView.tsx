/**
 * LiveView — Real-time NIFTY index feed via WebSocket + polled straddle value.
 *
 * Two independent data sources:
 *  1. /ws/ticks  — WebSocket tick feed managed by useLiveTicks. Displays the
 *                  latest NIFTY index LTP and a small sparkline chart.
 *                  When simulate===false (live mode) the same socket now also
 *                  pushes real straddle values, surfaced via latestStraddle.
 *  2. GET /api/straddle/latest — Polled every ~10 s. Currently returns
 *                  {data: null} (stub). Will render the real value once the
 *                  straddle calculator connects.
 *
 * Feed banner:
 *  - GET /api/meta is fetched once on mount.
 *  - simulate===true  → amber "Synthetic dev feed" warning (random-walk data).
 *  - simulate===false → green "Live <broker> feed" indicator (real market data).
 *
 * Chart library: lightweight-charts v4 (createChart from 'lightweight-charts').
 * The Time type in v4 is UTCTimestamp = seconds since epoch. Our tick buffer
 * stores epoch *milliseconds*, so we divide by 1000 before handing to the chart.
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';

import { useLiveTicks } from '../hooks/useLiveTicks.js';
import type { StraddleSnapshot } from '../hooks/useLiveTicks.js';
import { apiGet, unwrapData } from '../lib/api.js';
import { formatIstDateTime } from '../lib/format.js';
import type { ApiEnvelope } from '../types/trading.js';

// ---------------------------------------------------------------------------
// /api/meta response shape
// ---------------------------------------------------------------------------

/**
 * Response shape for GET /api/meta.
 * simulate: true means the server is running in SIMULATE=true mode (random-walk data).
 * broker: the broker name string (e.g. "fyers") or empty string when unset.
 * authDegraded: true when the live broker token has expired or the connection
 *   has degraded (e.g. Fyers daily token rotation). Absent in older server
 *   versions — default to false so old servers remain fully compatible.
 */
interface MetaResponse {
  simulate: boolean;
  broker: string;
  authDegraded?: boolean;
}

// ---------------------------------------------------------------------------
// Polled straddle data shape (what /api/straddle/latest returns when connected)
// ---------------------------------------------------------------------------

/**
 * The shape of a connected straddle snapshot from the REST poll endpoint.
 * Currently the endpoint stubs `data: null`; when the straddle calculator
 * connects it will supply at minimum a `value` field.
 *
 * This is the REST-polled shape — distinct from the WS StraddleSnapshot
 * exported by useLiveTicks (which carries the live push data).
 *
 * Using `unknown` for extra fields so future additions don't break the type
 * without forcing a `[key: string]: unknown` index on the whole interface.
 */
interface PolledStraddleSnapshot {
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
 * Interval at which /api/meta is re-fetched in the background.
 * 30 s is a reasonable cadence: short enough that an authDegraded transition
 * surfaces within one market-minute; long enough to not add meaningful load.
 * A single fetch-on-mount is insufficient because the Fyers token can expire
 * during a session and the operator must be notified without a page reload.
 */
const META_POLL_MS = 30_000;

/**
 * Lightweight-charts layout colours matching the app dark theme.
 * We set the chart background to transparent so the card bg shows through, and
 * use gray-800 for the grid lines to match Tailwind's gray-800.
 */
const CHART_LAYOUT = {
  background: { color: 'transparent' },
  textColor: '#9ca3af', // Tailwind gray-400
} as const;

const CHART_GRID_COLOR = '#1f2937'; // Tailwind gray-800
const SERIES_LINE_COLOR = '#3b82f6'; // Tailwind blue-500

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
    <output
      className={`inline-flex items-center gap-1.5 rounded-full bg-gray-800 px-2.5 py-1 text-xs font-medium ring-1 ring-gray-700 ${text}`}
      aria-label={`WebSocket status: ${label}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </output>
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
  // null = not yet received; PolledStraddleSnapshot = live data from REST poll
  const [snapshot, setSnapshot] = useState<PolledStraddleSnapshot | null>(null);
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

      // The server wraps data in ApiEnvelope: { data: PolledStraddleSnapshot | null, message?: string }
      const result = await apiGet<ApiEnvelope<PolledStraddleSnapshot | null>>(
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
    const timerId = setInterval(() => {
      void poll();
    }, STRADDLE_POLL_MS);

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
              The straddle calculator has not connected yet. This will update automatically once the
              feed is live — no refresh needed.
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
        <p className="mt-2 text-xs text-amber-600">Poll error: {fetchError}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WS straddle panel
// ---------------------------------------------------------------------------

/**
 * Renders the latest straddle snapshot received from the WebSocket push stream.
 *
 * This is the primary straddle display when the straddle calculator is running
 * and pushing to the straddle.values Redis stream. It is distinct from
 * StraddleSection, which polls /api/straddle/latest (a REST stub).
 *
 * When `straddle` is null (no message received yet) it shows a subtle waiting
 * notice rather than hiding entirely — this is intentional so the user can see
 * the panel is expected and not missing.
 */
function WsStraddlePanel({ straddle }: { straddle: StraddleSnapshot | null }) {
  return (
    <div className="rounded-lg bg-gray-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">NIFTY Straddle (Live Push)</h2>
        <span className="text-xs text-gray-500">Via WebSocket</span>
      </div>

      {straddle === null ? (
        /* Waiting state — no straddle message received yet */
        <div className="flex items-start gap-2 rounded-md border border-gray-700 bg-gray-800/50 px-3 py-2.5">
          <svg
            className="mt-0.5 h-4 w-4 flex-shrink-0 animate-pulse text-gray-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z"
            />
          </svg>
          <div>
            <p className="text-sm text-gray-400">Waiting for first straddle update…</p>
            <p className="mt-0.5 text-xs text-gray-600">
              Straddle values arrive every ~15 s once the calculator is running.
            </p>
          </div>
        </div>
      ) : (
        /* Live straddle data — present once the WS push starts */
        <div>
          {/* Combined straddle premium is the primary value */}
          <p className="text-3xl font-bold tabular-nums text-white">
            {new Intl.NumberFormat('en-IN', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(straddle.straddleValue)}
          </p>

          {/* CE / PE leg breakdown */}
          <div className="mt-2 flex gap-4 text-xs text-gray-400">
            <span>
              ATM{' '}
              <span className="font-semibold tabular-nums text-gray-200">{straddle.atmStrike}</span>
            </span>
            <span>
              CE{' '}
              <span className="font-semibold tabular-nums text-blue-300">
                {new Intl.NumberFormat('en-IN', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }).format(straddle.cePrice)}
              </span>
            </span>
            <span>
              PE{' '}
              <span className="font-semibold tabular-nums text-purple-300">
                {new Intl.NumberFormat('en-IN', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }).format(straddle.pePrice)}
              </span>
            </span>
          </div>

          {/* Optional ROC / acceleration — only present after the ROC window fills */}
          {straddle.roc !== undefined && (
            <div className="mt-2 flex gap-4 text-xs text-gray-500">
              <span>
                ROC{' '}
                <span className="tabular-nums text-gray-300">
                  {straddle.roc > 0 ? '+' : ''}
                  {straddle.roc.toFixed(4)}
                </span>
              </span>
              {straddle.acceleration !== undefined && (
                <span>
                  Accel{' '}
                  <span className="tabular-nums text-gray-300">
                    {straddle.acceleration > 0 ? '+' : ''}
                    {straddle.acceleration.toFixed(4)}
                  </span>
                </span>
              )}
            </div>
          )}

          <p className="mt-1.5 text-xs text-gray-500">
            Updated: {formatIstDateTime(new Date(straddle.timestamp).toISOString())}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feed mode banner
// ---------------------------------------------------------------------------

/**
 * Login path for the Fyers broker auth flow.
 * Rendered as a hint inside the authDegraded banner so the operator can
 * navigate to the re-login entry point without hunting through the UI.
 * If the frontend ever introduces a dedicated auth page, update this constant.
 */
const FYERS_LOGIN_PATH = '/api/auth/fyers/login';

/**
 * Displays a contextual feed-mode label below the NIFTY sparkline.
 *
 *  simulate === true                    → amber warning: random-walk data, NOT real straddle data
 *  simulate === false, authDegraded     → red alert: Fyers token expired / connection degraded,
 *                                         re-login required
 *  simulate === false, !authDegraded    → green indicator: live broker feed
 *  simulate === null                    → loading state (while /api/meta is in-flight), renders nothing
 *
 * The broker name is shown in the live/degraded indicators when available so
 * operators can confirm which broker is active without checking server logs.
 *
 * Accessibility: the degraded banner uses role="alert" (assertive live region)
 * so screen-reader users are immediately notified; the normal indicators use
 * role="status" (polite live region).
 */
function FeedModeBanner({
  simulate,
  broker,
  authDegraded,
}: {
  simulate: boolean | null;
  broker: string;
  authDegraded: boolean;
}) {
  if (simulate === null) {
    // /api/meta is still loading — render nothing to avoid a flash.
    return null;
  }

  if (simulate) {
    return (
      <output
        className="mb-1 block text-xs font-medium uppercase tracking-wider text-amber-500"
        aria-label="Feed mode: synthetic dev feed — not real straddle data"
      >
        Synthetic dev feed — not real straddle data
      </output>
    );
  }

  // Live mode, token expired or connection degraded: show a prominent red alert.
  // This is the critical operator-facing signal — it must be hard to miss.
  if (authDegraded) {
    const brokerLabel = broker.length > 0 ? broker : 'broker';
    return (
      <div
        role="alert"
        aria-label={`Feed mode: ${brokerLabel} token expired or connection degraded — re-login required`}
        className="mb-2 flex flex-col gap-1 rounded-md border border-red-700 bg-red-950/60 px-3 py-2"
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-red-400">
          {brokerLabel} token expired / connection degraded — re-login required
        </p>
        {/* /login returns JSON { url, state } — the server stores the CSRF state
            server-side and embeds it in the returned Fyers authorization URL.
            We must fetch it and then navigate to url, NOT link directly to the
            endpoint (that would just render the JSON). Same-tab navigation keeps
            the dashboard in browser history. */}
        <button
          type="button"
          onClick={() => {
            // Open the popup SYNCHRONOUSLY inside the click gesture so the
            // browser's popup blocker allows it (a window.open() after an
            // `await` loses the user-gesture token and gets blocked). We then
            // point the popup at the Fyers OAuth URL once /login responds.
            // The OAuth flow MUST run in a separate tab: the /callback success
            // page closes itself via window.close(), and doing this in the
            // dashboard's own tab would navigate the SPA away ("shut off").
            const popup = window.open('', '_blank');
            void (async () => {
              try {
                const res = await fetch(FYERS_LOGIN_PATH);
                const data = (await res.json()) as { url?: string };
                if (!data.url) {
                  console.error('[LiveView] Fyers login URL missing in response', data);
                  popup?.close();
                  return;
                }
                if (popup) {
                  popup.location.href = data.url;
                } else {
                  // Popup blocked — fall back to same-tab navigation.
                  window.location.href = data.url;
                }
              } catch (err) {
                console.error('[LiveView] Failed to start Fyers login flow', err);
                popup?.close();
              }
            })();
          }}
          className="self-start text-xs text-red-300 underline underline-offset-2 hover:text-red-200"
          aria-label={`Re-login with ${brokerLabel}`}
        >
          Re-login with {brokerLabel} →
        </button>
      </div>
    );
  }

  // Live mode, healthy: show broker name when available, fall back to generic label.
  // The broker string from the server may be empty when BROKER env var is unset.
  const brokerLabel = broker.length > 0 ? broker : 'live';
  return (
    <output
      className="mb-1 block text-xs font-medium uppercase tracking-wider text-green-500"
      aria-label={`Feed mode: live ${brokerLabel} feed`}
    >
      Live {brokerLabel} feed
    </output>
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
function TickChart({
  ticks,
}: {
  ticks: readonly { time: number; ltp: number }[];
}) {
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

  return <div ref={containerRef} className="w-full rounded-md bg-gray-800" />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Live tab — WebSocket tick feed + straddle value.
 *
 * On mount, fetches GET /api/meta once to determine whether the server is
 * running in simulation mode. The result controls the feed banner in TickChart:
 *  - simulate===true  → amber "Synthetic dev feed" warning
 *  - simulate===false → green "Live <broker> feed" indicator
 *
 * The WS straddle snapshot (latestStraddle) is displayed in a dedicated panel
 * when present. The REST-polled /api/straddle/latest fallback is kept in place
 * to handle the period before the straddle calculator is connected.
 *
 * Named export only (no default export) per project conventions.
 */
export function LiveView() {
  const { status, latestLtp, latestTimestamp, ticks, latestStraddle } = useLiveTicks();

  // simulate: null = /api/meta not yet loaded (banner renders nothing to avoid flash)
  // simulate: true/false = server told us whether we are in simulation mode
  const [simulate, setSimulate] = useState<boolean | null>(null);
  const [broker, setBroker] = useState<string>('');
  // authDegraded: false by default — absent from older server responses (backward compat).
  // Becomes true when /api/meta reports the live broker token has expired or degraded.
  const [authDegraded, setAuthDegraded] = useState<boolean>(false);

  // Fetch /api/meta periodically so the authDegraded banner surfaces without a
  // page reload. The Fyers access token expires daily and the operator must be
  // notified promptly when it does; a single mount-time fetch would miss a
  // mid-session expiry. We use a setInterval + AbortController pair so:
  //  1. The first fetch fires immediately on mount (no blank banner wait).
  //  2. Subsequent fetches run every META_POLL_MS (30 s).
  //  3. The interval and any in-flight request are cancelled on unmount.
  useEffect(() => {
    const controller = new AbortController();
    // `inFlight` prevents overlapping requests if the server is slow.
    let inFlight = false;

    async function fetchMeta(): Promise<void> {
      if (inFlight) return;
      inFlight = true;

      const result = await apiGet<MetaResponse>('/api/meta', controller.signal);
      inFlight = false;

      // Silently ignore aborts — the normal cleanup path on unmount.
      if (!result.ok && result.error === 'AbortError') return;
      // Any other error: leave existing state intact so a transient network
      // hiccup doesn't flash the banner back to the loading state.
      if (!result.ok) return;
      if (result.data === null) return;

      setSimulate(result.data.simulate);
      setBroker(result.data.broker);
      // Absent field from older servers defaults to false — safe fallback.
      setAuthDegraded(result.data.authDegraded ?? false);
    }

    // Immediate fetch on mount so the banner appears without a 30 s delay.
    void fetchMeta();
    const timerId = setInterval(() => {
      void fetchMeta();
    }, META_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(timerId);
    };
  }, []);

  // Convert epoch ms timestamp to ISO string for formatIstDateTime.
  // formatIstDateTime expects an ISO-8601 string, not epoch ms directly.
  const lastUpdateIso = latestTimestamp !== null ? new Date(latestTimestamp).toISOString() : null;

  return (
    <div className="space-y-4">
      {/* Feed-mode banner — rendered at the top of the view so it ALWAYS shows,
          independent of whether any ticks have arrived. This matters most in the
          degraded/cold-start case (no token → no feed → zero ticks): the operator
          needs the "Login with Fyers" re-login button precisely when there is no
          data, so it must not live inside the tick-gated chart. */}
      <FeedModeBanner simulate={simulate} broker={broker} authDegraded={authDegraded} />

      {/* ------------------------------------------------------------------ */}
      {/* Section 1: NIFTY index live tick                                    */}
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
      {/* Section 2: Real-time straddle value from WS push                   */}
      {/* ------------------------------------------------------------------ */}
      <WsStraddlePanel straddle={latestStraddle} />

      {/* ------------------------------------------------------------------ */}
      {/* Section 3: Straddle value (polled /api/straddle/latest fallback)   */}
      {/* ------------------------------------------------------------------ */}
      <StraddleSection />
    </div>
  );
}
