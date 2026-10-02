/**
 * Day ₹/lot against how much the market moved relative to VIX (x = range ÷ VIX-implied
 * expected range; 1.0 = realised matched implied). A premium seller's days should sit
 * left of the line, a directional buyer's right — this is the picture that tells them apart.
 */

import { useEffect, useRef } from 'react';

import { getChartTheme } from '../../lib/chartTheme';
import type { ScatterPoint } from '../../lib/legwiseJoin';
import { loadPlotly } from '../../lib/plotly';
import { useThemeStore } from '../../store/theme';
import { SERIES_COLORS } from './shared';

export interface ScatterSeries {
  id: string;
  points: ScatterPoint[];
}

export function PnlScatter({ series }: { series: ScatterSeries[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let mounted = true;
    let purge: (() => void) | null = null;
    let observer: ResizeObserver | null = null;

    (async () => {
      const plotly = await loadPlotly();
      if (!mounted) return;
      const t = getChartTheme(theme);
      const traces = series.map((s, i) => ({
        x: s.points.map((p) => p.x),
        y: s.points.map((p) => p.y),
        text: s.points.map((p) => p.day),
        name: s.id,
        type: 'scatter',
        mode: 'markers',
        marker: { size: 9, color: SERIES_COLORS[i % SERIES_COLORS.length], opacity: 0.8 },
        hovertemplate:
          '%{text}<br>range ÷ implied %{x:.2f}<br>₹ %{y:,.0f} per lot<extra>%{fullData.name}</extra>',
      }));
      const axis = { gridcolor: t.grid, zerolinecolor: t.border, color: t.text };
      await plotly.react(
        el,
        traces,
        {
          height: 320,
          margin: { l: 64, r: 16, t: 8, b: 48 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          font: { color: t.text, size: 11 },
          xaxis: {
            ...axis,
            title: { text: 'market range ÷ VIX-implied range  (1.0 = realised matched implied)' },
          },
          yaxis: { ...axis, title: { text: '₹ per lot' } },
          legend: { orientation: 'h', y: -0.28 },
          shapes: [
            {
              type: 'line',
              x0: 1,
              x1: 1,
              yref: 'paper',
              y0: 0,
              y1: 1,
              line: { color: t.border, dash: 'dot' },
            },
          ],
        },
        { displayModeBar: false, responsive: true },
      );
      observer = new ResizeObserver(() => plotly.Plots.resize(el));
      observer.observe(el);
      purge = () => plotly.purge(el);
    })();

    return () => {
      mounted = false;
      observer?.disconnect();
      purge?.();
    };
  }, [series, theme]);

  return <div ref={ref} className="w-full" style={{ minHeight: 320 }} />;
}
