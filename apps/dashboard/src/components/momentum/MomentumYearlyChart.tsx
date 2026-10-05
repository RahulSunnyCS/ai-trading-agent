'use client';

import { useEffect, useRef } from 'react';

import { getChartTheme, plotlyChrome } from '../../lib/chartTheme';
import { useThemeStore } from '../../store/theme';

type PlotlyBasic = typeof import('plotly.js-basic-dist-min').default;

/** Year-by-year strategy vs benchmark, bars coloured by whether that year beat it. */
export function MomentumYearlyChart({
  rows,
  benchmarkName,
}: { rows: Array<Record<string, unknown>>; benchmarkName: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((state) => state.theme);

  useEffect(() => {
    const element = ref.current;
    if (!element || rows.length === 0) return;
    let mounted = true;
    let plotly: PlotlyBasic | null = null;

    async function render(): Promise<void> {
      const loaded = await import('plotly.js-basic-dist-min');
      if (!mounted || !element) return;
      plotly = loaded.default;
      const colors = getChartTheme(theme);
      const years = rows.map((row) => String(row.year));
      const strategy = rows.map((row) =>
        typeof row.strategy === 'number' ? row.strategy * 100 : null,
      );
      const benchmark = rows.map((row) =>
        typeof row.benchmark === 'number' ? row.benchmark * 100 : null,
      );
      const traces: Array<Record<string, unknown>> = [
        {
          x: years,
          y: strategy,
          name: 'Strategy',
          type: 'bar',
          marker: {
            color: rows.map((row) =>
              typeof row.vs_benchmark === 'number' && row.vs_benchmark >= 0
                ? colors.positive
                : colors.negative,
            ),
          },
          hovertemplate: 'Strategy %{y:.1f}%<extra></extra>',
        },
        {
          x: years,
          y: benchmark,
          name: benchmarkName,
          type: 'bar',
          marker: { color: colors.border },
          hovertemplate: `${benchmarkName} %{y:.1f}%<extra></extra>`,
        },
      ];
      const layout: Record<string, unknown> = {
        height: 280,
        margin: { l: 50, r: 18, t: 10, b: 30 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        ...plotlyChrome(colors),
        barmode: 'group',
        bargap: 0.25,
        legend: { orientation: 'h', y: 1.1, x: 0 },
        xaxis: { gridcolor: colors.grid },
        yaxis: { gridcolor: colors.grid, ticksuffix: '%', zerolinecolor: colors.grid },
      };
      await plotly.react(element, traces, layout, {
        responsive: true,
        displaylogo: false,
        displayModeBar: false,
      });
    }

    void render();
    return () => {
      mounted = false;
      if (plotly && element) plotly.purge(element);
    };
  }, [rows, benchmarkName, theme]);

  if (rows.length === 0) return null;
  return <div ref={ref} className="w-full" />;
}
