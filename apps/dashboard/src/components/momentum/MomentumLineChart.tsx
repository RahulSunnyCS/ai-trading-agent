'use client';

import { useEffect, useRef } from 'react';

import { getChartTheme, plotlyChrome, withAlpha } from '../../lib/chartTheme';
import { type PlotlyBasic, loadPlotly } from '../../lib/plotly';
import { useThemeStore } from '../../store/theme';

/** A line's colour, by meaning: the strategy, the benchmark, or a loss. */
export type LineRole = 'strategy' | 'benchmark' | 'negative';

export interface ChartLine {
  name: string;
  values: ReadonlyArray<number | null>;
  role: LineRole;
  dash?: 'solid' | 'dot';
  /** Shade between the line and zero (an underwater curve). */
  fill?: boolean;
  /** Extra hover lines per date (same length as `dates`; '' for none), shown under the value. */
  hover?: ReadonlyArray<string>;
}

/** Plotly hover text is HTML: escape it, and turn newlines into line breaks. */
function hoverHtml(text: string): string {
  if (!text) return '';
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<br>${safe.replace(/\n/g, '<br>')}`;
}

/**
 * A small time-series chart for a widget below the hero chart: a few lines over the run's
 * weeks, values as fractions shown in percent, hover reading all lines at once.
 */
export function MomentumLineChart({
  dates,
  lines,
  height = 220,
  label,
}: {
  dates: ReadonlyArray<string>;
  lines: ChartLine[];
  height?: number;
  /** What the chart shows, for screen readers. */
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((state) => state.theme);

  useEffect(() => {
    const element = ref.current;
    if (!element || dates.length === 0) return;
    let mounted = true;
    let plotly: PlotlyBasic | null = null;

    async function render(): Promise<void> {
      const loaded = await loadPlotly();
      if (!mounted || !element) return;
      plotly = loaded;
      const colors = getChartTheme(theme);
      const colour = {
        strategy: colors.primary,
        benchmark: colors.foreground,
        negative: colors.negative,
      };
      const traces = lines.map((line) => ({
        x: dates,
        y: line.values,
        name: line.name,
        type: 'scatter',
        mode: 'lines',
        line: {
          color: colour[line.role],
          width: line.role === 'strategy' ? 1.8 : 1.2,
          dash: line.dash ?? 'solid',
        },
        ...(line.fill ? { fill: 'tozeroy', fillcolor: withAlpha(colour[line.role], 0.18) } : {}),
        ...(line.hover
          ? {
              customdata: line.hover.map(hoverHtml),
              hovertemplate: `${line.name} %{y:.1%}%{customdata}<extra></extra>`,
            }
          : { hovertemplate: `${line.name} %{y:.1%}<extra></extra>` }),
      }));
      await plotly.react(
        element,
        traces,
        {
          height,
          margin: { l: 46, r: 10, t: 6, b: 26 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          ...plotlyChrome(colors),
          showlegend: false,
          hovermode: 'x unified',
          xaxis: { type: 'date', gridcolor: colors.grid, hoverformat: '%d %b %Y' },
          yaxis: { gridcolor: colors.grid, tickformat: '.0%', zerolinecolor: colors.border },
        },
        { responsive: true, displaylogo: false, displayModeBar: false, staticPlot: false },
      );
    }

    void render();
    return () => {
      mounted = false;
      if (plotly && element) plotly.purge(element);
    };
  }, [dates, lines, height, theme]);

  return <div ref={ref} role="img" aria-label={label} className="w-full" style={{ height }} />;
}
