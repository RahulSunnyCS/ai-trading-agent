'use client';

import { useMemo, useState } from 'react';

import { cn } from '../../lib/cn';
import { formatNumber, formatPct, formatPp } from '../../lib/format';
import {
  MONTH_LABELS,
  differenceByKey,
  heatLevel,
  monthlyReturns,
  yearlyFromMonthly,
} from '../../lib/momentumResult';
import type { MomentumSeries } from '../../types/momentum';
import { SegmentedControl } from '../ui/SegmentedControl';

type HeatmapMode = 'strategy' | 'benchmark' | 'difference';

// Sign picks the colour, magnitude the strength. Literal class names on the default opacity
// scale, so the Tailwind class test can see every one.
const POSITIVE_TONES = [
  '',
  'bg-positive/10 text-positive',
  'bg-positive/20 text-positive',
  'bg-positive/30 text-foreground',
  'bg-positive/40 text-foreground',
] as const;
const NEGATIVE_TONES = [
  '',
  'bg-negative/10 text-negative',
  'bg-negative/20 text-negative',
  'bg-negative/30 text-foreground',
  'bg-negative/40 text-foreground',
] as const;

function cellTone(value: number | undefined): string {
  const level = heatLevel(value);
  if (value === undefined) return 'bg-surface-2/30 text-faint';
  if (level === 0) return 'bg-surface-2/50 text-muted';
  return (value > 0 ? POSITIVE_TONES : NEGATIVE_TONES)[level];
}

/**
 * Year × month grid of returns with a yearly total, resampled client-side from the weekly
 * series. One grid with a Strategy / Benchmark / Difference toggle rather than a benchmark row
 * under every year, which would double its height.
 */
export function MomentumMonthlyHeatmap({
  series,
  benchmarkName = 'Benchmark',
}: {
  series: MomentumSeries;
  /** Names the benchmark in the toggle and the cell labels. */
  benchmarkName?: string;
}) {
  const [mode, setMode] = useState<HeatmapMode>('strategy');

  const data = useMemo(() => {
    const strategy = monthlyReturns(series.dates, series.strategy);
    const benchmark = monthlyReturns(series.dates, series.benchmark);
    const strategyYears = yearlyFromMonthly(strategy);
    const benchmarkYears = yearlyFromMonthly(benchmark);
    return {
      strategy: { months: strategy, years: strategyYears },
      benchmark: { months: benchmark, years: benchmarkYears },
      difference: {
        months: differenceByKey(strategy, benchmark),
        years: differenceByKey(strategyYears, benchmarkYears),
      },
    };
  }, [series]);

  const years = useMemo(() => {
    const set = new Set<string>();
    for (const month of data.strategy.months.keys()) set.add(month.slice(0, 4));
    for (const month of data.benchmark.months.keys()) set.add(month.slice(0, 4));
    return [...set].sort();
  }, [data]);

  if (years.length === 0) return null;

  const { months, years: totals } = data[mode];
  const isDifference = mode === 'difference';
  const subject =
    mode === 'strategy'
      ? 'Strategy'
      : mode === 'benchmark'
        ? benchmarkName
        : `Strategy minus ${benchmarkName}`;
  const spoken = (value: number | undefined) =>
    value === undefined
      ? 'no data'
      : isDifference
        ? formatPp(value)
        : formatPct(value, 1, { sign: true });
  const shown = (value: number | undefined) =>
    value === undefined ? '' : formatNumber(value * 100, 1, { sign: true });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          ariaLabel="Monthly returns of"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'strategy', label: 'Strategy' },
            { value: 'benchmark', label: benchmarkName },
            { value: 'difference', label: 'Difference' },
          ]}
        />
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
          <span>
            {subject} · values in {isDifference ? 'percentage points' : '%'}
          </span>
          <span className="inline-flex items-center gap-1" aria-hidden="true">
            <span className="h-2.5 w-2.5 rounded-sm bg-negative/40" />
            <span className="h-2.5 w-2.5 rounded-sm bg-negative/20" />
            <span className="h-2.5 w-2.5 rounded-sm bg-surface-2" />
            <span className="h-2.5 w-2.5 rounded-sm bg-positive/20" />
            <span className="h-2.5 w-2.5 rounded-sm bg-positive/40" />
            <span className="ml-1">stronger colour = larger move (2 / 5 / 10)</span>
          </span>
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-separate border-spacing-1 text-xs">
          <caption className="sr-only">
            {subject}: monthly returns by year with a yearly total, in{' '}
            {isDifference ? 'percentage points' : 'percent'}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-12 text-left font-medium text-faint">
                Year
              </th>
              {MONTH_LABELS.map((label) => (
                <th key={label} scope="col" className="font-medium text-faint">
                  {label}
                </th>
              ))}
              <th scope="col" className="pl-2 font-semibold text-foreground">
                Year total
              </th>
            </tr>
          </thead>
          <tbody>
            {years.map((year) => {
              const total = totals.get(year);
              return (
                <tr key={year}>
                  <th scope="row" className="text-left font-semibold text-foreground">
                    {year}
                  </th>
                  {MONTH_LABELS.map((label, monthIndex) => {
                    const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
                    const value = months.get(key);
                    return (
                      <td
                        key={key}
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: cells are focusable so a keyboard user can read each month
                        tabIndex={0}
                        aria-label={`${label} ${year}: ${spoken(value)}`}
                        className={cn(
                          'rounded px-1.5 py-2 text-center tabular-nums',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          cellTone(value),
                        )}
                      >
                        {shown(value)}
                      </td>
                    );
                  })}
                  <td
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable like the month cells
                    tabIndex={0}
                    aria-label={`${year} total: ${spoken(total)}`}
                    className={cn(
                      'rounded border border-border px-1.5 py-2 text-center font-semibold tabular-nums',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      cellTone(total),
                    )}
                  >
                    {shown(total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
