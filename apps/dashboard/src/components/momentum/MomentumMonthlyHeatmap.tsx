'use client';

import { useMemo } from 'react';

import { cn } from '../../lib/cn';
import type { MomentumSeries } from '../../types/momentum';
import { Card, CardHeader } from '../ui/Card';

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Resamples a weekly cumulative-value series to one return per calendar month. */
function monthlyReturns(dates: string[], values: Array<number | null>): Map<string, number> {
  const lastOfMonth = new Map<string, number>();
  for (let i = 0; i < dates.length; i += 1) {
    const value = values[i];
    const date = dates[i];
    if (value === null || value === undefined || date === undefined) continue;
    const month = date.slice(0, 7);
    lastOfMonth.set(month, value);
  }
  const months = [...lastOfMonth.keys()].sort();
  const returns = new Map<string, number>();
  let previous: number | null = null;
  for (const month of months) {
    const value = lastOfMonth.get(month);
    if (value === undefined) continue;
    if (previous !== null && previous !== 0) returns.set(month, value / previous - 1);
    previous = value;
  }
  return returns;
}

function cellTone(value: number | undefined): string {
  if (value === undefined) return 'bg-surface-2/30 text-faint';
  if (value > 0.04) return 'bg-positive/30 text-positive';
  if (value > 0) return 'bg-positive/12 text-positive';
  if (value > -0.04) return 'bg-negative/12 text-negative';
  return 'bg-negative/30 text-negative';
}

/** Year × month grid of strategy returns, resampled client-side from the weekly series. */
export function MomentumMonthlyHeatmap({ series }: { series: MomentumSeries }) {
  const returns = useMemo(() => monthlyReturns(series.dates, series.strategy), [series]);
  const years = useMemo(() => {
    const set = new Set<string>();
    for (const month of returns.keys()) set.add(month.slice(0, 4));
    return [...set].sort();
  }, [returns]);

  if (years.length === 0) return null;

  return (
    <Card flush>
      <div className="p-5 pb-0">
        <CardHeader title="Monthly returns" description="Strategy return by calendar month" />
      </div>
      <div className="overflow-x-auto px-5 pb-5">
        <table className="w-full min-w-[640px] border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              <th className="w-12 text-left font-medium text-muted">Year</th>
              {MONTH_LABELS.map((label) => (
                <th key={label} className="font-medium text-muted">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {years.map((year) => (
              <tr key={year}>
                <td className="font-semibold text-foreground">{year}</td>
                {MONTH_LABELS.map((_, monthIndex) => {
                  const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
                  const value = returns.get(key);
                  return (
                    <td
                      key={key}
                      className={cn(
                        'rounded px-1.5 py-2 text-center tabular-nums',
                        cellTone(value),
                      )}
                    >
                      {value === undefined ? '' : `${(value * 100).toFixed(1)}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
