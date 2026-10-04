'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { getChartTheme, getSeriesPalette, pickSeries, plotlyChrome } from '../../lib/chartTheme';
import { EMPTY, formatInr, formatPct } from '../../lib/format';
import { useThemeStore } from '../../store/theme';
import type {
  MomentumComparison,
  MomentumRotation,
  MomentumSavedRun,
  MomentumSeries,
} from '../../types/momentum';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { useResultFlash } from './MomentumRunProgress';

type PlotlyBasic = typeof import('plotly.js-basic-dist-min').default;
/** Plotly.react() attaches event-emitter methods to the div at runtime; not in the DOM lib types. */
type PlotlyHTMLElement = HTMLDivElement & {
  on?: (
    event: 'plotly_hover' | 'plotly_unhover',
    handler: (event: { points?: Array<{ x?: unknown }> }) => void,
  ) => void;
  removeAllListeners?: (event: 'plotly_hover' | 'plotly_unhover') => void;
};

const lakh = (value: number | null) => (value === null ? null : value / 100_000);
/** A rupee value in lakh, up to two decimals: 125000 → "₹1.25 L". */
const rupees = (value: number | null) =>
  value === null ? EMPTY : `${formatInr(value / 100_000, { dp: 2, trim: true })} L`;

const HOVER_HINT = 'Hover the chart to see that week’s values and trades here.';

