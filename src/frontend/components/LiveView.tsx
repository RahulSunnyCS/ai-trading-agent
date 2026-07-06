/**
 * LiveView — Real-time NIFTY index feed via WebSocket + polled straddle value.
 *
 * Two independent data sources:
 *  1. /ws/ticks  — WebSocket tick feed (useLiveTicks): latest NIFTY LTP, a
 *                  sparkline, and (in live mode) pushed straddle values.
 *  2. GET /api/straddle/latest — polled every ~10 s fallback.
 *
 * /api/meta is polled every 30 s for the feed-mode banner + authDegraded state
 * (Fyers token expires daily; the re-login flow must surface without a reload).
 *
 * Charts use lightweight-charts v4 and are theme-aware (recolor on theme flip).
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { Clock, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useLiveTicks } from '../hooks/useLiveTicks.js';
import type { StraddleSnapshot } from '../hooks/useLiveTicks.js';
import { apiGet, unwrapData } from '../lib/api.js';
import { getChartTheme } from '../lib/chartTheme';
import { formatIstDateTime } from '../lib/format.js';
import { useThemeStore } from '../store/theme';
import type { ApiEnvelope } from '../types/trading.js';
import { Badge, type Tone } from './ui/Badge';
import { Card } from './ui/Card';
import { StatusDot } from './ui/StatusDot';

interface MetaResponse {
  simulate: boolean;
  broker: string;
  authDegraded?: boolean;
}

interface PolledStraddleSnapshot {
  value: number;
  symbol?: string;
  timestamp?: string;
  [key: string]: unknown;
}

const STRADDLE_POLL_MS = 10_000;
const META_POLL_MS = 30_000;
const FYERS_LOGIN_PATH = '/api/auth/fyers/login';

const num2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Connection status pill
// ---------------------------------------------------------------------------

function ConnectionPill({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) {
  const map: Record<typeof status, { tone: Tone; label: string; pulse: boolean }> = {
    connecting: { tone: 'warning', label: 'Connecting…', pulse: true },
    connected: { tone: 'positive', label: 'Connected', pulse: false },
    disconnected: { tone: 'negative', label: 'Disconnected — reconnecting', pulse: true },
  };
  const { tone, label, pulse } = map[status];
  return (
    <Badge tone={tone}>
      <StatusDot tone={tone} pulse={pulse} />
      {label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Polled straddle (REST fallback)
// ---------------------------------------------------------------------------

function StraddleSection() {
  const [snapshot, setSnapshot] = useState<PolledStraddleSnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let inFlight = false;

    async function poll(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      const result = await apiGet<ApiEnvelope<PolledStraddleSnapshot | null>>(
        '/api/straddle/latest',
        signal,
      );
      inFlight = false;
      if (!result.ok && result.error === 'AbortError') return;
      if (!result.ok) {
        setFetchError(result.error);
        return;
      }
      setFetchError(null);
      setSnapshot(unwrapData(result.data));
    }

    void poll();
    const timerId = setInterval(() => void poll(), STRADDLE_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timerId);
    };
  }, []);

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">Straddle Value</h2>
        <span className="text-xs text-faint">REST poll · 10s</span>
      </div>

      {snapshot === null ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2/50 px-3 py-2.5">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
          <div>
            <p className="text-sm text-muted">Straddle feed not yet connected</p>
            <p className="mt-0.5 text-xs text-faint">
              Updates automatically once the calculator is live — no refresh needed.
            </p>
          </div>
        </div>
      ) : (
        <div>
          <p className="metric text-3xl font-semibold tracking-tight text-foreground">
            {num2.format(snapshot.value)}
          </p>
          {snapshot.symbol !== undefined && (
            <p className="mt-1 text-xs text-faint">{snapshot.symbol}</p>
          )}
          {snapshot.timestamp !== undefined && (
            <p className="mt-0.5 text-xs text-faint">
              Updated: {formatIstDateTime(snapshot.timestamp)}
            </p>
          )}
        </div>
      )}

      {fetchError !== null && <p className="mt-2 text-xs text-warning">Poll error: {fetchError}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// WS straddle panel
// ---------------------------------------------------------------------------

function Leg({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/50 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={`metric mt-0.5 text-sm font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function WsStraddlePanel({ straddle }: { straddle: StraddleSnapshot | null }) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          Straddle (Live Push)
        </h2>
        <span className="text-xs text-faint">WebSocket · ~15s</span>
      </div>

      {straddle === null ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2/50 px-3 py-2.5">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 animate-pulse text-faint" />
          <div>
            <p className="text-sm text-muted">Waiting for first straddle update…</p>
            <p className="mt-0.5 text-xs text-faint">
              Values arrive every ~15 s once the calculator runs.
            </p>
          </div>
        </div>
      ) : (
        <div>
          <p className="metric text-3xl font-semibold tracking-tight text-foreground">
            {num2.format(straddle.straddleValue)}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Leg label="ATM" value={String(straddle.atmStrike)} tone="text-foreground" />
            <Leg label="CE" value={num2.format(straddle.cePrice)} tone="text-info" />
            <Leg label="PE" value={num2.format(straddle.pePrice)} tone="text-accent" />
          </div>
          {straddle.roc !== undefined && (
            <div className="mt-3 flex gap-4 text-xs text-muted">
              <span>
                ROC{' '}
                <span className="tabular-nums text-foreground">
                  {straddle.roc > 0 ? '+' : ''}
                  {straddle.roc.toFixed(4)}
                </span>
              </span>
              {straddle.acceleration !== undefined && (
                <span>
                  Accel{' '}
                  <span className="tabular-nums text-foreground">
                    {straddle.acceleration > 0 ? '+' : ''}
                    {straddle.acceleration.toFixed(4)}
                  </span>
                </span>
              )}
            </div>
          )}
          <p className="mt-2 text-xs text-faint">
            Updated: {formatIstDateTime(new Date(straddle.timestamp).toISOString())}
          </p>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Feed-mode banner (logic preserved; restyled to tokens)
// ---------------------------------------------------------------------------

function FeedModeBanner({
  simulate,
  broker,
  authDegraded,
}: {
  simulate: boolean | null;
  broker: string;
  authDegraded: boolean;
}) {
  if (simulate === null) return null;

  if (simulate) {
    return (
      <output
        className="flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs font-medium text-warning"
        aria-label="Feed mode: synthetic dev feed — not real straddle data"
      >
        <TriangleAlert className="h-3.5 w-3.5" />
        Synthetic dev feed — not real straddle data
      </output>
    );
  }

  if (authDegraded) {
    const brokerLabel = broker.length > 0 ? broker : 'broker';
    return (
      <div
        role="alert"
        aria-label={`Feed mode: ${brokerLabel} token expired or connection degraded — re-login required`}
        className="flex flex-col gap-1 rounded-lg border border-negative/30 bg-negative/10 px-3 py-2.5"
      >
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-negative">
          <TriangleAlert className="h-3.5 w-3.5" />
          {brokerLabel} token expired / connection degraded — re-login required
        </p>
        <button
          type="button"
          onClick={() => {
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
                  window.location.href = data.url;
                }
              } catch (err) {
                console.error('[LiveView] Failed to start Fyers login flow', err);
                popup?.close();
              }
            })();
          }}
          className="self-start text-xs font-medium text-negative underline underline-offset-2 hover:opacity-80"
          aria-label={`Re-login with ${brokerLabel}`}
        >
          Re-login with {brokerLabel} →
        </button>
      </div>
    );
  }

  const brokerLabel = broker.length > 0 ? broker : 'live';
  return (
    <output
      className="flex items-center gap-2 rounded-lg border border-positive/25 bg-positive/10 px-3 py-2 text-xs font-medium text-positive"
      aria-label={`Feed mode: live ${brokerLabel} feed`}
    >
      <StatusDot tone="positive" pulse />
      Live {brokerLabel} feed
    </output>
  );
}

// ---------------------------------------------------------------------------
// Tick sparkline (theme-aware)
// ---------------------------------------------------------------------------

function TickChart({ ticks }: { ticks: readonly { time: number; ltp: number }[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    const chart = createChart(el, {
      layout: { background: { color: 'transparent' }, textColor: '#888' },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      handleScale: false,
      handleScroll: false,
      width: 0,
      height: 180,
    });
    const series = chart.addLineSeries({
      lineWidth: 2,
      lastPriceAnimation: 0,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      chart.applyOptions({ width: entry.contentRect.width });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  // Theme colors (mount + on flip).
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (chart === null || series === null) return;
    const t = getChartTheme(theme);
    chart.applyOptions({
      layout: { background: { color: 'transparent' }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    });
    series.applyOptions({ color: t.primary });
  }, [theme]);

  useEffect(() => {
    const series = seriesRef.current;
    if (series === null) return;
    if (ticks.length === 0) return;

    const dedupMap = new Map<number, number>();
    for (const pt of ticks) {
      const sec = Math.floor(pt.time / 1000);
      dedupMap.set(sec, pt.ltp);
    }
    const lineData = Array.from(dedupMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([sec, value]) => ({ time: sec as UTCTimestamp, value }));

    series.setData(lineData);
    chartRef.current?.timeScale().scrollToRealTime();
  }, [ticks]);

  return (
    <div
      ref={containerRef}
      className="w-full rounded-lg border border-border bg-surface-2/40 p-1"
    />
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LiveView() {
  const { status, latestLtp, latestTimestamp, ticks, latestStraddle } = useLiveTicks();

  const [simulate, setSimulate] = useState<boolean | null>(null);
  const [broker, setBroker] = useState<string>('');
  const [authDegraded, setAuthDegraded] = useState<boolean>(false);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;

    async function fetchMeta(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      const result = await apiGet<MetaResponse>('/api/meta', controller.signal);
      inFlight = false;
      if (!result.ok && result.error === 'AbortError') return;
      if (!result.ok) return;
      if (result.data === null) return;
      setSimulate(result.data.simulate);
      setBroker(result.data.broker);
      setAuthDegraded(result.data.authDegraded ?? false);
    }

    void fetchMeta();
    const timerId = setInterval(() => void fetchMeta(), META_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timerId);
    };
  }, []);

  const lastUpdateIso = latestTimestamp !== null ? new Date(latestTimestamp).toISOString() : null;

  return (
    <div className="space-y-5">
      <FeedModeBanner simulate={simulate} broker={broker} authDegraded={authDegraded} />

      {/* NIFTY index live feed — hero panel */}
      <Card>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-faint">
              NIFTY Index · Live
            </p>
            {latestLtp !== null ? (
              <>
                <p className="metric mt-1 text-4xl font-semibold tracking-tight text-foreground">
                  {num2.format(latestLtp)}
                </p>
                {lastUpdateIso !== null && (
                  <p className="mt-1 text-xs text-faint">
                    Last update: {formatIstDateTime(lastUpdateIso)}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="metric mt-1 text-4xl font-semibold tracking-tight text-faint">––</p>
                <p className="mt-1 text-xs text-faint">
                  {status === 'connecting' ? 'Connecting to feed…' : 'No data received yet'}
                </p>
              </>
            )}
          </div>
          <ConnectionPill status={status} />
        </div>

        {ticks.length > 0 && <TickChart ticks={ticks} />}
        {ticks.length === 0 && status === 'connected' && (
          <p className="text-xs italic text-faint">Waiting for first tick…</p>
        )}
      </Card>

      {/* Straddle panels */}
      <div className="grid gap-5 lg:grid-cols-2">
        <WsStraddlePanel straddle={latestStraddle} />
        <StraddleSection />
      </div>
    </div>
  );
}
