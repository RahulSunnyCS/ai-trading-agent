'use client';

/**
 * The F&O hero chart: the year's running net (to date) with the benchmark's line (the target pace,
 * or last FY on the same calendar days), on Lightweight Charts with the chart theme's colours.
 * The drawdown pane and the daily bars are off by default behind toggles. A follow tooltip sits
 * below the cursor (`tooltipPlacement`); a click opens that day in the drawer.
 */

import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType, Time } from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useChart } from '../../hooks/useChart';
import { getChartTheme, getSeriesPalette, pickSeries, withAlpha } from '../../lib/chartTheme';
import { cn } from '../../lib/cn';
import { formatDay, formatInr } from '../../lib/format';
import { tooltipPlacement } from '../../lib/momentumResult';
import type { BookPoint } from '../../lib/tradeBookView';
import { Inr, Toggle } from './parts';

export interface HeroLine {
  day: string;
  value: number;
}

const HEIGHT = 420;

/** A chart time back to "YYYY-MM-DD" (Lightweight Charts hands a business day back as an object). */
function dayOf(time: Time | undefined): string | null {
  if (time === undefined) return null;
  if (typeof time === 'string') return time;
  if (typeof time === 'number') return new Date(time * 1000).toISOString().slice(0, 10);
  return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}

