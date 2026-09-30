'use client';

import { cn } from '../../lib/cn';
import type { MomentumSavedRun } from '../../types/momentum';
import { Card, CardHeader } from '../ui/Card';

interface MetricDef {
  key: keyof MomentumSavedRun['kpis'];
  label: string;
  format: (value: number) => string;
  /** 'high' = biggest value wins, 'low' = smallest (closest to zero, or most negative is worse). */
  better: 'high' | 'low';
}

const METRICS: MetricDef[] = [
  { key: 'cagr', label: 'CAGR', format: (v) => `${(v * 100).toFixed(1)}%`, better: 'high' },
  {
    key: 'excess_cagr',
    label: 'Edge vs benchmark',
    format: (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pp`,
    better: 'high',
  },
  {
    key: 'max_drawdown',
    label: 'Max drawdown',
    format: (v) => `${(v * 100).toFixed(1)}%`,
    better: 'high',
  },
  { key: 'sharpe', label: 'Sharpe', format: (v) => v.toFixed(2), better: 'high' },
  {
    key: 'turnover_per_year',
    label: 'Churn / year',
    format: (v) => `${(v * 100).toFixed(0)}%`,
    better: 'low',
  },
  { key: 'avg_holdings', label: 'Avg holdings', format: (v) => v.toFixed(1), better: 'high' },
];

/**
 * Side-by-side KPI comparison across saved runs, with the best value in each
 * row highlighted — the "which configuration actually wins" view the flat
 * saved-runs list doesn't give you on its own.
 */
export function MomentumCompare({ runs }: { runs: MomentumSavedRun[] }) {
  if (runs.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Compare runs"
          description="Save a few backtests, then compare them here"
        />
        <p className="text-sm text-muted">No saved runs yet for this strategy.</p>
      </Card>
    );
  }

  function bestIndex(metric: MetricDef): number | null {
    const best = runs.reduce<{ index: number; value: number } | null>((current, run, index) => {
      const value = run.kpis[metric.key];
      if (typeof value !== 'number' || !Number.isFinite(value)) return current;
      const score = metric.better === 'high' ? value : -Math.abs(value);
      return !current || score > current.value ? { index, value: score } : current;
    }, null);
    return best ? best.index : null;
  }

  return (
    <Card flush>
      <div className="p-5 pb-0">
        <CardHeader title="Compare runs" description="Best value in each row is highlighted" />
      </div>
      <div className="overflow-x-auto px-5 pb-5">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="py-2 pr-3 font-medium">Metric</th>
              {runs.map((run) => (
                <th key={run.id} className="px-3 py-2 font-medium text-foreground">
                  {run.name || `Run ${run.n}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map((metric) => {
              const winner = bestIndex(metric);
              return (
                <tr key={metric.key} className="border-b border-border/60">
                  <td className="py-2 pr-3 text-xs text-muted">{metric.label}</td>
                  {runs.map((run, index) => {
                    const value = run.kpis[metric.key];
                    return (
                      <td
                        key={run.id}
                        className={cn(
                          'px-3 py-2 text-right font-medium tabular-nums',
                          index === winner
                            ? 'rounded bg-primary/12 text-primary'
                            : 'text-foreground',
                        )}
                      >
                        {typeof value === 'number' ? metric.format(value) : '—'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
