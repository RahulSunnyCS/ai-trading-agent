/**
 * A share-of-days chart: one line per series on a fixed 0–100 % axis, with a dashed 50 %
 * baseline. Hovering (or tapping) a date shows each line's value in the readout under the
 * chart; with nothing hovered the readout shows the latest value.
 */

import { LineStyle, createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, MouseEventParams } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';

import {
  getChartTheme,
  getSeriesPalette,
  pickSeries,
  seriesCssColor,
} from '../../../lib/chartTheme';
import { formatDay, formatPct } from '../../../lib/format';
import { useThemeStore } from '../../../store/theme';

export interface ShareLine {
  id: string;
  /** `value` is a share in percent units, 0..100. */
  points: { time: string; value: number }[];
}

const HEIGHT = 260;
const percent = (value: number) => formatPct(value, 0, { unit: 'percent' });

/** Lightweight Charts hands back the time as given ('YYYY-MM-DD') or as a business day. */
function dayOf(time: MouseEventParams['time']): string | null {
  if (typeof time === 'string') return time;
  if (time && typeof time === 'object' && 'year' in time) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${time.year}-${pad(time.month)}-${pad(time.day)}`;
  }
  return null;
}

interface Hover {
  day: string;
  values: (number | null)[];
}

export function ShareChart({
  lines,
  baseline = 50,
  ariaLabel,
}: {
  lines: ShareLine[];
  /** Where the dashed reference line sits, in percent. */
  baseline?: number;
  ariaLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const theme = useThemeStore((s) => s.theme);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: HEIGHT,
      layout: { background: { color: 'transparent' } },
      timeScale: { rightOffset: 1 },
      localization: { priceFormatter: percent },
      rightPriceScale: { scaleMargins: { top: 0.06, bottom: 0.06 } },
    });
    chartRef.current = chart;
    const onMove = (param: MouseEventParams) => {
      const day = dayOf(param.time);
      if (day === null) {
        setHover(null);
        return;
      }
      setHover({
        day,
        values: seriesRef.current.map((s) => {
          const point = param.seriesData.get(s);
          return point && 'value' in point ? point.value : null;
        }),
      });
    };
    chart.subscribeCrosshairMove(onMove);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) chart.applyOptions({ width: entry.contentRect.width });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(onMove);
      seriesRef.current = [];
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const t = getChartTheme(theme);
    chart.applyOptions({
      layout: { background: { color: 'transparent' }, textColor: t.text, fontFamily: t.fontFamily },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
  }, [theme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    const t = getChartTheme(theme);
    const palette = getSeriesPalette(theme);
    seriesRef.current = lines.map((line, i) => {
      const series = chart.addLineSeries({
        color: pickSeries(palette, i),
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: { type: 'custom', minMove: 1, formatter: percent },
        // Pin the axis to the whole 0–100 % range, so the baseline never moves.
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      });
      series.setData(line.points);
      if (i === 0) {
        series.createPriceLine({
          price: baseline,
          color: t.text,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '',
        });
      }
      return series;
    });
    chart.timeScale().fitContent();
    setHover(null);
  }, [lines, theme, baseline]);

  const empty = lines.every((line) => line.points.length === 0);
  const lastDay = lines
    .map((line) => line.points[line.points.length - 1]?.time)
    .filter((time): time is string => time !== undefined)
    .sort()
    .pop();

  return (
    <div>
      <div
        ref={containerRef}
        role="img"
        aria-label={ariaLabel}
        className="w-full"
        style={{ minHeight: HEIGHT }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="font-mono tabular-nums text-faint">
          {empty ? 'No points yet' : formatDay(hover?.day ?? lastDay)}
        </span>
        {lines.map((line, i) => {
          const value = hover
            ? (hover.values[i] ?? null)
            : (line.points[line.points.length - 1]?.value ?? null);
          return (
            <span key={line.id} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-4 rounded-full"
                style={{ backgroundColor: seriesCssColor(i) }}
              />
              {line.id}
              <span className="font-mono tabular-nums text-foreground">
                {formatPct(value, 0, { unit: 'percent' })}
              </span>
            </span>
          );
        })}
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block w-4 border-t border-dashed border-muted"
          />
          {percent(baseline)} baseline
        </span>
      </div>
    </div>
  );
}