export function TradeBookHero({
  points,
  bench,
  benchLabel,
  onPickDay,
  onPainted,
}: {
  points: BookPoint[];
  bench: HeroLine[];
  benchLabel: string | null;
  onPickDay: (day: string) => void;
  onPainted?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const { chartRef, ready, theme } = useChart(box, false, HEIGHT);
  const [showDrawdown, setShowDrawdown] = useState(false);
  const [showBars, setShowBars] = useState(false);
  const [hover, setHover] = useState<{ day: string; x: number; y: number } | null>(null);
  const series = useRef<ISeriesApi<SeriesType>[]>([]);
  const pick = useRef(onPickDay);
  pick.current = onPickDay;
  const painted = useRef(onPainted);
  painted.current = onPainted;

  const byDay = useMemo(() => new Map(points.map((p) => [p.day, p])), [points]);
  const benchByDay = useMemo(() => new Map(bench.map((b) => [b.day, b.value])), [bench]);

  // Draw (and redraw on data, theme or toggle changes only).
  useEffect(() => {
    const chart: IChartApi | null = chartRef.current;
    if (!ready || chart === null) return;
    for (const s of series.current) chart.removeSeries(s);
    series.current = [];
    const t = getChartTheme(theme);
    const palette = getSeriesPalette(theme);
    const main = pickSeries(palette, 0);
    const lower = showDrawdown || showBars;
    chart.applyOptions({
      rightPriceScale: { scaleMargins: { top: 0.06, bottom: lower ? 0.3 : 0.06 } },
      crosshair: { horzLine: { visible: false, labelVisible: false } },
      localization: { priceFormatter: (v: number) => formatInr(v, { compact: true }) },
    });
    const area = chart.addAreaSeries({
      lineColor: main,
      topColor: withAlpha(main, 0.18),
      bottomColor: withAlpha(main, 0.02),
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    area.setData(points.map((p) => ({ time: p.day as Time, value: p.toDate })));
    series.current.push(area);
    if (bench.length) {
      const line = chart.addLineSeries({
        color: benchLabel?.startsWith('Last') ? pickSeries(palette, 1) : t.text,
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(bench.map((b) => ({ time: b.day as Time, value: b.value })));
      series.current.push(line);
    }
    if (showDrawdown) {
      // A baseline at zero fills the space between the peak and the curve: the drawdown itself.
      const dd = chart.addBaselineSeries({
        priceScaleId: 'drawdown',
        baseValue: { type: 'price', price: 0 },
        topLineColor: t.negative,
        topFillColor1: withAlpha(t.negative, 0),
        topFillColor2: withAlpha(t.negative, 0),
        bottomLineColor: t.negative,
        bottomFillColor1: withAlpha(t.negative, 0.1),
        bottomFillColor2: withAlpha(t.negative, 0.35),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      chart.priceScale('drawdown').applyOptions({
        scaleMargins: { top: showBars ? 0.72 : 0.74, bottom: showBars ? 0.14 : 0 },
      });
      dd.setData(points.map((p) => ({ time: p.day as Time, value: p.drawdown })));
      series.current.push(dd);
    }
    if (showBars) {
      const bars = chart.addHistogramSeries({
        priceScaleId: 'bars',
        priceLineVisible: false,
        lastValueVisible: false,
      });
      chart.priceScale('bars').applyOptions({
        scaleMargins: { top: showDrawdown ? 0.88 : 0.74, bottom: 0 },
      });
      bars.setData(
        points.map((p) =>
          p.profit === null
            ? { time: p.day as Time }
            : {
                time: p.day as Time,
                value: p.profit,
                color: withAlpha(p.profit >= 0 ? t.positive : t.negative, 0.7),
              },
        ),
      );
      series.current.push(bars);
    }
    chart.timeScale().fitContent();
    const frame = requestAnimationFrame(() => painted.current?.());
    return () => cancelAnimationFrame(frame);
  }, [chartRef, ready, theme, points, bench, benchLabel, showDrawdown, showBars]);

  // The follow tooltip and the click-through to the day.
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || chart === null) return;
    let frame: number | null = null;
    const onMove = (param: MouseEventParams) => {
      const day = dayOf(param.time);
      const point = param.point;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        setHover(day && point ? { day, x: point.x, y: point.y } : null);
      });
    };
    const onClick = (param: MouseEventParams) => {
      const day = dayOf(param.time);
      if (day) pick.current(day);
    };
    chart.subscribeCrosshairMove(onMove);
    chart.subscribeClick(onClick);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      chart.unsubscribeCrosshairMove(onMove);
      chart.unsubscribeClick(onClick);
    };
  }, [chartRef, ready]);

  const point = hover ? byDay.get(hover.day) : undefined;
  const benchValue = hover ? benchByDay.get(hover.day) : undefined;
  const placement = (() => {
    const r = box.current?.getBoundingClientRect();
    if (!hover || !r) return null;
    const t = tip.current?.getBoundingClientRect();
    return tooltipPlacement(
      { x: hover.x, y: hover.y },
      { width: t?.width ?? 220, height: t?.height ?? 80 },
      { left: 0, top: 0, right: r.width, bottom: r.height },
    );
  })();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-series-1" />
          Net to date
        </span>
        {benchLabel ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                'w-3 border-t-2 border-dashed',
                // The line: series 2 for last FY, the chart theme's text colour (--muted) for a pace.
                benchLabel.startsWith('Last') ? 'border-series-2' : 'border-muted',
              )}
            />
            {benchLabel}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <Toggle on={showDrawdown} onChange={setShowDrawdown}>
            Drawdown pane
          </Toggle>
          <Toggle on={showBars} onChange={setShowBars}>
            Daily bars
          </Toggle>
        </span>
      </div>
      <div
        className="relative"
        role="img"
        aria-label="Net to date over the year, with the benchmark line; click a day to open it"
        onMouseLeave={() => setHover(null)}
      >
        <div ref={box} className="w-full" style={{ height: HEIGHT }} />
        {hover && point && placement ? (
          <div
            ref={tip}
            style={{ left: placement.left, top: placement.top }}
            className="pointer-events-none absolute z-10 w-56 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-xs shadow-elevated"
          >
            <p className="font-mono font-medium text-foreground">
              {formatDay(point.day, { weekday: true })}
            </p>
            <p className="mt-0.5 text-muted">
              Day{' '}
              {point.profit === null ? (
                <span className="text-faint">no note</span>
              ) : (
                <Inr value={point.profit} className="metric" />
              )}{' '}
              · to date <span className="metric text-foreground">{formatInr(point.toDate)}</span>
            </p>
            <p className="text-faint">
              Drawdown <span className="metric">{formatInr(point.drawdown)}</span>
              {benchValue !== undefined ? (
                <>
                  {' '}
                  · {benchLabel?.startsWith('Last') ? 'last FY' : 'target'}{' '}
                  <span className="metric">{formatInr(benchValue)}</span>
                </>
              ) : null}
            </p>
            <p className="text-faint">click for the day</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
