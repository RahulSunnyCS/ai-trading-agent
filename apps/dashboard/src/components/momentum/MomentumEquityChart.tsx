'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import {
  getChartTheme,
  getSeriesPalette,
  pickSeries,
  plotlyChrome,
  withAlpha,
} from '../../lib/chartTheme';
import { EMPTY, formatDay, formatInr, formatInt, formatPct } from '../../lib/format';
import {
  EQUITY_RANGES,
  type EquityRange,
  ROTATION_THIN_ABOVE_WEEKS,
  countVisibleWeeks,
  rangeStartIndex,
  rebaseFactor,
  rebaseSeries,
  signalActionTone,
  sliceSeries,
  startIndexFor,
  thinRotations,
} from '../../lib/momentumResult';
import { type PlotlyBasic, loadPlotly } from '../../lib/plotly';
import { useThemeStore } from '../../store/theme';
import type {
  MomentumComparison,
  MomentumRotation,
  MomentumSavedRun,
  MomentumSeries,
} from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { SegmentedControl } from '../ui/SegmentedControl';
import { useResultFlash } from './MomentumRunProgress';

type PlotEvent = 'plotly_hover' | 'plotly_unhover' | 'plotly_click' | 'plotly_relayout';
/** Plotly.react() attaches event-emitter methods to the div at runtime; not in the DOM lib types. */
type PlotlyHTMLElement = HTMLDivElement & {
  on?: (event: PlotEvent, handler: (event: Record<string, unknown>) => void) => void;
  removeAllListeners?: (event: PlotEvent) => void;
};

const PLOT_EVENTS: PlotEvent[] = [
  'plotly_hover',
  'plotly_unhover',
  'plotly_click',
  'plotly_relayout',
];

const lakh = (value: number | null) => (value === null ? null : value / 100_000);
/** A rupee value in lakh, up to two decimals: 125000 → "₹1.25 L". */
const rupees = (value: number | null) =>
  value === null ? EMPTY : `${formatInr(value / 100_000, { dp: 2, trim: true })} L`;

/** The x of the first point of a Plotly hover / click event, as an ISO day. */
function eventDay(event: Record<string, unknown>): string | null {
  const points = event.points as Array<{ x?: unknown }> | undefined;
  const x = points?.[0]?.x;
  return x == null ? null : String(x).slice(0, 10);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-faint">{label}</span>{' '}
      <span className="font-medium tabular-nums text-foreground">{children}</span>
    </span>
  );
}

function ActionLine({ action, children }: { action: string; children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-foreground">
      <Badge tone={signalActionTone(action)} className="px-1.5 py-0">
        {action}
      </Badge>
      <span>{children}</span>
    </p>
  );
}

