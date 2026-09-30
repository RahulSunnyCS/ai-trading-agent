'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { getChartTheme } from '../../lib/chartTheme';
import { useThemeStore } from '../../store/theme';
import type { MomentumSavedRun, MomentumSeries } from '../../types/momentum';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';

type PlotlyBasic = typeof import('plotly.js-basic-dist-min').default;

const lakh = (value: number | null) => value === null ? null : value / 100_000;

export function MomentumEquityChart({
  series,
  benchmarkName,
  rotationWeeks,
  overlays = [],
}: {
  series: MomentumSeries;
  benchmarkName: string;
  rotationWeeks: string[];
  overlays?: MomentumSavedRun[];
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [scrollZoom, setScrollZoom] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const theme = useThemeStore((state) => state.theme);
  const rotations = useMemo(() => {
    const dates = new Set(rotationWeeks);
    return series.dates.flatMap((date, index) =>
      dates.has(date) ? [{ date, value: lakh(series.strategy[index] ?? null) }] : [],
    );
  }, [rotationWeeks, series]);

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    let mounted = true;
    let plotly: PlotlyBasic | null = null;

    async function render(): Promise<void> {
      const loaded = await import('plotly.js-basic-dist-min');
      if (!mounted || !element) return;
      plotly = loaded.default;
      const colors = getChartTheme(theme);
      const traces: Array<Record<string, unknown>> = [
        {
          x: series.dates, y: series.strategy.map(lakh), name: 'Strategy',
          type: 'scatter', mode: 'lines', line: { color: colors.primary, width: 2.5 },
          hovertemplate: 'Strategy ₹%{y:.2f} L<extra></extra>',
        },
        {
          x: series.dates, y: series.benchmark.map(lakh), name: benchmarkName,
          type: 'scatter', mode: 'lines', line: { color: colors.text, width: 1.8 },
          hovertemplate: `${benchmarkName} ₹%{y:.2f} L<extra></extra>`,
        },
        {
          x: series.dates, y: series.cash.map(lakh), name: 'Liquid fund',
          type: 'scatter', mode: 'lines', line: { color: colors.border, width: 1.5, dash: 'dot' },
          hovertemplate: 'Liquid fund ₹%{y:.2f} L<extra></extra>',
        },
        {
          x: rotations.map((item) => item.date), y: rotations.map((item) => item.value),
          name: 'Rotations', type: 'scatter', mode: 'markers',
          marker: { color: colors.primary, size: 7 },
          hovertemplate: 'Rotation on %{x}<extra></extra>',
        },
        ...overlays.map((run, index) => ({
          x: run.dates, y: run.strategy.map(lakh), name: run.name || `Run ${run.n}`,
          type: 'scatter', mode: 'lines',
          line: { color: index % 2 === 0 ? colors.positive : colors.negative, width: 1.5, dash: 'dash' },
          hovertemplate: `${run.name || `Run ${run.n}`} ₹%{y:.2f} L<extra></extra>`,
        })),
        {
          x: series.dates, y: series.drawdown_strategy, name: 'Strategy drawdown',
          type: 'scatter', mode: 'lines', yaxis: 'y2', showlegend: false,
          fill: 'tozeroy', line: { color: colors.negative, width: 1.5 },
          hovertemplate: 'Strategy drawdown %{y:.1%}<extra></extra>',
        },
        {
          x: series.dates, y: series.drawdown_benchmark, name: 'Benchmark drawdown',
          type: 'scatter', mode: 'lines', yaxis: 'y2', showlegend: false,
          line: { color: colors.text, width: 1 },
          hovertemplate: 'Benchmark drawdown %{y:.1%}<extra></extra>',
        },
        {
          x: series.dates, y: series.rolling_52w_excess, name: '52 week edge',
          type: 'bar', yaxis: 'y3', showlegend: false,
          marker: { color: series.rolling_52w_excess.map((value) =>
            value === null ? 'rgba(0,0,0,0)' : value >= 0 ? colors.positive : colors.negative) },
          hovertemplate: 'Trailing 52 weeks vs benchmark %{y:+.1%}<extra></extra>',
        },
      ];
      const layout: Record<string, unknown> = {
        height: 560,
        margin: { l: 66, r: 18, t: 32, b: 36 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: colors.text, size: 12 },
        hovermode: 'x unified',
        dragmode: 'pan',
        uirevision: `${logScale}`,
        legend: { orientation: 'h', y: 1.07, x: 0 },
        xaxis: { type: 'date', anchor: 'y3', gridcolor: colors.grid, rangeslider: { visible: false } },
        yaxis: { domain: [0.46, 1], gridcolor: colors.grid, tickprefix: '₹', ticksuffix: ' L', type: logScale ? 'log' : 'linear' },
        yaxis2: { domain: [0.24, 0.42], gridcolor: colors.grid, tickformat: '.0%' },
        yaxis3: { domain: [0, 0.20], gridcolor: colors.grid, tickformat: '+.0%' },
      };
      await plotly.react(element, traces, layout, {
        responsive: true,
        displaylogo: false,
        displayModeBar: true,
        scrollZoom,
      });
    }

    void render();
    return () => {
      mounted = false;
      if (plotly && element) plotly.purge(element);
    };
  }, [series, benchmarkName, rotations, overlays, scrollZoom, logScale, theme]);

  return (
    <Card>
      <CardHeader
        title="Portfolio value and risk"
        description="₹1 lakh starting value · drag to pan · use the chart toolbar to zoom or reset"
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant={scrollZoom ? 'primary' : 'secondary'} aria-pressed={scrollZoom} onClick={() => setScrollZoom((value) => !value)}>
              Touchpad zoom {scrollZoom ? 'on' : 'off'}
            </Button>
            <Button size="sm" variant={logScale ? 'primary' : 'secondary'} aria-pressed={logScale} onClick={() => setLogScale((value) => !value)}>
              Log scale
            </Button>
          </div>
        }
      />
      <div ref={chartRef} role="img" aria-label="Strategy, benchmark and cash values with drawdown and trailing excess return" className="w-full" />
    </Card>
  );
}
