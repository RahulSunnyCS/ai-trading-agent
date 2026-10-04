/**
 * Options Lab → "why did this day end where it did": one saved strategy-day,
 * re-simulated server-side (GET /legwise/day — the engine is deterministic, so no
 * curves are stored). Shows the intraday MTM against the index, entry/exit/SL/
 * target markers, the intraday segment cuts with their anatomy, each leg's
 * premium, and per-leg attribution.
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { DEFAULT_CUTS, useDayForensics } from '../../hooks/useLegwise';
import { getChartTheme, getSeriesPalette, pickSeries, withAlpha } from '../../lib/chartTheme';
import { formatPnl } from '../../lib/format';
import { useThemeStore } from '../../store/theme';
import type { DayForensics as Forensics, TimedValue } from '../../types/legwise';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { LABEL_TEXT, LABEL_TONE, describeSegment } from './anatomy';
import { TradeLog, pnlClass } from './shared';

const CHART_HEIGHT = 300;

const toData = (points: TimedValue[]) =>
  points.map((p) => ({ time: p.ts as UTCTimestamp, value: p.v }));

/** Create/resize/theme a Lightweight chart; returns a ref to the live chart. */
function useChart(container: React.RefObject<HTMLDivElement>, withLeftScale: boolean) {
  const chartRef = useRef<IChartApi | null>(null);
  const [ready, setReady] = useState(false);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const el = container.current;
    if (el === null) return;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: CHART_HEIGHT,
      layout: { background: { color: 'transparent' } },
      leftPriceScale: { visible: withLeftScale },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 2 },
    });
    chartRef.current = chart;
    setReady(true);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) chart.applyOptions({ width: entry.contentRect.width });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      chartRef.current = null;
      setReady(false);
      chart.remove();
    };
  }, [container, withLeftScale]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || chart === null) return; // `ready` re-runs this once the chart exists
    const t = getChartTheme(theme);
    chart.applyOptions({
      layout: { background: { color: 'transparent' }, textColor: t.text, fontFamily: t.fontFamily },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      leftPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
  }, [theme, ready]);

  return { chartRef, ready, theme };
}

/** Snap a marker time onto an existing data time — markers off the series are not drawn. */
function snapper(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  return (ts: number): number => {
    let best = sorted[0] ?? ts;
    for (const t of sorted) {
      if (t > ts) break;
      best = t;
    }
    return best;
  };
}

