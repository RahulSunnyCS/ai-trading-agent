/**
 * PnlView — realized P&L aggregates, risk metrics, charts and a per-personality table.
 *
 * Data source: the shared usePaperTrades hook (polled from GET /api/trades) —
 * TradesView and PnlView consume the same hook to avoid duplicate fetches.
 *
 * A range control (7D / 30D / 90D / All, kept in the query string as ?range=30d) limits every
 * figure and chart to closed trades whose IST exit day falls in the window; open positions are
 * "now" and always counted.
 *
 * Honesty constraints: the headline is "Realized P&L (closed trades)"; open
 * positions are a separate count (we never invent an unrealized number); the
 * error state never renders as flat 0.00 (it hides the metrics so a fetch
 * failure can't be misread as a no-activity day).
 */

import { useMemo } from 'react';

import { TRADES_WINDOW_CAPTION, usePaperTrades } from '../hooks/usePaperTrades';
import { usePersonalities } from '../hooks/usePersonalities';
import { useQueryState } from '../hooks/useQueryState';
import { EMPTY, formatDay, formatInr, formatInt, formatMultiple, formatPct } from '../lib/format';
import {
  type PnlRange,
  computePersonalityPnl,
  computePnlStats,
  computePnlSummary,
  filterTradesByRange,
  findClockwork,
  parsePnlRange,
} from '../lib/pnl';
import { PersonalityPnlTable } from './pnl/PersonalityPnlTable';
import { CumulativePnlChart, DailyPnlChart } from './pnl/PnlCharts';
import { Card, CardHeader } from './ui/Card';
import { SegmentedControl } from './ui/SegmentedControl';
import { SkeletonRows } from './ui/Skeleton';
import { StatCard } from './ui/StatCard';
import { StateMessage } from './ui/StateMessage';
import { Toolbar } from './ui/Toolbar';

const RANGE_OPTIONS = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: 'all', label: 'All' },
] as const;

const RANGE_TEXT: Record<PnlRange, string> = {
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  all: TRADES_WINDOW_CAPTION.toLowerCase(),
};

function pnlTone(value: number | null): 'positive' | 'negative' | 'muted' {
  if (value === null || value === 0) return 'muted';
  return value > 0 ? 'positive' : 'negative';
}

/** Signed rupees that never wrap between the sign and the amount. */
const money = (value: number | null) => (
  <span className="whitespace-nowrap">{formatInr(value, { dp: 2, sign: true })}</span>
);

