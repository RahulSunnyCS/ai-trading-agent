'use client';

/**
 * The F&O headline strip: five tiles against the picked benchmark, the benchmark picker, and the
 * secondary line that never wraps. A target pace has a figure for net profit and return only, and
 * the other tiles say so; last FY (to the same calendar day) compares every tile.
 */

import { cn } from '../../lib/cn';
import { EMPTY, formatInr, formatInt, formatPct, formatPp } from '../../lib/format';
import {
  type Benchmark,
  TARGET_RATES,
  type Tile,
  benchmarkKey,
  gapTone,
  parseBenchmark,
} from '../../lib/tradeBookView';
import type { TradeBookRatios, TradeBookSummaryBlock } from '../../types/tradeBook';
import { Badge } from '../ui/Badge';
import { RadioMenu } from '../ui/RadioMenu';

function tileValue(tile: Tile): string {
  if (tile.value === null) return EMPTY;
  return tile.unit === 'inr'
    ? formatInr(tile.value)
    : formatPct(tile.value, tile.id === 'return' ? 1 : 0, { unit: 'percent' });
}

function gapText(tile: Tile): string {
  if (tile.gap === null) return EMPTY;
  return tile.unit === 'inr'
    ? formatInr(tile.gap, { sign: true })
    : formatPp(tile.gap, 1, { unit: 'percent' });
}

function benchText(tile: Tile, benchmark: Benchmark): string {
  if (tile.bench === null) return '';
  const word = benchmark.id === 'pace' ? 'target' : 'last FY';
  return `${word} ${tile.unit === 'inr' ? formatInr(tile.bench) : formatPct(tile.bench, 1, { unit: 'percent' })}`;
}

function tileDetail(tile: Tile, s: TradeBookSummaryBlock): string | null {
  if (tile.id === 'drawdown') {
    return s.max_drawdown_pct === null
      ? null
      : `${formatPct(s.max_drawdown_pct, 1, { unit: 'percent' })} of capital`;
  }
  if (tile.id === 'charges') return formatInr(s.charges);
  if (tile.id === 'win') return `${s.win_days} won · ${s.loss_days} lost`;
  return null;
}

export function TradeBookHeadline({
  summary,
  ratios,
  tiles,
  benchmark,
  onBenchmark,
  lastYearAvailable,
  lastYearLabel,
}: {
  summary: TradeBookSummaryBlock;
  ratios: TradeBookRatios | null;
  tiles: Tile[];
  benchmark: Benchmark;
  onBenchmark: (b: Benchmark) => void;
  lastYearAvailable: boolean;
  lastYearLabel: string;
}) {
  const options = [
    ...TARGET_RATES.map((rate) => ({
      value: `pace${rate}`,
      label: `Target pace ${rate}% a year`,
    })),
    {
      value: 'lastfy',
      label: `Last FY (${lastYearLabel})`,
      disabled: !lastYearAvailable,
      title: lastYearAvailable ? undefined : 'No notes stored for the year before',
    },
  ];
  const benchLabel =
    benchmark.id === 'pace' ? `Target pace ${benchmark.ratePct}%` : 'Last FY to the same day';
  return (
    <section
      aria-label="Headline"
      className="overflow-hidden rounded-xl border border-border bg-surface shadow-card"
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => {
          const detail = tileDetail(tile, summary);
          const tone = gapTone(tile);
          return (
            <div
              key={tile.id}
              className="min-w-0 border-b border-r border-border px-4 py-3 xl:border-b-0"
            >
              <p className="truncate text-xs text-faint">{tile.label}</p>
              <p
                className={cn(
                  'metric mt-0.5 truncate text-2xl font-medium tracking-tight',
                  tile.tone === 'positive' && 'text-positive',
                  tile.tone === 'negative' && 'text-negative',
                  tile.tone === 'neutral' && 'text-foreground',
                )}
              >
                {tileValue(tile)}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted">
                {tile.gap !== null ? (
                  <Badge tone={tone === 'neutral' ? 'neutral' : tone} className="shrink-0">
                    {gapText(tile)}
                  </Badge>
                ) : null}
                {detail ? <span className="truncate">{detail}</span> : null}
                {tile.bench !== null ? (
                  <span className="truncate">{benchText(tile, benchmark)}</span>
                ) : (
                  <span className="truncate text-faint">
                    {benchmark.id === 'pace' ? 'no target figure' : 'no last-FY figure'}
                  </span>
                )}
              </p>
            </div>
          );
        })}
        <div className="col-span-2 min-w-0 border-b border-border px-4 py-3 sm:col-span-1 xl:border-b-0">
          <p className="text-xs text-faint">Compare with</p>
          <div className="mt-1">
            <RadioMenu
              ariaLabel={`Benchmark: ${benchLabel}. Change benchmark`}
              value={benchmarkKey(benchmark)}
              valueLabel={benchLabel}
              options={options}
              onChange={(v) => onBenchmark(parseBenchmark(v))}
              heading="Compare the year with"
              footer="A target pace has a figure for net profit and return only. Last FY compares every tile, to the same calendar day."
            />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-x-5 overflow-hidden whitespace-nowrap border-t border-border px-4 py-2 text-xs text-muted [mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)]">
        <span>
          Avg day <span className="metric text-foreground">{formatInr(summary.avg_day)}</span>
        </span>
        <span>
          avg win <span className="metric text-foreground">{formatInr(summary.avg_win)}</span>
        </span>
        <span>
          avg loss <span className="metric text-foreground">{formatInr(summary.avg_loss)}</span>
        </span>
        <span>
          best <span className="metric text-foreground">{formatInr(summary.best)}</span>
        </span>
        <span>
          worst <span className="metric text-foreground">{formatInr(summary.worst)}</span>
        </span>
        <span title="The most sessions in a row spent below the running peak">
          longest drawdown{' '}
          <span className="metric text-foreground">
            {formatInt(summary.longest_drawdown)} sessions
          </span>
        </span>
        <span>
          100-day avg profit{' '}
          <span className="metric text-foreground">{formatInr(ratios?.avg_profit_100)}</span>
        </span>
        <span>
          profit/capital{' '}
          <span className="metric text-foreground">
            {ratios?.profit_capital_bps == null
              ? EMPTY
              : `${formatInt(ratios.profit_capital_bps)} bps/day`}
          </span>
        </span>
        <span>
          sessions <span className="metric text-foreground">{formatInt(summary.sessions)}</span>
        </span>
        <span>
          algo fees <span className="metric text-foreground">{formatInr(summary.algo_fees)}</span>
        </span>
        <span>
          collateral interest{' '}
          <span className="metric text-foreground">{formatInr(summary.interest)}</span>
        </span>
        <span title="DP, AMC and other debits no note or e-mail shows: an estimate of ₹1,000 per broker a year">
          other debits (est.){' '}
          <span className="metric text-foreground">{formatInr(summary.other_debits)}</span>
        </span>
        <span>
          net after both{' '}
          <span className="metric text-foreground">{formatInr(summary.net_after_debits)}</span>
        </span>
      </div>
    </section>
  );
}
