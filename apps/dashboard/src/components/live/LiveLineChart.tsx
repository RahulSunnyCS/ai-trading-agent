/**
 * A small Lightweight Charts line for the Live tab: the index ticks (with a time axis) and the
 * straddle sparkline (without). Colours come from lib/chartTheme.ts and follow the theme; the
 * axis and crosshair read in IST, whatever the browser's time zone.
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, Time, UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef } from 'react';

import { getChartTheme, getSeriesPalette, pickSeries } from '../../lib/chartTheme';
import { cn } from '../../lib/cn';
import { formatIstTime, formatNumber } from '../../lib/format';
import { type SeriesPoint, toChartSeries } from '../../lib/live';
import { useThemeStore } from '../../store/theme';

/** Lightweight Charts hands back the UTCTimestamp (seconds) we gave it. */
function istLabel(time: Time, seconds: boolean): string {
  return typeof time === 'number' ? formatIstTime(time * 1000, { seconds }) : '';
}

export function LiveLineChart({
  points,
  height,
  series = 0,
  axes = true,
  ariaLabel,
  className,
}: {
  points: readonly SeriesPoint[];
  height: number;
  /** Index into the chart series palette. */
  series?: number;
  /** Show the price and time axes and the grid; off for a sparkline. */
  axes?: boolean;
  /** What the chart shows, for screen readers. */
  ariaLabel: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const theme = useThemeStore((s) => s.theme);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the chart is built once per mount; height/axes are fixed per use
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    const chart = createChart(el, {
      layout: { background: { color: 'transparent' } },
      rightPriceScale: { borderVisible: false, visible: axes },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        visible: axes,
        tickMarkFormatter: (time: Time) => istLabel(time, false),
      },
      localization: {
        timeFormatter: (time: Time) => istLabel(time, true),
        priceFormatter: (price: number) => formatNumber(price, 2),
      },
      crosshair: axes ? {} : { vertLine: { visible: false }, horzLine: { visible: false } },
      handleScale: false,
      handleScroll: false,
      width: el.clientWidth,
      height,
    });
    const line = chart.addLineSeries({
      lineWidth: 2,
      lastPriceAnimation: 0,
      priceLineVisible: false,
      lastValueVisible: axes,
      crosshairMarkerVisible: axes,
    });
    chartRef.current = chart;
    seriesRef.current = line;

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

  // Theme colours (mount + on flip).
  useEffect(() => {
    const chart = chartRef.current;
    const line = seriesRef.current;
    if (chart === null || line === null) return;
    const t = getChartTheme(theme);
    chart.applyOptions({
      layout: { background: { color: 'transparent' }, textColor: t.text, fontFamily: t.fontFamily },
      grid: {
        vertLines: { color: t.grid, visible: axes },
        horzLines: { color: t.grid, visible: axes },
      },
    });
    line.applyOptions({ color: pickSeries(getSeriesPalette(theme), series) });
  }, [theme, series, axes]);

  useEffect(() => {
    const line = seriesRef.current;
    if (line === null) return;
    line.setData(
      toChartSeries(points).map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
    );
    if (axes) chartRef.current?.timeScale().scrollToRealTime();
    else chartRef.current?.timeScale().fitContent();
  }, [points, axes]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel}
      className={cn('w-full', className)}
      style={{ height }}
    />
  );
}
