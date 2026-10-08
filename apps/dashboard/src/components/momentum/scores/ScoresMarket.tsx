import { EMPTY, formatInt, formatNumber, formatPct, formatPp } from '../../../lib/format';
import {
  type Breadth,
  type BuyZone,
  type SectorScore,
  type SignalMark,
  type StockScore,
  computeMovers,
  leaderCount,
  markKey,
  rankChange,
  stockDecile,
  topSector,
} from '../../../lib/momentumScores';
import { Badge } from '../../ui/Badge';
import { StatCard } from '../../ui/StatCard';
import { ScoreStrip } from './ScoreStrip';

/** A share's change against an earlier one, in points: "+4 pp vs last week". */
function shareChange(now: number | null | undefined, before: number | null | undefined): string {
  return now == null || before == null ? '' : formatPp(now - before);
}

/**
 * The market's momentum at a glance: how wide it is (the share of stocks above their 40-week
 * average and up over 13 weeks), how strong, how many leaders and the strongest sub-sector.
 * Momentum works when most stocks are trending, so this comes before any single name.
 */
export function ScoresMarketStrip({
  asOf,
  universe,
  breadth,
  stocks,
  sectors,
}: {
  asOf: string | null;
  universe: number;
  breadth: Breadth | null | undefined;
  stocks: readonly StockScore[];
  sectors: readonly SectorScore[];
}) {
  const leaders = leaderCount(stocks);
  const sector = topSector(sectors);
  return (
    <section aria-label="Market momentum" className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-faint">
        Market momentum · {formatInt(universe)} stocks{asOf ? ` · week ending ${asOf}` : ''}
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label="Above 40-week average"
          hint="The share of scored stocks whose close is above their own 40-week average. Momentum works best when most of the market is trending."
          value={formatPct(breadth?.above_ma40.now, 0)}
          note={
            breadth
              ? `${shareChange(breadth.above_ma40.now, breadth.above_ma40.week_ago)} vs last week · ${formatPct(breadth.above_ma40.month_ago, 0)} 4 weeks ago`
              : undefined
          }
        />
        <StatCard
          label="Up over 13 weeks"
          hint="The share of scored stocks with a positive 13-week return."
          value={formatPct(breadth?.positive_13w.now, 0)}
          note={
            breadth
              ? `${shareChange(breadth.positive_13w.now, breadth.positive_13w.week_ago)} vs last week`
              : undefined
          }
        />
        <StatCard
          label="Median 26-week return"
          hint="The middle stock's return over 26 weeks. The top-decile figure is where the strongest tenth begins."
          value={formatPct(breadth?.median_26w, 1, { sign: true })}
          tone={(breadth?.median_26w ?? 0) >= 0 ? 'positive' : 'negative'}
          note={`top decile from ${formatPct(breadth?.top_decile_26w, 1, { sign: true })}`}
        />
        <StatCard
          label="Leaders"
          hint="Stocks that are strong on every horizon: 13 and 26-week decile 8 or more, and 4-week decile 7 or more."
          value={formatInt(leaders)}
          note="strong on 4, 13 and 26 weeks"
        />
        <StatCard
          label="Strongest sub-sector"
          hint="The sub-sector with the highest average 26-week score, among those with at least five scored stocks. Theme baskets are not counted."
          value={
            <span
              className="line-clamp-2 break-words text-base leading-snug"
              title={sector?.subgroup}
            >
              {sector ? sector.subgroup : EMPTY}
            </span>
          }
          note={
            sector
              ? `score ${formatNumber(sector.scores['26'], 0)} · ${formatInt(sector.qualifying_count)} stocks`
              : undefined
          }
        />
      </div>
    </section>
  );
}

function MoverRow({
  stock,
  mark,
  detail,
}: {
  stock: StockScore;
  mark: SignalMark | undefined;
  detail: 'climb' | 'strip';
}) {
  const change = rankChange(stock);
  return (
    <li className="flex h-8 items-center gap-2 text-sm">
      <span className="w-28 shrink-0 truncate font-medium text-foreground">{stock.symbol}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted" title={stock.subgroup}>
        {stock.subgroup}
      </span>
      {mark === 'held' ? <Badge tone="primary">Held</Badge> : null}
      {detail === 'strip' ? (
        <ScoreStrip
          scores={Object.fromEntries(
            [4, 13, 26].map((weeks) => [String(weeks), stock.scores[String(weeks)] ?? null]),
          )}
          lookbacks={[4, 13, 26].filter((weeks) => stockDecile(stock, weeks) !== null)}
        />
      ) : (
        <span className="metric shrink-0 whitespace-nowrap text-xs text-muted">
          {stock.composite_rank_prev} →{' '}
          <span className="text-foreground">{stock.composite_rank}</span>{' '}
          <span className={(change ?? 0) >= 0 ? 'text-positive' : 'text-negative'}>
            {(change ?? 0) >= 0 ? '▲' : '▼'}
            {Math.abs(change ?? 0)}
          </span>
        </span>
      )}
    </li>
  );
}

function MoversCard({
  title,
  hint,
  stocks,
  marks,
  detail,
}: {
  title: string;
  hint: string;
  stocks: readonly StockScore[];
  marks: ReadonlyMap<string, SignalMark> | undefined;
  detail: 'climb' | 'strip';
}) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-card">
      <header className="mb-2 flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="min-w-0 truncate text-xs text-faint">{hint}</p>
      </header>
      {stocks.length ? (
        <ul>
          {stocks.map((stock) => (
            <MoverRow
              key={stock.symbol}
              stock={stock}
              mark={marks?.get(markKey(stock.symbol))}
              detail={detail}
            />
          ))}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted">None this week.</p>
      )}
    </section>
  );
}

/** What changed this week: the biggest climbers, and who crossed the strategy's exit rank. */
export function ScoresMovers({
  stocks,
  zone,
  marks,
}: {
  stocks: readonly StockScore[];
  zone: BuyZone;
  marks: ReadonlyMap<string, SignalMark> | undefined;
}) {
  const movers = computeMovers(stocks, zone);
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <MoversCard
        title="Biggest climbers"
        hint="places gained in the ranking this week"
        stocks={movers.climbers}
        marks={marks}
        detail="climb"
      />
      <MoversCard
        title={`Entered the top ${zone.exitRank}`}
        hint="new candidates for the strategy"
        stocks={movers.entered}
        marks={marks}
        detail="strip"
      />
      <MoversCard
        title={`Fell out of the top ${zone.exitRank}`}
        hint="worth a look if you hold them"
        stocks={movers.dropped}
        marks={marks}
        detail="climb"
      />
    </div>
  );
}
