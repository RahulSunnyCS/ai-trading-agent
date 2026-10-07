'use client';

import { type ReactNode, useMemo, useRef, useState } from 'react';

import { useWidgetActivation } from '../../hooks/useWidgetActivation';
import { cn } from '../../lib/cn';
import { formatDay, formatInt, formatPct } from '../../lib/format';
import {
  type BenchmarkView,
  changeBetween,
  worstEpisodes,
  yearlyRows,
} from '../../lib/momentumBenchmark';
import { drawdownStats } from '../../lib/momentumResult';
import type { MomentumResult, MomentumSavedRun, MomentumSeries } from '../../types/momentum';
import { SkeletonRows } from '../ui/Skeleton';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { MomentumCircuitExposureLoader } from './MomentumCircuitExposure';
import { MomentumCompare } from './MomentumCompare';
import { MomentumLineChart } from './MomentumLineChart';
import { MomentumMonthlyHeatmap } from './MomentumMonthlyHeatmap';
import { InstrumentsPanel, TimelinePanel, TradesPanel, WeekPanel } from './MomentumResultDetails';
import { MomentumYearlyChart } from './MomentumYearlyChart';

/**
 * When each widget loads in the background after the hero chart, in ms (the Analytics page
 * pattern's progressive loading): the cheap ones first, then the fetched sections in the order
 * the page shows them. Any widget scrolled near loads at once; circuit exposure, which costs a
 * second engine run, only then.
 */
const PREFETCH_MS = {
  computed: 150,
  week: 400,
  trades: 1200,
  timeline: 2000,
  instruments: 2800,
} as const;

/**
 * A card below the fold: title, a one-line description and actions on one header row, then its
 * content once it is near the screen (or its prefetch time has come). Half width by default;
 * `wide` spans the grid.
 */
