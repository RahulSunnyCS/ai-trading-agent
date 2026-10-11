/**
 * useChart: create, resize and theme one Lightweight chart for a container element. Shared by the
 * Options Lab's day forensics and the Rotation page's portfolio-stop replay, so neither imports
 * the other's component file.
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi } from 'lightweight-charts';
import { type RefObject, useEffect, useRef, useState } from 'react';

import { getChartTheme } from '../lib/chartTheme';
import { useThemeStore } from '../store/theme';

export const CHART_HEIGHT = 300;

/** Create/resize/theme a Lightweight chart; returns a ref to the live chart. */
export function useChart(container: RefObject<HTMLDivElement>, withLeftScale: boolean) {
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