function WeekDetail({
  date,
  series,
  rotation,
  benchmarkName,
}: {
  date: string;
  series: MomentumSeries;
  rotation: MomentumRotation | undefined;
  benchmarkName: string;
}) {
  const index = series.dates.findIndex((d) => d.slice(0, 10) === date);
  if (index < 0) return <span className="text-muted">{HOVER_HINT}</span>;
  const idle = series.idle_share[index] ?? 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="font-semibold text-foreground">{date}</span>
        <span>
          Strategy <b className="text-foreground">{rupees(series.strategy[index] ?? null)}</b> ·{' '}
          {series.holdings_count[index] ?? '–'} held
          {idle > 0.001 ? ` · ${formatPct(idle)} cash` : ''}
        </span>
        <span>
          {benchmarkName} {rupees(series.benchmark[index] ?? null)}
        </span>
        <span>Liquid fund {rupees(series.cash[index] ?? null)}</span>
        <span>
          Drawdown <b className="text-negative">{formatPct(series.drawdown_strategy[index])}</b> (
          {benchmarkName} {formatPct(series.drawdown_benchmark[index])})
        </span>
        <span>
          52w edge{' '}
          <b
            className={
              (series.rolling_52w_excess[index] ?? 0) >= 0 ? 'text-positive' : 'text-negative'
            }
          >
            {formatPct(series.rolling_52w_excess[index], 1, { sign: true })}
          </b>
        </span>
      </div>
      {rotation ? (
        <div className="space-y-0.5 border-t border-border pt-2 text-xs">
          {rotation.outs.map((row) => (
            <p key={`out-${row.asset}`}>
              <span className="font-semibold text-negative">OUT</span> {row.asset} — held{' '}
              {row.weeks_held ?? '–'}w, {formatPct(row.return, 1, { sign: true })} ({row.reason})
            </p>
          ))}
          {rotation.ins.map((row) => (
            <p key={`in-${row.asset}`}>
              <span className="font-semibold text-positive">{row.top_up ? 'ADD' : 'IN'}</span>{' '}
              {row.asset} (rank {row.rank ?? '–'})
            </p>
          ))}
          {rotation.trims.map((row) => (
            <p key={`trim-${row.asset}`}>
              <span className="font-semibold text-warning">TRIM</span> {row.asset} ({row.reason})
            </p>
          ))}
          {rotation.parked ? (
            <p className="text-muted">PARK — nothing qualified, money to cash</p>
          ) : null}
          {rotation.holdings.length ? (
            <p className="italic text-muted">
              Holding {rotation.holdings.length}:{' '}
              {rotation.holdings.map((h) => `${h.asset} ${formatPct(h.share)}`).join(', ')}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="border-t border-border pt-2 text-xs text-muted">No trades this week.</p>
      )}
    </div>
  );
}

export function MomentumEquityChart({
  series,
  benchmarkName,
  rotations,
  overlays = [],
  comparisons = [],
  flashKey = null,
}: {
  series: MomentumSeries;
  benchmarkName: string;
  rotations: MomentumRotation[];
  overlays?: MomentumSavedRun[];
  comparisons?: MomentumComparison[];
  flashKey?: number | null;
}) {
  const flashing = useResultFlash(flashKey);
  const chartRef = useRef<HTMLDivElement>(null);
  const [scrollZoom, setScrollZoom] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const theme = useThemeStore((state) => state.theme);

  const rotationByWeek = useMemo(() => {
    const map = new Map<string, MomentumRotation>();
    for (const rotation of rotations) map.set(rotation.week.slice(0, 10), rotation);
    return map;
  }, [rotations]);

  const rotationPoints = useMemo(
    () =>
      rotations.map((rotation) => {
        const avgReturn = rotation.outs.length
          ? rotation.outs.reduce((sum, item) => sum + (item.return ?? 0), 0) / rotation.outs.length
          : null;
        return { date: rotation.week, value: lakh(rotation.value), avgReturn };
      }),
    [rotations],
  );

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
      const palette = getSeriesPalette(theme);
      const traces: Array<Record<string, unknown>> = [
        {
          x: series.dates,
          y: series.strategy.map(lakh),
          name: 'Strategy',
          type: 'scatter',
          mode: 'lines',
          line: { color: colors.primary, width: 2.6 },
          fill: 'tozeroy',
          fillcolor: colors.primary.replace('rgb', 'rgba').replace(')', ', 0.08)'),
          hoverinfo: 'none',
        },
        {
          x: series.dates,
          y: series.benchmark.map(lakh),
          name: benchmarkName,
          type: 'scatter',
          mode: 'lines',
          line: { color: colors.text, width: 1.6 },
          hoverinfo: 'none',
        },
        {
          x: series.dates,
          y: series.cash.map(lakh),
          name: 'Liquid fund',
          type: 'scatter',
          mode: 'lines',
          line: { color: colors.border, width: 1.4, dash: 'dot' },
          hoverinfo: 'none',
        },
        ...comparisons.map((line, index) => ({
          x: series.dates,
          y: line.series.map(lakh),
          name: line.name,
          type: 'scatter',
          mode: 'lines',
          line: { color: pickSeries(palette, index), width: 1.3, dash: 'dashdot' },
          hoverinfo: 'none',
        })),
        {
          x: rotationPoints.map((item) => item.date),
          y: rotationPoints.map((item) => item.value),
          name: 'Rotations',
          type: 'scatter',
          mode: 'markers',
          marker: {
            size: 7.5,
            line: { width: 1, color: colors.grid },
            color: rotationPoints.map((item) =>
              item.avgReturn === null
                ? colors.primary
                : item.avgReturn >= 0
                  ? colors.positive
                  : colors.negative,
            ),
          },
          hoverinfo: 'none',
        },
        ...overlays.map((run, index) => ({
          x: run.dates,
          y: run.strategy.map(lakh),
          name: run.name || `Run ${run.n}`,
          type: 'scatter',
          mode: 'lines',
          line: {
            // Offset from the comparison lines above so an overlay and a comparison differ.
            color: pickSeries(palette, index + comparisons.length),
            width: 1.5,
            dash: 'dash',
          },
          hoverinfo: 'none',
        })),
        {
          x: series.dates,
          y: series.drawdown_strategy,
          name: 'Strategy drawdown',
          type: 'scatter',
          mode: 'lines',
          yaxis: 'y2',
          showlegend: false,
          fill: 'tozeroy',
          line: { color: colors.negative, width: 1.5 },
          hoverinfo: 'none',
        },
        {
          x: series.dates,
          y: series.drawdown_benchmark,
          name: 'Benchmark drawdown',
          type: 'scatter',
          mode: 'lines',
          yaxis: 'y2',
          showlegend: false,
          line: { color: colors.text, width: 1 },
          hoverinfo: 'none',
        },
        {
          x: series.dates,
          y: series.rolling_52w_excess,
          name: '52 week edge',
          type: 'bar',
          yaxis: 'y3',
          showlegend: false,
          marker: {
            color: series.rolling_52w_excess.map((value) =>
              value === null ? 'rgba(0,0,0,0)' : value >= 0 ? colors.positive : colors.negative,
            ),
          },
          hoverinfo: 'none',
        },
      ];
      const layout: Record<string, unknown> = {
        height: 560,
        margin: { l: 66, r: 18, t: 32, b: 36 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        ...plotlyChrome(colors),
        hovermode: 'x unified',
        dragmode: 'pan',
        uirevision: `${logScale}`,
        legend: { orientation: 'h', y: 1.07, x: 0 },
        xaxis: {
          type: 'date',
          anchor: 'y3',
          gridcolor: colors.grid,
          rangeslider: { visible: false },
          showspikes: true,
          spikemode: 'across',
          spikethickness: 1,
          spikecolor: colors.text,
        },
        yaxis: {
          domain: [0.46, 1],
          gridcolor: colors.grid,
          tickprefix: '₹',
          ticksuffix: ' L',
          type: logScale ? 'log' : 'linear',
          title: { text: 'Value of ₹1 lakh invested', font: { size: 11, color: colors.text } },
        },
        yaxis2: {
          domain: [0.24, 0.42],
          gridcolor: colors.grid,
          tickformat: '.0%',
          title: { text: 'Drawdown', font: { size: 11, color: colors.text } },
        },
        yaxis3: {
          domain: [0, 0.2],
          gridcolor: colors.grid,
          tickformat: '+.0%',
          title: { text: '52w edge', font: { size: 11, color: colors.text } },
        },
      };
      await plotly.react(element, traces, layout, {
        responsive: true,
        displaylogo: false,
        displayModeBar: true,
        scrollZoom,
      });
      const plotlyElement = element as PlotlyHTMLElement;
      plotlyElement.removeAllListeners?.('plotly_hover');
      plotlyElement.removeAllListeners?.('plotly_unhover');
      plotlyElement.on?.('plotly_hover', (event) => {
        const x = event.points?.[0]?.x;
        if (x != null) setHoverDate(String(x).slice(0, 10));
      });
      plotlyElement.on?.('plotly_unhover', () => setHoverDate(null));
    }

    void render();
    return () => {
      mounted = false;
      if (plotly && element) plotly.purge(element);
    };
  }, [series, benchmarkName, rotationPoints, overlays, comparisons, scrollZoom, logScale, theme]);

  return (
    <Card className={flashing ? 'animate-result-flash' : ''}>
      <CardHeader
        title="Portfolio value and risk"
        description="₹1 lakh starting value · hover for that week's trades · drag to pan"
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={scrollZoom ? 'primary' : 'secondary'}
              aria-pressed={scrollZoom}
              onClick={() => setScrollZoom((value) => !value)}
            >
              Touchpad zoom {scrollZoom ? 'on' : 'off'}
            </Button>
            <Button
              size="sm"
              variant={logScale ? 'primary' : 'secondary'}
              aria-pressed={logScale}
              onClick={() => setLogScale((value) => !value)}
            >
              Log scale
            </Button>
          </div>
        }
      />
      <div className="relative">
        <div
          ref={chartRef}
          role="img"
          aria-label="Strategy, benchmark and cash values with drawdown and trailing excess return"
          className="w-full"
        />
        {hoverDate ? (
          <div className="pointer-events-none absolute inset-x-0 top-[40%] z-10 min-h-[60%] animate-fade-in rounded-lg border-t border-border bg-surface px-3 py-2.5 shadow-elevated">
            <WeekDetail
              date={hoverDate}
              series={series}
              rotation={rotationByWeek.get(hoverDate)}
              benchmarkName={benchmarkName}
            />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
