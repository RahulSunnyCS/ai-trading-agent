'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useMemo } from 'react';

import {
  formatInr,
  formatIstDateTimeShort,
  formatNumber,
  formatPct,
  formatPp,
} from '../../../lib/format';
import {
  drawdownSeries,
  listSettings,
  runBenchmark,
  runPeriod,
  seriesEnds,
} from '../../../lib/momentumCompare';
import type { MomentumSavedRun, MomentumSeries } from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { StatCard } from '../../ui/StatCard';
import { MomentumEquityChart } from '../MomentumEquityChart';

/**
 * The chart's series built from what a saved run stores: its weekly portfolio values, with the
 * drawdown derived from them. The benchmark, liquid-fund and 52-week-edge lines are not stored
 * with a saved run, so they are empty.
 */
function storedSeries(run: MomentumSavedRun): MomentumSeries {
  const blank = run.dates.map(() => null);
  return {
    dates: run.dates,
    strategy: run.strategy,
    benchmark: blank,
    cash: blank,
    drawdown_strategy: drawdownSeries(run.strategy),
    drawdown_benchmark: blank,
    rolling_52w_excess: blank,
    idle_share: blank,
    holdings_count: blank,
  };
}

function tone(value: number | null | undefined): 'default' | 'positive' | 'negative' {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 'default';
  return value > 0 ? 'positive' : 'negative';
}

/**
 * Read-only view of a saved run: what was stored when it was saved, shown without re-running.
 * That is the six headline figures, the strategy's equity line and the full settings.
 */
export function SavedRunViewer({
  run,
  onClose,
  onLoad,
}: {
  /** The run to show; null closes the dialog. */
  run: MomentumSavedRun | null;
  onClose: () => void;
  onLoad: (run: MomentumSavedRun) => void;
}) {
  const series = useMemo(() => (run ? storedSeries(run) : null), [run]);
  const ends = run ? seriesEnds(run.strategy) : null;
  const settings = run ? listSettings(run.config) : [];
  const k = run?.kpis ?? {};

  return (
    <Dialog.Root open={run !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[min(1100px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-6 shadow-elevated">
          {run ? (
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Dialog.Title className="flex flex-wrap items-center gap-2 text-base font-semibold tracking-tight text-foreground">
                    {run.name || `Run ${run.n}`}
                    {run.active ? (
                      <Badge tone="primary" dot>
                        Active
                      </Badge>
                    ) : null}
                    {run.favorite ? <Badge tone="accent">Favourite</Badge> : null}
                  </Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-xs text-muted">
                    Stored result, not re-run · saved {formatIstDateTimeShort(run.created_at)} ·{' '}
                    {runPeriod(run.config)} · benchmark {runBenchmark(run.config)}
                  </Dialog.Description>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" onClick={() => onLoad(run)}>
                    Load settings
                  </Button>
                  <Dialog.Close asChild>
                    <Button size="icon" variant="ghost" aria-label="Close">
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </Dialog.Close>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                <StatCard
                  label="₹1 lakh became"
                  value={
                    ends && ends.first > 0
                      ? formatInr((ends.last / ends.first) * 100_000, { compact: true })
                      : formatInr(null)
                  }
                />
                <StatCard label="CAGR" value={formatPct(k.cagr)} />
                <StatCard
                  label="Edge vs benchmark"
                  value={formatPp(k.excess_cagr)}
                  tone={tone(k.excess_cagr)}
                />
                <StatCard label="Max drawdown" value={formatPct(k.max_drawdown)} tone="negative" />
                <StatCard label="Sharpe" value={formatNumber(k.sharpe, 2)} />
                <StatCard label="Turnover / year" value={formatPct(k.turnover_per_year, 0)} />
                <StatCard label="Avg holdings" value={formatNumber(k.avg_holdings, 1)} />
              </div>

              {series && ends ? (
                <MomentumEquityChart
                  series={series}
                  benchmarkName={runBenchmark(run.config)}
                  rotations={[]}
                />
              ) : (
                <p className="text-sm text-muted">This run was saved without an equity series.</p>
              )}
              <p className="text-xs text-muted">
                A saved run keeps the strategy&apos;s weekly value, these headline figures and its
                settings. The benchmark line, trades, yearly table and holdings are not stored: load
                the settings and run it again to see them.
              </p>

              <section>
                <h3 className="mb-2 text-sm font-semibold text-foreground">
                  Settings ({settings.length})
                </h3>
                <dl className="grid gap-x-8 sm:grid-cols-2">
                  {settings.map((row) => (
                    <div
                      key={row.key}
                      className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-xs"
                    >
                      <dt className="text-muted">{row.label}</dt>
                      <dd className="min-w-0 break-words text-right font-medium text-foreground">
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