export function PnlView() {
  const { trades, loading, error } = usePaperTrades();
  const { personalities } = usePersonalities(true);
  const [rangeParam, setRangeParam] = useQueryState('range');
  const range = parsePnlRange(rangeParam);

  const inRange = useMemo(() => filterTradesByRange(trades, range), [trades, range]);
  const summary = useMemo(() => computePnlSummary(inRange), [inRange]);
  const stats = useMemo(() => computePnlStats(inRange), [inRange]);
  const byPersonality = useMemo(
    () => computePersonalityPnl(inRange, personalities),
    [inRange, personalities],
  );
  const clockwork = findClockwork(personalities);
  const hasClosed = summary.closedCount > 0;
  const anyClosed = useMemo(() => trades.some((t) => t.status === 'closed'), [trades]);
  const rangeText = RANGE_TEXT[range];

  const profitFactorText =
    stats.profitFactor !== null
      ? formatMultiple(stats.profitFactor, 2)
      : stats.wins > 0
        ? 'No losses'
        : EMPTY;

  return (
    <div className="space-y-5">
      {trades.length > 0 ? (
        <Toolbar ariaLabel="P&L range">
          <SegmentedControl
            ariaLabel="Date range"
            size="sm"
            value={range}
            options={RANGE_OPTIONS}
            onChange={(next) => setRangeParam(next === 'all' ? null : next)}
          />
          <span className="text-xs text-muted">
            Closed trades by IST exit day · {TRADES_WINDOW_CAPTION.toLowerCase()}
          </span>
        </Toolbar>
      ) : null}

      {loading && trades.length === 0 && (
        <Card>
          <CardHeader title="P&L Summary" />
          <SkeletonRows rows={4} />
        </Card>
      )}

      {error !== null && (
        <StateMessage
          variant="error"
          title="Couldn't load P&L data — retrying…"
          description={error}
        />
      )}

      {!loading && error === null && !hasClosed && (
        <Card>
          <CardHeader title="P&L Summary" />
          <StateMessage
            variant="empty"
            title={anyClosed ? `No closed trades in the ${rangeText}` : 'No closed trades yet'}
            description={
              anyClosed
                ? 'Choose a longer range to see earlier trades.'
                : summary.openCount > 0
                  ? `Realized P&L appears once a position closes. ${summary.openCount} open position${summary.openCount !== 1 ? 's' : ''} currently running.`
                  : 'Realized P&L will appear once the first position is closed.'
            }
          />
        </Card>
      )}

      {hasClosed && (
        <>
          {/* Hero realized P&L */}
          <Card>
            <p className="text-xs font-medium uppercase tracking-wider text-faint">
              Realized P&L · closed trades · {rangeText}
            </p>
            <p
              className={`metric mt-1 text-4xl font-semibold tracking-tight ${
                summary.totalRealizedPnl > 0
                  ? 'text-positive'
                  : summary.totalRealizedPnl < 0
                    ? 'text-negative'
                    : 'text-foreground'
              }`}
            >
              {money(summary.totalRealizedPnl)}
            </p>
            <p className="mt-1 text-sm text-muted">
              Across {formatInt(summary.closedCount)} closed trade
              {summary.closedCount !== 1 ? 's' : ''} · {formatPct(summary.winRate, 1)} win rate
            </p>
          </Card>

          {/* Secondary metrics — win rate and closed count live in the hero only. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Today's P&L (IST)"
              value={money(summary.todayRealizedPnl)}
              tone={pnlTone(summary.todayRealizedPnl)}
            />
            <StatCard
              label="Open positions"
              value={formatInt(summary.openCount)}
              note="Now · unrealized P&L not shown"
              tone="muted"
            />
            <StatCard
              label="Max drawdown"
              value={
                <span className="whitespace-nowrap">
                  {formatInr(-stats.maxDrawdown.amount || 0, { dp: 2 })}
                </span>
              }
              tone={stats.maxDrawdown.amount > 0 ? 'negative' : 'muted'}
              note={
                stats.maxDrawdown.troughDay
                  ? `Low on ${formatDay(stats.maxDrawdown.troughDay)}`
                  : 'No drawdown in range'
              }
              hint="The largest fall in end-of-day cumulative P&L from its running high (starting from zero) within the range."
            />
            <StatCard
              label="Profit factor"
              value={profitFactorText}
              tone={
                stats.profitFactor === null
                  ? 'muted'
                  : stats.profitFactor >= 1
                    ? 'positive'
                    : 'negative'
              }
              hint="Gross profit of winning trades divided by the gross loss of losing trades. Above 1× means winners outweigh losers."
            />
            <StatCard
              label="Avg win / loss"
              value={
                <span className="text-xl">
                  <span className="text-positive">{money(stats.avgWin)}</span>
                  <span className="text-faint"> / </span>
                  <span className="text-negative">{money(stats.avgLoss)}</span>
                </span>
              }
              note={`${formatInt(stats.wins)} wins · ${formatInt(stats.losses)} losses`}
            />
            <StatCard
              label="Expectancy"
              value={money(stats.expectancy)}
              tone={pnlTone(stats.expectancy)}
              note="Per closed trade"
              hint="Average net P&L per closed trade in the range."
            />
            <StatCard
              label="Best day"
              value={money(stats.bestDay?.value ?? null)}
              tone={pnlTone(stats.bestDay?.value ?? null)}
              note={stats.bestDay ? formatDay(stats.bestDay.time) : undefined}
            />
            <StatCard
              label="Worst day"
              value={money(stats.worstDay?.value ?? null)}
              tone={pnlTone(stats.worstDay?.value ?? null)}
              note={stats.worstDay ? formatDay(stats.worstDay.time) : undefined}
            />
          </div>

          {/* Cumulative line + daily bars */}
          <Card>
            <CardHeader
              title="Cumulative Realized P&L"
              description={`Running net across closed trades, one point per IST day · ${rangeText}`}
            />
            <CumulativePnlChart series={summary.cumulativeSeries} />
            <h3 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wider text-faint">
              Daily net P&L
            </h3>
            <DailyPnlChart daily={stats.daily} />
          </Card>

          {/* Per personality */}
          <Card flush>
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                By personality
              </h2>
              <p className="mt-0.5 text-xs text-muted">
                Closed trades · {rangeText}
                {clockwork === null
                  ? ' · Beat-Clockwork Δ needs the Clockwork personality, which was not found'
                  : byPersonality.some((row) => row.isClockwork)
                    ? ''
                    : ' · Clockwork closed no trade in this range, so there is no Δ'}
              </p>
            </div>
            <div className="px-2 py-1">
              <PersonalityPnlTable rows={byPersonality} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