function MtmChart({ f }: { f: Forensics }) {
  const container = useRef<HTMLDivElement>(null);
  const { chartRef, ready, theme } = useChart(container, true);
  const [, setTick] = useState(0); // re-render the cut overlay when the time axis moves

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null || !ready) return;
    const t = getChartTheme(theme);
    const series: ISeriesApi<'Baseline' | 'Line'>[] = [];

    const mtm = chart.addBaselineSeries({
      baseValue: { type: 'price', price: 0 },
      topLineColor: t.positive,
      topFillColor1: withAlpha(t.positive, 0.28),
      topFillColor2: withAlpha(t.positive, 0.04),
      bottomLineColor: t.negative,
      bottomFillColor1: withAlpha(t.negative, 0.04),
      bottomFillColor2: withAlpha(t.negative, 0.28),
      lineWidth: 2,
      priceScaleId: 'right',
      title: 'MTM ₹',
      priceLineVisible: false,
    });
    mtm.setData(toData(f.mtm));
    series.push(mtm);

    const spot = chart.addLineSeries({
      color: t.info,
      lineWidth: 1,
      priceScaleId: 'left',
      title: f.underlying,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    spot.setData(toData(f.spot));
    series.push(spot);

    const snap = snapper(f.mtm.map((p) => p.ts));
    const markers: SeriesMarker<Time>[] = [...f.markers]
      .sort((a, b) => a.ts - b.ts)
      .map((m) => {
        const color =
          m.kind === 'entry'
            ? t.primary
            : m.reason === 'SL'
              ? t.negative
              : m.reason === 'TARGET'
                ? t.positive
                : t.warning;
        return {
          time: snap(m.ts) as UTCTimestamp,
          position: m.kind === 'entry' ? 'belowBar' : 'aboveBar',
          shape: m.kind === 'entry' ? 'arrowUp' : 'arrowDown',
          color,
          text: m.kind === 'entry' ? `${m.leg} in` : `${m.leg} ${m.reason ?? 'out'}`,
        };
      });
    mtm.setMarkers(markers);

    chart.timeScale().fitContent();
    const bump = () => setTick((n) => n + 1);
    chart.timeScale().subscribeVisibleTimeRangeChange(bump);
    bump();
    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(bump);
      for (const s of series) {
        try {
          chart.removeSeries(s);
        } catch {
          // chart already disposed on unmount
        }
      }
    };
  }, [f, ready, theme, chartRef]);

  const chart = chartRef.current;
  return (
    <div className="relative">
      <div ref={container} className="w-full" style={{ minHeight: CHART_HEIGHT }} />
      {/* Segment cuts: dashed verticals positioned from the live time scale. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {chart &&
          f.cuts.map((c) => {
            const x = chart.timeScale().timeToCoordinate(c.ts as UTCTimestamp);
            return x === null ? null : (
              <div
                key={c.ts}
                className="absolute top-0 bottom-6 border-l border-dashed border-border-strong"
                style={{ left: x }}
              >
                <span className="ml-1 text-[10px] text-faint">{c.t}</span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

function PremiumChart({ f }: { f: Forensics }) {
  const container = useRef<HTMLDivElement>(null);
  const { chartRef, ready } = useChart(container, false);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null || !ready) return;
    const palette = getSeriesPalette(theme);
    const lines = f.legs.map((leg, i) => {
      const s = chart.addLineSeries({
        color: pickSeries(palette, i),
        lineWidth: 2,
        title: `${leg.leg} ${leg.contract}`,
        priceLineVisible: false,
      });
      s.setData(toData(leg.premium));
      return s;
    });
    chart.timeScale().fitContent();
    return () => {
      for (const s of lines) {
        try {
          chart.removeSeries(s);
        } catch {
          // chart already disposed on unmount
        }
      }
    };
  }, [f, ready, chartRef, theme]);

  return <div ref={container} className="w-full" style={{ minHeight: CHART_HEIGHT }} />;
}

function Anatomy({ f }: { f: Forensics }) {
  const a = f.anatomy;
  if (!a) {
    return (
      <p className="text-xs text-muted">
        No index/VIX history for this day, so no anatomy. Run <code>obt fyers history</code>.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span>{a.weekday}</span>
        <span>
          gap {a.gap_pct === null ? 'n/a' : `${a.gap_pct >= 0 ? '+' : ''}${a.gap_pct.toFixed(2)}%`}
        </span>
        <span>VIX open {a.vix_open ?? 'n/a'}</span>
        <span>{a.dte === null ? 'DTE n/a' : a.is_expiry ? 'expiry day' : `${a.dte} DTE`}</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {a.segments.map((s) =>
          s ? (
            <div
              key={s.start}
              title={describeSegment(s)}
              className="rounded-lg border border-border bg-surface-2/50 px-3 py-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">
                  {s.start}–{s.end}
                </span>
                <Badge tone={LABEL_TONE[s.label]}>{LABEL_TEXT[s.label]}</Badge>
              </div>
              <div className="metric mt-1 text-xs text-muted">
                move {s.ret_pct >= 0 ? '+' : ''}
                {s.ret_pct.toFixed(2)}% · range ×
                {s.range_over_implied === null ? 'n/a' : s.range_over_implied.toFixed(2)} implied ·
                strength {s.strength.toFixed(1)}×
              </div>
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

export function DayForensics({
  strategy,
  day,
  sha,
  stale,
  onClose,
  fallback,
}: {
  strategy: string;
  day: string;
  sha: string | undefined;
  stale?: boolean;
  onClose?: () => void;
  /** Shown under the error when the replay fails (e.g. the day's option data was moved). */
  fallback?: ReactNode;
}) {
  const res = useDayForensics(strategy, day, sha, DEFAULT_CUTS);
  const f = res.data;

  if (res.error && !f) {
    return (
      <div className="space-y-3">
        <StateMessage variant="error" title="Couldn't replay this day" description={res.error} />
        {fallback}
      </div>
    );
  }
  if (!f) return <p className="text-sm text-muted">Replaying {day}…</p>;

  return (
    <Card>
      <CardHeader
        title={`${f.strategy_id} · ${f.day}`}
        description={[
          `net ${formatPnl(f.net)}${f.lots > 1 ? ` (${formatPnl(f.net_per_lot)} per lot)` : ''}`,
          `worst MTM ${formatPnl(f.worst_mtm)}`,
          `best MTM ${formatPnl(f.best_mtm)}`,
          f.stopped_by,
          stale ? 'replayed with the older version that produced this result' : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-muted hover:text-foreground"
            >
              Close
            </button>
          ) : null
        }
      />
      <div className="space-y-5">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">
            MTM (right, ₹) vs {f.underlying} (left) · {f.window.start}–{f.window.end}
          </p>
          <MtmChart f={f} />
        </div>
        <Anatomy f={f} />
        {f.legs.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">
              Option premiums while held
            </p>
            <PremiumChart f={f} />
          </div>
        )}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">By leg</p>
          <Table>
            <THead>
              <Th>Leg</Th>
              <Th align="right">Trades</Th>
              <Th align="right">SL hits</Th>
              <Th align="right">Targets</Th>
              <Th align="right">Re-entries</Th>
              <Th align="right">Gross</Th>
              <Th align="right">Costs</Th>
              <Th align="right">Net</Th>
            </THead>
            <tbody>
              {f.attribution.map((a) => (
                <TRow key={a.leg}>
                  <Td>{a.leg}</Td>
                  <Td align="right" numeric>
                    {a.trades}
                  </Td>
                  <Td align="right" numeric>
                    {a.sl_hits}
                  </Td>
                  <Td align="right" numeric>
                    {a.target_hits}
                  </Td>
                  <Td align="right" numeric>
                    {a.reentries}
                  </Td>
                  <Td align="right" numeric className={pnlClass(a.gross)}>
                    {formatPnl(a.gross)}
                  </Td>
                  <Td align="right" numeric>
                    {formatPnl(-a.costs)}
                  </Td>
                  <Td align="right" numeric className={pnlClass(a.net)}>
                    {formatPnl(a.net)}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        </div>
        <TradeLog trades={f.trades} />
        {f.notes.map((n) => (
          <p key={n} className="text-xs text-muted">
            note: {n}
          </p>
        ))}
      </div>
    </Card>
  );
}
