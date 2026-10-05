'use client';

import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { type RefObject, useEffect, useRef } from 'react';

import { getChartTheme } from '../../lib/chartTheme';
import { formatInr } from '../../lib/format';
import type { DailyPnlPoint, PnlSeriesPoint } from '../../lib/pnl';
import { useThemeStore } from '../../store/theme';

/**
 * One Lightweight Charts instance with a single series, created on mount, resized with its
 * container and recoloured from the theme tokens (lib/chartTheme) when the theme flips.
 */
function useSingleSeriesChart<T extends SeriesType>(
  height: number,
  addSeries: (chart: IChartApi) => ISeriesApi<T>,
): {
  containerRef: RefObject<HTMLDivElement>;
  chartRef: RefObject<IChartApi | null>;
  seriesRef: RefObject<ISeriesApi<T> | null>;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<T> | null>(null);
  const addSeriesRef = useRef(addSeries);
  const themeName = useThemeStore((s) => s.theme);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: { background: { color: 'transparent' } },
      grid: { vertLines: { color: 'transparent' }, horzLines: { color: 'transparent' } },
      timeScale: { rightOffset: 2 },
      // Axis and crosshair labels in rupees with en-IN grouping, like every other money figure.
      localization: { priceFormatter: (price: number) => formatInr(price) },
    });
    chartRef.current = chart;
    seriesRef.current = addSeriesRef.current(chart);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) chart.applyOptions({ width: entry.contentRect.width });
    });
    observer.observe(container);
    return () => {
      seriesRef.current = null;
      chartRef.current = null;
      observer.disconnect();
      chart.remove();
    };
  }, [height]);

  // The chart chrome follows the theme here; series colours are set by the callers.
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const t = getChartTheme(themeName);
    chart.applyOptions({
      layout: { background: { color: 'transparent' }, textColor: t.text, fontFamily: t.fontFamily },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
  }, [themeName]);

  return { containerRef, chartRef, seriesRef };
}

/**
 * Cumulative realized P&L, one point per IST day. The line is green while the latest cumulative
 * value is ≥ 0 and red once it is below zero, so the colour says where the account stands now.
 */
export function CumulativePnlChart({ series }: { series: PnlSeriesPoint[] }) {
  const themeName = useThemeStore((s) => s.theme);
  const { containerRef, chartRef, seriesRef } = useSingleSeriesChart(220, (chart) =>
    chart.addLineSeries({ lineWidth: 2, priceLineVisible: true, lastValueVisible: true }),
  );
  const latest = series[series.length - 1]?.value ?? 0;
  const negative = latest < 0;

  useEffect(() => {
    const t = getChartTheme(themeName);
    seriesRef.current?.applyOptions({ color: negative ? t.negative : t.positive });
  }, [themeName, negative, seriesRef]);

  useEffect(() => {
    const line = seriesRef.current;
    if (line === null) return;
    line.setData(series);
    if (series.length > 0) chartRef.current?.timeScale().fitContent();
  }, [series, seriesRef, chartRef]);

  return (
    <div
      ref={containerRef}
      className="w-full"
      style={{ minHeight: 220 }}
      role="img"
      aria-label={`Cumulative realized P&L chart, ${negative ? 'below' : 'at or above'} zero at the latest day`}
    />
  );
}

/** Net P&L per IST exit day as a histogram, each bar green for a gain and red for a loss. */
export function DailyPnlChart({ daily }: { daily: DailyPnlPoint[] }) {
  const themeName = useThemeStore((s) => s.theme);
  const { containerRef, chartRef, seriesRef } = useSingleSeriesChart(160, (chart) =>
    chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }),
  );

  useEffect(() => {
    const bars = seriesRef.current;
    if (bars === null) return;
    const t = getChartTheme(themeName);
    bars.setData(
      daily.map((point) => ({
        time: point.time,
        value: point.value,
        color: point.value < 0 ? t.negative : t.positive,
      })),
    );
    if (daily.length > 0) chartRef.current?.timeScale().fitContent();
  }, [daily, themeName, seriesRef, chartRef]);

  return (
    <div
      ref={containerRef}
      className="w-full"
      style={{ minHeight: 160 }}
      role="img"
      aria-label="Daily net P&L bars, one per IST day"
    />
  );
}
