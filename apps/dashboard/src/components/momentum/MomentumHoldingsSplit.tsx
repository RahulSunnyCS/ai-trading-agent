'use client';

import { useEffect, useRef } from 'react';

import {
  getChartTheme,
  getSeriesPalette,
  pickSeries,
  plotlyChrome,
  withAlpha,
} from '../../lib/chartTheme';
import { useThemeStore } from '../../store/theme';
import { ResultSection } from './ResultSection';

type PlotlyBasic = typeof import('plotly.js-basic-dist-min').default;

/** Donut of the current portfolio — what's held right now, as a share of the total. */
export function MomentumHoldingsSplit({
  positions,
}: { positions: Array<Record<string, unknown>> }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((state) => state.theme);
  const rows = positions.filter((row) => typeof row.value === 'number' && row.value > 0);

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
      // Identity colours only: the series palette at three strengths gives twelve distinct
      // slices without borrowing the profit/loss colours.
      const series = getSeriesPalette(theme);
      const palette = [1, 0.6, 0.35].flatMap((alpha) =>
        series.map((color) => (alpha === 1 ? color : withAlpha(color, alpha))),
      );
      const sorted = [...rows].sort((a, b) => Number(b.value) - Number(a.value));
      const trace: Record<string, unknown> = {
        type: 'pie',
        hole: 0.6,
        labels: sorted.map((row) => String(row.asset)),
        values: sorted.map((row) => Number(row.value)),
        textinfo: 'label+percent',
        textposition: 'outside',
        automargin: true,
        marker: { colors: sorted.map((_, i) => pickSeries(palette, i)) },
        hovertemplate: '%{label}: %{percent} of portfolio<extra></extra>',
      };
      const layout: Record<string, unknown> = {
        height: 320,
        margin: { l: 10, r: 10, t: 10, b: 10 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        ...plotlyChrome(colors, 11),
        showlegend: false,
      };
      await plotly.react(element, [trace], layout, {
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
  }, [rows, theme]);

  return (
    <ResultSection
      title="Current holdings"
      description="As of the latest week in this run"
      padded={false}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing held as of the latest week.</p>
      ) : (
        <div ref={ref} className="w-full" />
      )}
    </ResultSection>
  );
}
