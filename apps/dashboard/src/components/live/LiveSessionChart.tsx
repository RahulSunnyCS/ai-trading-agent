/**
 * A Lightweight Charts line chart for the Live page: one or more lines on a time axis that always
 * covers the whole session (an invisible series with a point at every minute of the day), so a
 * half-played day shows how far along it is. Several charts stacked on the page share those
 * minutes and the same price-axis width, so their time axes line up.
 * Colours come from lib/chartTheme.ts and follow the theme; time reads in IST whatever the browser's
 * zone. A gap in a series is a gap in the line (the points are simply not there).
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, Time, UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef } from 'react';

import { getChartTheme, getSeriesPalette, pickSeries } from '../../lib/chartTheme';
import { cn } from '../../lib/cn';
import { formatIstTime, formatNumber } from '../../lib/format';
import type { ChartPoint } from '../../lib/liveSession';
import { useThemeStore } from '../../store/theme';

export interface ChartLine {
  id: string;
  /** Index into the chart series palette (identity only, never profit or loss). */
  palette: number;
  points: readonly ChartPoint[];
}

/** The price axis is this wide on every chart, so stacked charts share one plot width. */
const AXIS_WIDTH = 76;

function istLabel(time: Time, seconds: boolean): string {
  return typeof time === 'number' ? formatIstTime(time * 1000, { seconds }) : '';
}

export function LiveSessionChart({
  lines,
  height,
  minutes,
  timeAxis = true,
  ariaLabel,
  className,
}: {
  lines: readonly ChartLine[];
  height: number;
  /** Epoch seconds of every minute of the session: the time axis runs over exactly these. */
  minutes: readonly number[];
  /** Show the time labels under the plot (off for the upper charts of a stack). */
  timeAxis?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const gridRef = useRef<ISeriesApi<'Line'> | null>(null);
  const theme = useThemeStore((s) => s.theme);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the chart is built once per mount; height and the time axis are fixed per use
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const chart = createChart(el, {
      layout: { background: { color: 'transparent' } },
      rightPriceScale: { borderVisible: false, minimumWidth: AXIS_WIDTH },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        visible: timeAxis,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (time: Time) => istLabel(time, false),
      },
      localization: {
        timeFormatter: (time: Time) => istLabel(time, false),
        priceFormatter: (price: number) => formatNumber(price, 2),
      },
      handleScale: false,
      handleScroll: false,
      width: el.clientWidth,
      height,
    });
    chartRef.current = chart;
    // The time axis comes from this series: a point at every minute of the day. It has real
    // values (a whitespace-only series does not extend the time scale) on a price scale of its
    // own, hidden, so it never moves the axis the visible lines use.
    gridRef.current = chart.addLineSeries({
      color: 'transparent',
      priceScaleId: 'session-grid',
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    chart.priceScale('session-grid').applyOptions({ visible: false });
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      chart.applyOptions({ width: entry.contentRect.width });
      chart.timeScale().fitContent();
    });
    ro.observe(el);
    const series = seriesRef.current;
    return () => {
      ro.disconnect();
      series.clear();
      gridRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  // Theme colours (mount, on a theme flip, and when a line is added).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lines` only matters through its ids and palette slots
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const t = getChartTheme(theme);
    chart.applyOptions({
      layout: { background: { color: 'transparent' }, textColor: t.text, fontFamily: t.fontFamily },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    });
    const palette = getSeriesPalette(theme);
    for (const line of lines) {
      seriesRef.current.get(line.id)?.applyOptions({ color: pickSeries(palette, line.palette) });
    }
  }, [theme, lines.map((l) => `${l.id}:${l.palette}`).join('|')]);

  // Data: create a series the first time a line appears, drop one that is gone, then set points.
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const palette = getSeriesPalette(theme);
    const wanted = new Set(lines.map((l) => l.id));
    for (const [id, series] of seriesRef.current) {
      if (!wanted.has(id)) {
        chart.removeSeries(series);
        seriesRef.current.delete(id);
      }
    }
    for (const line of lines) {
      let series = seriesRef.current.get(line.id);
      if (series === undefined) {
        series = chart.addLineSeries({
          color: pickSeries(palette, line.palette),
          lineWidth: 2,
          lastPriceAnimation: 0,
          priceLineVisible: false,
          lastValueVisible: true,
        });
        seriesRef.current.set(line.id, series);
      }
      series.setData(line.points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }
    gridRef.current?.setData(minutes.map((time) => ({ time: time as UTCTimestamp, value: 0 })));
    chart.timeScale().fitContent();
    // The chart folds new points into its time scale on its next frame; fit once more then.
    const frame = requestAnimationFrame(() => chartRef.current?.timeScale().fitContent());
    return () => cancelAnimationFrame(frame);
  }, [lines, minutes, theme]);

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
