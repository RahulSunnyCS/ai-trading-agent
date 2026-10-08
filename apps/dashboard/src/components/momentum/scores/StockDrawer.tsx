'use client';

import type { ReactNode } from 'react';

import { usePolledResource } from '../../../hooks/usePolledResource';
import { EMPTY, formatInr, formatInt, formatPct } from '../../../lib/format';
import {
  type BuyZone,
  type SignalMark,
  type StockDetail,
  type StockScore,
  markKey,
  rankChange,
  rankInGroup,
  stocksInSub,
  trendOf,
} from '../../../lib/momentumScores';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Skeleton } from '../../ui/Skeleton';
import { StateMessage } from '../../ui/StateMessage';
import { TrendBadge } from './ScoreStrip';
import { PriceChart, RankChart, ScoreHistoryGrid, Stat } from './StockCharts';

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
        {title}
        {note ? <span className="text-xs font-normal text-faint">{note}</span> : null}
      </h4>
      {children}
    </section>
  );
}

/** The history charts: fetched when the drawer opens, so the page's own payload stays small. */
function History({
  symbol,
  lookbacks,
  zone,
}: {
  symbol: string;
  lookbacks: readonly number[];
  zone: BuyZone;
}) {
  const { data, loading, error, refetch } = usePolledResource<StockDetail>(
    `/api/momentum/scores/stock/${encodeURIComponent(symbol)}`,
    { cache: true },
  );
  if (error)
    return (
      <div className="space-y-2">
        <StateMessage
          variant="error"
          title="Couldn't load this stock's history"
          description={error}
        />
        <Button size="sm" onClick={refetch}>
          Retry
        </Button>
      </div>
    );
  if (loading && !data) return <Skeleton className="h-64 w-full" />;
  if (!data) return null;
  return (
    <div className="space-y-5">
      <Section title="Price, 52 weeks" note="dashed: 40-week average">
        <PriceChart weeks={data.weeks} closes={data.closes} ma40={data.ma40} />
      </Section>
      <Section title="Score history" note="1–10 by lookback, one column per week">
        <ScoreHistoryGrid weeks={data.score_weeks} scores={data.scores} lookbacks={lookbacks} />
      </Section>
      <Section title="Rank, 26 weeks" note="1 is the strongest; log scale">
        <RankChart weeks={data.rank_weeks} ranks={data.ranks} zone={zone} />
      </Section>
    </div>
  );
}

/**
 * One stock, opened from any list: its price with the 40-week average, how its scores built up
 * week by week, where its rank stands against the strategy's buy and exit ranks, and the figures
 * a momentum investor checks. Prev and next step through the list it was opened from.
 */
export function StockDrawer({
  symbol,
  stocks,
  order,
  lookbacks,
  zone,
  marks,
  onOpen,
  onClose,
  onSector,
  onBacktest,
}: {
  symbol: string | null;
  stocks: readonly StockScore[];
  /** Symbols in the order of the list the drawer was opened from. */
  order: readonly string[];
  lookbacks: readonly number[];
  zone: BuyZone;
  marks: ReadonlyMap<string, SignalMark> | undefined;
  onOpen: (symbol: string) => void;
  onClose: () => void;
  onSector: (stock: StockScore) => void;
  onBacktest: () => void;
}) {
  const stock = symbol ? (stocks.find((s) => s.symbol === symbol) ?? null) : null;
  const at = symbol ? order.indexOf(symbol) : -1;
  const prev = at > 0 ? order[at - 1] : undefined;
  const next = at >= 0 ? order[at + 1] : undefined;
  const mark = stock ? marks?.get(markKey(stock.symbol)) : undefined;
  const peers = stock ? stocksInSub(stocks, stock.parent_group, stock.subgroup) : [];
  const place = stock ? rankInGroup(stock, peers) : null;
  const change = stock ? rankChange(stock) : null;
  // The ranking covers only stocks with a full year of prices, not every scored stock.
  const rankedCount = stocks.reduce((n, s) => n + (s.composite_rank == null ? 0 : 1), 0);

  return (
    <Drawer
      open={symbol !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base">{symbol ?? ''}</span>
          {stock ? <TrendBadge trend={trendOf(stock)} /> : null}
          {mark === 'held' ? <Badge tone="primary">Held</Badge> : null}
          {mark === 'candidate' ? <Badge tone="info">Candidate</Badge> : null}
        </span>
      }
      subtitle={
        stock
          ? `${stock.company_name} · ${stock.subgroup || EMPTY} · ${stock.parent_group || EMPTY}`
          : undefined
      }
      closeLabel="Close stock"
      footer={
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <Button size="sm" disabled={!prev} onClick={() => prev && onOpen(prev)}>
            ← Prev
          </Button>
          <Button size="sm" disabled={!next} onClick={() => next && onOpen(next)}>
            Next →
          </Button>
          <span className="flex-1" />
          {stock?.subgroup ? (
            <Button size="sm" variant="secondary" onClick={() => onSector(stock)}>
              Open its sector
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={onBacktest}>
            Open in backtest
          </Button>
        </div>
      }
    >
      {symbol && !stock ? (
        <StateMessage
          variant="empty"
          title={`${symbol} is not scored this week`}
          description="It may have left the universe, or the symbol in the link is wrong."
        />
      ) : stock ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="metric text-2xl font-semibold text-foreground">
              {formatInr(stock.last_price, { dp: 2, trim: true })}
            </span>
            <span
              className={`metric text-sm ${(stock.change_1w_pct ?? 0) >= 0 ? 'text-positive' : 'text-negative'}`}
            >
              {formatPct(stock.change_1w_pct, 2, { sign: true })} this week
            </span>
            <span className="text-sm text-muted">
              Rank <b className="metric text-foreground">{stock.composite_rank ?? EMPTY}</b>
              {stock.composite_rank != null ? ` of ${formatInt(rankedCount)}` : ''}
              {change ? (
                <span className={change > 0 ? ' text-positive' : ' text-negative'}>
                  {' '}
                  {change > 0 ? '▲' : '▼'}
                  {Math.abs(change)}
                </span>
              ) : null}
            </span>
          </div>
          <History key={stock.symbol} symbol={stock.symbol} lookbacks={lookbacks} zone={zone} />
          <section aria-label="Figures" className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            <Stat
              label="13-week return"
              value={formatPct(stock.returns['13'], 1, { sign: true })}
            />
            <Stat
              label="26-week return"
              value={formatPct(stock.returns['26'], 1, { sign: true })}
            />
            <Stat
              label="From 52-week high"
              value={
                stock.high_52w_gap == null
                  ? EMPTY
                  : stock.high_52w_gap > -0.0005
                    ? 'at high'
                    : formatPct(stock.high_52w_gap, 1)
              }
            />
            <Stat
              label="Above 40-week average"
              value={formatPct(stock.above_ma40, 1, { sign: true })}
            />
            <Stat label="Volatility (annual)" value={formatPct(stock.volatility_52w, 0)} />
            <Stat label="Up weeks, last 26" value={formatPct(stock.up_weeks_26, 0)} />
            <Stat
              label={`Rank in ${stock.subgroup || 'its sector'}`}
              value={place ? `${place.place} of ${place.of}` : EMPTY}
            />
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