/** One week's values and trades — the docked readout under the plot. */
function WeekDetail({
  index,
  series,
  rotation,
  benchmarkName,
}: {
  index: number;
  series: MomentumSeries;
  rotation: MomentumRotation | undefined;
  benchmarkName: string;
}) {
  const idle = series.idle_share[index] ?? 0;
  const edge = series.rolling_52w_excess[index] ?? null;
  const held = series.holdings_count[index];

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Fact label="Strategy">{rupees(series.strategy[index] ?? null)}</Fact>
        <Fact label={benchmarkName}>{rupees(series.benchmark[index] ?? null)}</Fact>
        <Fact label="Liquid fund">{rupees(series.cash[index] ?? null)}</Fact>
        <Fact label="Held">
          {held == null ? EMPTY : formatInt(held)}
          {idle > 0.001 ? ` · ${formatPct(idle)} cash` : ''}
        </Fact>
        <Fact label="Drawdown">
          <span className="text-negative">{formatPct(series.drawdown_strategy[index])}</span>
          <span className="font-normal text-muted">
            {' '}
            ({benchmarkName} {formatPct(series.drawdown_benchmark[index])})
          </span>
        </Fact>
        <Fact label="52w edge">
          <span
            className={edge === null ? 'text-muted' : edge >= 0 ? 'text-positive' : 'text-negative'}
          >
            {formatPct(edge, 1, { sign: true })}
          </span>
        </Fact>
      </div>
      {rotation ? (
        <div className="space-y-1 border-t border-border pt-2">
          {rotation.outs.map((row) => (
            <ActionLine key={`out-${row.asset}`} action="OUT">
              {row.asset} — held {row.weeks_held == null ? EMPTY : formatInt(row.weeks_held)}w,{' '}
              {formatPct(row.return, 1, { sign: true })} ({row.reason})
            </ActionLine>
          ))}
          {rotation.ins.map((row) => (
            <ActionLine key={`in-${row.asset}`} action={row.top_up ? 'ADD' : 'IN'}>
              {row.asset} (rank {row.rank == null ? EMPTY : formatInt(row.rank)})
            </ActionLine>
          ))}
          {rotation.trims.map((row) => (
            <ActionLine key={`trim-${row.asset}`} action="TRIM">
              {row.asset} ({row.reason})
            </ActionLine>
          ))}
          {rotation.parked ? (
            <ActionLine action="PARK">Nothing qualified, money to cash</ActionLine>
          ) : null}
          {rotation.holdings.length ? (
            <p className="text-muted">
              <span className="text-faint">Holding {formatInt(rotation.holdings.length)}:</span>{' '}
              {rotation.holdings.map((h) => `${h.asset} ${formatPct(h.share)}`).join(', ')}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="border-t border-border pt-2 text-muted">No trades this week.</p>
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
  const plotlyRef = useRef<PlotlyBasic | null>(null);
  const [scrollZoom, setScrollZoom] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const [range, setRange] = useState<EquityRange>('all');
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ key: string; from: string; to: string } | null>(null);
  const theme = useThemeStore((state) => state.theme);

  /** The visible window: lines re-based to ₹1 lakh at its first week, sub-panels sliced to it. */
  const view = useMemo(() => {
    const start = rangeStartIndex(series.dates, range);
    const dates = sliceSeries(series.dates, start);
    const firstDay = start > 0 ? (dates[0]?.slice(0, 10) ?? null) : null;
    const strategyFactor = start > 0 ? (rebaseFactor(series.strategy, start) ?? 1) : 1;
    const visible: MomentumSeries = {
      dates,
      strategy: rebaseSeries(series.strategy, start),
      benchmark: rebaseSeries(series.benchmark, start),
      cash: rebaseSeries(series.cash, start),
      drawdown_strategy: sliceSeries(series.drawdown_strategy, start),
      drawdown_benchmark: sliceSeries(series.drawdown_benchmark, start),
      rolling_52w_excess: sliceSeries(series.rolling_52w_excess, start),
      idle_share: sliceSeries(series.idle_share, start),
      holdings_count: sliceSeries(series.holdings_count, start),
    };
    return {
      series: visible,
      rebased: start > 0,
      firstDay,
      strategyFactor,
      comparisons: comparisons.map((line) => ({
        name: line.name,
        values: rebaseSeries(line.series, start),
      })),
      overlays: overlays.map((run) => {
        const runStart = startIndexFor(run.dates, firstDay);
        return {
          name: run.name || `Run ${run.n}`,
          dates: sliceSeries(run.dates, runStart),
          values: firstDay === null ? run.strategy : rebaseSeries(run.strategy, runStart),
        };
      }),
      rotations:
        firstDay === null
          ? rotations
          : rotations.filter((rotation) => rotation.week.slice(0, 10) >= firstDay),
    };
  }, [series, range, comparisons, overlays, rotations]);

  // Plotly keeps the user's zoom while this key is unchanged, and drops it when it changes.
  const revisionKey = `${series.dates[0] ?? ''}:${series.dates.at(-1) ?? ''}:${series.dates.length}:${range}:${logScale}`;
  const activeZoom = zoom !== null && zoom.key === revisionKey ? zoom : null;
  const visibleWeeks = countVisibleWeeks(
    view.series.dates,
    activeZoom?.from ?? null,
    activeZoom?.to ?? null,
  );
  const thinned = visibleWeeks > ROTATION_THIN_ABOVE_WEEKS;

  const rotationByWeek = useMemo(() => {
    const map = new Map<string, MomentumRotation>();
    for (const rotation of rotations) map.set(rotation.week.slice(0, 10), rotation);
    return map;
  }, [rotations]);

  const rotationPoints = useMemo(
    () =>
      thinRotations(view.rotations, thinned ? Number.POSITIVE_INFINITY : 0).map((rotation) => {
        const avgReturn = rotation.outs.length
          ? rotation.outs.reduce((sum, item) => sum + (item.return ?? 0), 0) / rotation.outs.length
          : null;
        return {
          date: rotation.week,
          value: lakh(rotation.value * view.strategyFactor),
          avgReturn,
        };
      }),
    [view, thinned],
  );

  // Purge once, on unmount. The render effect below only ever calls Plotly.react(), so a
  // re-render (theme, thinned markers, an overlay) keeps the user's pan and zoom.
  useEffect(() => {
    const element = chartRef.current;
    return () => {
      if (plotlyRef.current && element) plotlyRef.current.purge(element);
    };
  }, []);

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    let mounted = true;

    async function render(): Promise<void> {
      const plotly = await loadPlotly();
      if (!mounted || !element) return;
      plotlyRef.current = plotly;
      const colors = getChartTheme(theme);
      const palette = getSeriesPalette(theme);
      const shown = view.series;
      const traces: Array<Record<string, unknown>> = [
        {
          x: shown.dates,
          y: shown.strategy.map(lakh),
          name: 'Strategy',
          type: 'scatter',
          mode: 'lines',
          line: { color: colors.primary, width: 2.6 },
          fill: 'tozeroy',
          fillcolor: withAlpha(colors.primary, 0.08),
          hoverinfo: 'none',
        },
        {
          x: shown.dates,
          y: shown.benchmark.map(lakh),
          name: benchmarkName,
          type: 'scatter',
          mode: 'lines',
          // Foreground at a thinner width: clearly a reference line, not a disabled one.
          line: { color: colors.foreground, width: 1.4 },
          hoverinfo: 'none',
        },
        {
          x: shown.dates,
          y: shown.cash.map(lakh),
          name: 'Liquid fund',
          type: 'scatter',
          mode: 'lines',
          line: { color: colors.text, width: 1.4, dash: 'dot' },
          hoverinfo: 'none',
        },
        ...view.comparisons.map((line, index) => ({
          x: shown.dates,
          y: line.values.map(lakh),
          name: line.name,
          type: 'scatter',
          mode: 'lines',
          line: { color: pickSeries(palette, index), width: 1.3, dash: 'dashdot' },
          hoverinfo: 'none',
        })),
        {
          x: rotationPoints.map((item) => item.date),
          y: rotationPoints.map((item) => item.value),
          name: thinned ? 'Rotations (changes only)' : 'Rotations',
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
        ...view.overlays.map((run, index) => ({
          x: run.dates,
          y: run.values.map(lakh),
          name: run.name,
          type: 'scatter',
          mode: 'lines',
          line: {
            // Offset from the comparison lines above so an overlay and a comparison differ.
            color: pickSeries(palette, index + view.comparisons.length),
            width: 1.5,
            dash: 'dash',
          },
          hoverinfo: 'none',
        })),
        {
          x: shown.dates,
          y: shown.drawdown_strategy,
          name: 'Strategy drawdown',
          type: 'scatter',
          mode: 'lines',
          yaxis: 'y2',
          showlegend: false,
          fill: 'tozeroy',
          fillcolor: withAlpha(colors.negative, 0.15),
          line: { color: colors.negative, width: 1.5 },
          hoverinfo: 'none',
        },
        {
          x: shown.dates,
          y: shown.drawdown_benchmark,
          name: 'Benchmark drawdown',
          type: 'scatter',
          mode: 'lines',
          yaxis: 'y2',
          showlegend: false,
          line: { color: colors.foreground, width: 1 },
          hoverinfo: 'none',
        },
        {
          x: shown.dates,
          y: shown.rolling_52w_excess,
          name: '52 week edge',
          type: 'bar',
          yaxis: 'y3',
          showlegend: false,
          marker: {
            color: shown.rolling_52w_excess.map((value) =>
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
        uirevision: revisionKey,
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
      if (!mounted) return;
      const plotlyElement = element as PlotlyHTMLElement;
      for (const name of PLOT_EVENTS) plotlyElement.removeAllListeners?.(name);
      plotlyElement.on?.('plotly_hover', (event) => {
        const day = eventDay(event);
        if (day) setHoverDate(day);
      });
      plotlyElement.on?.('plotly_unhover', () => setHoverDate(null));
      // Traces are hoverinfo 'none', so a tap is the only readout a touch screen gets.
      plotlyElement.on?.('plotly_click', (event) => {
        const day = eventDay(event);
        if (day) setSelectedDate(day);
      });
      plotlyElement.on?.('plotly_relayout', (event) => {
        const pair = event['xaxis.range'] as unknown[] | undefined;
        const from = event['xaxis.range[0]'] ?? pair?.[0];
        const to = event['xaxis.range[1]'] ?? pair?.[1];
        if (from != null && to != null) {
          setZoom({
            key: revisionKey,
            from: String(from).slice(0, 10),
            to: String(to).slice(0, 10),
          });
        } else if (event['xaxis.autorange']) setZoom(null);
      });
    }

    void render();
    return () => {
      mounted = false;
    };
  }, [view, benchmarkName, rotationPoints, thinned, scrollZoom, logScale, theme, revisionKey]);

  const shown = view.series;
  const indexOf = (day: string | null) =>
    day === null ? -1 : shown.dates.findIndex((d) => d.slice(0, 10) === day);
  const hoverIndex = indexOf(hoverDate);
  const selectedIndex = indexOf(selectedDate);
  const detailIndex =
    hoverIndex >= 0 ? hoverIndex : selectedIndex >= 0 ? selectedIndex : shown.dates.length - 1;
  const detailSource = hoverIndex >= 0 ? 'hover' : selectedIndex >= 0 ? 'selected' : 'latest';
  const detailDay = shown.dates[detailIndex]?.slice(0, 10) ?? null;

  return (
    <Card className={flashing ? 'animate-result-flash' : ''}>
      <CardHeader
        title="Portfolio value and risk"
        description={
          view.rebased && view.firstDay
            ? `Every line re-based to ₹1 lakh on ${formatDay(view.firstDay)} · hover or tap a week for its trades · drag to pan`
            : '₹1 lakh starting value · hover or tap a week for its trades · drag to pan'
        }
        className="flex-wrap"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <SegmentedControl
              ariaLabel="Chart range"
              size="sm"
              value={range}
              onChange={setRange}
              options={EQUITY_RANGES}
            />
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
      <div
        ref={chartRef}
        role="img"
        aria-label="Strategy, benchmark and cash values with drawdown and trailing excess return"
        className="w-full"
      />
      {/* Docked under the plot at a fixed height, so a hover never covers a sub-panel or
          moves the page. */}
      <section
        aria-label="Week detail"
        className="mt-3 h-44 overflow-y-auto rounded-lg border border-border bg-surface-2/30 px-3 py-2.5"
      >
        {detailDay === null ? (
          <p className="text-xs text-muted">No weeks in this run.</p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold text-foreground">{formatDay(detailDay)}</span>
              <Badge tone={detailSource === 'latest' ? 'neutral' : 'primary'}>
                {detailSource === 'hover'
                  ? 'Hovered week'
                  : detailSource === 'selected'
                    ? 'Selected week'
                    : 'Latest week'}
              </Badge>
              {selectedIndex >= 0 ? (
                <Button size="sm" variant="ghost" onClick={() => setSelectedDate(null)}>
                  Back to latest
                </Button>
              ) : (
                <span className="text-faint">Hover the chart, or tap a week to pin it here.</span>
              )}
            </div>
            <WeekDetail
              index={detailIndex}
              series={shown}
              rotation={rotationByWeek.get(detailDay)}
              benchmarkName={benchmarkName}
            />
          </>
        )}
      </section>
    </Card>
  );
}
