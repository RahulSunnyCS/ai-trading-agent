'use client';

import { useEffect, useMemo, useRef } from 'react';

import { getChartTheme } from '../../lib/chartTheme';
import { useThemeStore } from '../../store/theme';
import { Card, CardHeader } from '../ui/Card';

type PlotlyBasic = typeof import('plotly.js-basic-dist-min').default;

/** One row per instrument, time left to right — a Gantt of every closed and open position. */
export function MomentumTimelineChart({ rows }: { rows: Array<Record<string, unknown>> }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((state) => state.theme);

  const assetOrder = useMemo(() => {
    const firstSeen = new Map<string, string>();
    for (const row of rows) {
      const asset = String(row.asset);
      const start = String(row.start);
      const known = firstSeen.get(asset);
      if (known === undefined || start < known) firstSeen.set(asset, start);
    }
    return [...firstSeen.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([asset]) => asset);
  }, [rows]);

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
      const durationsMs = rows.map((row) => {
        const start = new Date(String(row.start)).getTime();
        const end = new Date(String(row.end)).getTime();
        return Math.max(end - start, 86_400_000 * 3);
      });
      const trace: Record<string, unknown> = {
        type: 'bar',
        orientation: 'h',
        y: rows.map((row) => String(row.asset)),
        x: durationsMs,
        base: rows.map((row) => String(row.start)),
        marker: {
          color: rows.map((row) => {
            const open = Boolean(row.open);
            const ret = typeof row.return === 'number' ? row.return : 0;
            if (open) return colors.primary;
            return ret >= 0 ? colors.positive : colors.negative;
          }),
        },
        customdata: rows.map((row) => [
          String(row.start).slice(0, 10),
          String(row.end).slice(0, 10),
          typeof row.return === 'number' ? `${(row.return * 100).toFixed(1)}%` : '—',
          String(row.weeks ?? '–'),
          row.open ? 'open' : 'closed',
        ]),
        hovertemplate:
          '%{y}<br>%{customdata[0]} → %{customdata[1]} (%{customdata[3]}w)<br>Return %{customdata[2]} · %{customdata[4]}<extra></extra>',
      };
      const layout: Record<string, unknown> = {
        height: Math.max(220, Math.min(assetOrder.length * 24, 620)),
        margin: { l: 110, r: 18, t: 10, b: 30 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: colors.text, size: 11 },
        showlegend: false,
        xaxis: { type: 'date', gridcolor: colors.grid },
        yaxis: {
          categoryorder: 'array',
          categoryarray: assetOrder,
          gridcolor: colors.grid,
          automargin: true,
        },
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
  }, [rows, assetOrder, theme]);

  if (rows.length === 0) return <p className="text-sm text-muted">No trades for this run.</p>;
  return (
    <Card>
      <CardHeader
        title="Trade split"
        description="One bar per position held — green closed a winner, red a loser, purple still open. Hover for dates and return."
      />
      <div ref={ref} className="w-full" />
    </Card>
  );
}