function Widget({
  title,
  meta,
  actions,
  wide = false,
  prefetchAfterMs = PREFETCH_MS.computed,
  placeholderRows = 5,
  children,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  prefetchAfterMs?: number | null;
  placeholderRows?: number;
  children: () => ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const active = useWidgetActivation(ref, { prefetchAfterMs });
  return (
    <section
      ref={ref}
      aria-label={title}
      className={cn(
        'min-w-0 rounded-xl border border-border bg-surface shadow-card',
        wide && 'lg:col-span-2',
      )}
    >
      <header className="flex items-center gap-3 whitespace-nowrap px-4 pb-2 pt-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {meta ? <p className="min-w-0 flex-1 truncate text-xs text-faint">{meta}</p> : null}
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      <div className="px-4 pb-4">
        {active ? children() : <SkeletonRows rows={placeholderRows} />}
      </div>
    </section>
  );
}

/** A widget-less lazy slot, for a section that draws its own card (circuit exposure). */
function LazySlot({ children }: { children: () => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useWidgetActivation(ref, { prefetchAfterMs: null });
  return (
    <div ref={ref} className="min-w-0 lg:col-span-2">
      {active ? children() : null}
    </div>
  );
}

function weeksBetween(dates: ReadonlyArray<string>, from: number, to: number | null): string {
  return `${formatInt((to ?? dates.length - 1) - from)} wk`;
}

/** The strategy's deepest falls, each against the benchmark over the same weeks. */
function DrawdownsBody({ series, view }: { series: MomentumSeries; view: BenchmarkView }) {
  const dates = series.dates;
  const stats = drawdownStats(dates, series.drawdown_strategy);
  const episodes = useMemo(() => worstEpisodes(series.strategy, 5), [series.strategy]);
  const lines = useMemo(
    () => [
      {
        name: 'Strategy',
        values: series.drawdown_strategy,
        role: 'negative' as const,
        fill: true,
      },
      {
        name: view.label,
        values: series.drawdown_benchmark,
        role: 'benchmark' as const,
        dash: 'dot' as const,
      },
    ],
    [series, view.label],
  );
  return (
    <div className="space-y-3">
      <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span className="whitespace-nowrap">
          Max <span className="metric text-negative">{formatPct(stats.max)}</span>
          {stats.troughDate ? ` (trough ${formatDay(stats.troughDate)})` : ''}
        </span>
        <span className="whitespace-nowrap">
          Now <span className="metric text-foreground">{formatPct(stats.current)}</span>
        </span>
        <span className="whitespace-nowrap">
          Longest under water{' '}
          <span className="metric text-foreground">
            {stats.underwater ? `${formatInt(stats.underwater.weeks)} wk` : 'never'}
          </span>
          {stats.underwater?.ongoing ? ' (not yet recovered)' : ''}
        </span>
      </p>
      <MomentumLineChart
        dates={dates}
        lines={lines}
        height={150}
        label={`Strategy and ${view.label} drawdown`}
      />
      <Table className="[&_td]:whitespace-nowrap [&_td]:py-1.5">
        <THead>
          <Th>Peak</Th>
          <Th>Trough</Th>
          <Th>Recovered</Th>
          <Th align="right">Depth</Th>
          <Th align="right">Benchmark</Th>
          <Th align="right">Length</Th>
        </THead>
        <tbody>
          {episodes.map((episode) => (
            <TRow key={episode.peak}>
              <Td numeric>{formatDay(dates[episode.peak])}</Td>
              <Td numeric>{formatDay(dates[episode.trough])}</Td>
              <Td numeric>
                {episode.recovered === null ? (
                  <span className="text-warning">not yet</span>
                ) : (
                  formatDay(dates[episode.recovered])
                )}
              </Td>
              <Td numeric align="right">
                <span className="text-negative">{formatPct(episode.depth)}</span>
              </Td>
              <Td numeric align="right">
                <span className="text-muted">
                  {formatPct(changeBetween(series.benchmark, episode.peak, episode.trough))}
                </span>
              </Td>
              <Td numeric align="right">
                <span className="text-muted">
                  {weeksBetween(dates, episode.peak, episode.recovered)}
                </span>
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/** The benchmark's worst falls, and what the strategy did over the same weeks. */
function BenchmarkFallsBody({ series, view }: { series: MomentumSeries; view: BenchmarkView }) {
  const dates = series.dates;
  const falls = useMemo(() => worstEpisodes(series.benchmark, 5), [series.benchmark]);
  if (falls.length === 0) return <p className="text-sm text-muted">No falls in this period.</p>;
  return (
    <Table className="[&_td]:whitespace-nowrap [&_td]:py-1.5">
      <THead>
        <Th>Peak</Th>
        <Th>Trough</Th>
        <Th align="right">{view.label}</Th>
        <Th align="right">Strategy</Th>
      </THead>
      <tbody>
        {falls.map((fall) => {
          const strategy = changeBetween(series.strategy, fall.peak, fall.trough);
          return (
            <TRow key={fall.peak}>
              <Td numeric>{formatDay(dates[fall.peak])}</Td>
              <Td numeric>{formatDay(dates[fall.trough])}</Td>
              <Td numeric align="right">
                <span className="text-negative">{formatPct(fall.depth)}</span>
              </Td>
              <Td numeric align="right">
                <span
                  className={
                    strategy === null
                      ? 'text-muted'
                      : strategy > fall.depth
                        ? 'text-positive'
                        : 'text-negative'
                  }
                >
                  {formatPct(strategy, 1, { sign: true })}
                </span>
              </Td>
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}

/** Share of 52-week windows in which the strategy was ahead of the benchmark. */
function aheadShare(excess: ReadonlyArray<number | null>): number | null {
  const known = excess.filter((value): value is number => value !== null);
  return known.length ? known.filter((value) => value > 0).length / known.length : null;
}

function rolling52(values: ReadonlyArray<number | null>): Array<number | null> {
  return values.map((value, index) => {
    const start = values[index - 52];
    return index < 52 || value == null || start == null || start <= 0 ? null : value / start - 1;
  });
}

/**
 * Everything below the hero chart (the Analytics page pattern): a two-column grid of widgets,
 * each loading in the background in turn or as it is scrolled to. `series` carries the picked
 * benchmark, so every comparison here follows the headline picker.
 */
export function MomentumResultWidgets({
  runId,
  result,
  series,
  view,
  config,
  savedRuns,
  broad,
}: {
  runId: string;
  result: MomentumResult;
  series: MomentumSeries;
  view: BenchmarkView;
  config: Record<string, unknown>;
  savedRuns: MomentumSavedRun[];
  broad: boolean;
}) {
  const [tradeFilter, setTradeFilter] = useState('');
  const yearly = useMemo(() => yearlyRows(series), [series]);
  const rollingLines = useMemo(
    () => [
      { name: view.label, values: rolling52(series.benchmark), role: 'benchmark' as const },
      { name: 'Strategy', values: rolling52(series.strategy), role: 'strategy' as const },
    ],
    [series, view.label],
  );
  const ahead = aheadShare(series.rolling_52w_excess);
  const tradeCount = result.kpis.exits_per_year;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Widget
        wide
        title="This week"
        meta="The latest signals and what the portfolio holds now"
        prefetchAfterMs={PREFETCH_MS.week}
        placeholderRows={6}
      >
        {() => <WeekPanel runId={runId} result={result} config={config} />}
      </Widget>
      <Widget title="Yearly returns" meta={`Green years beat ${view.label}, red trailed it`}>
        {() => <MomentumYearlyChart rows={yearly} benchmarkName={view.label} />}
      </Widget>
      <Widget
        title="Rolling 1-year return"
        meta={
          ahead === null
            ? 'Return over each trailing 52 weeks'
            : `Ahead of ${view.label} in ${formatPct(ahead, 0)} of 52-week windows`
        }
      >
        {() => (
          <MomentumLineChart
            dates={series.dates}
            lines={rollingLines}
            height={280}
            label={`Trailing 52-week return of the strategy and ${view.label}`}
          />
        )}
      </Widget>
      <Widget title="Drawdowns" meta="The deepest falls and how long they lasted">
        {() => <DrawdownsBody series={series} view={view} />}
      </Widget>
      <Widget title="Monthly returns" meta="By calendar month, with the year's total">
        {() => <MomentumMonthlyHeatmap series={series} benchmarkName={view.label} />}
      </Widget>
      <Widget
        wide
        title="Trades"
        meta={
          typeof tradeCount === 'number'
            ? `Newest first · about ${formatInt(Math.round(tradeCount))} exits a year`
            : 'Newest first'
        }
        prefetchAfterMs={PREFETCH_MS.trades}
      >
        {() => <TradesPanel runId={runId} filter={tradeFilter} onFilter={setTradeFilter} />}
      </Widget>
      <Widget
        title={`${view.label}'s worst falls`}
        meta="And what the strategy did over the same weeks"
      >
        {() => <BenchmarkFallsBody series={series} view={view} />}
      </Widget>
      <Widget title="Compare runs" meta="Saved runs of this dataset, side by side">
        {() =>
          savedRuns.length ? (
            <MomentumCompare runs={savedRuns} />
          ) : (
            <p className="text-sm text-muted">
              No saved runs to compare yet. Each finished run is saved automatically.
            </p>
          )
        }
      </Widget>
      <Widget
        wide
        title="Holdings timeline"
        meta="What was held when, and today's split"
        prefetchAfterMs={PREFETCH_MS.timeline}
      >
        {() => <TimelinePanel runId={runId} result={result} />}
      </Widget>
      {broad ? <LazySlot>{() => <MomentumCircuitExposureLoader runId={runId} />}</LazySlot> : null}
      <Widget
        wide
        title="Instrument attribution"
        meta="How each instrument contributed across the whole run"
        prefetchAfterMs={PREFETCH_MS.instruments}
      >
        {() => <InstrumentsPanel runId={runId} />}
      </Widget>
    </div>
  );
}
