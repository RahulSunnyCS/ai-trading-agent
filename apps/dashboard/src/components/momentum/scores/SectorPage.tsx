'use client';

import { useMemo } from 'react';

import { formatInt, formatPct } from '../../../lib/format';
import {
  type BuyZone,
  MOMENTUM_STEP,
  type MomentumScores,
  QUADRANT_LABEL,
  type RotationGroup,
  type SignalMark,
  type StockScore,
  leaderCount,
  meanScores,
  medianReturn,
  rotationEntry,
  shareAboveAverage,
  slugify,
  stocksInGroup,
  stocksInSub,
  strengthRank,
  subBySlug,
} from '../../../lib/momentumScores';
import { Button } from '../../ui/Button';
import { StatCard } from '../../ui/StatCard';
import { QuadrantBadge, RotationPanel } from './RotationPanel';
import { ScoreStrip } from './ScoreStrip';
import { StocksLeaderboard } from './StocksLeaderboard';

const STRIP_WEEKS = [4, 13, 26] as const;

/**
 * One sector group: where it stands and how it has been moving, then its sub-sectors on their
 * own rotation map and its stocks. A sub-sector picked on the map or in its table narrows the
 * stocks to it (`?sub=`); picking it again, or the chip's cross, shows them all.
 */
export function SectorPage({
  data,
  group,
  subSlug,
  zone,
  marks,
  activeSymbol,
  onBack,
  onPickSub,
  onOpenStock,
  onOrder,
  onSector,
}: {
  data: MomentumScores;
  group: RotationGroup;
  subSlug: string | null;
  zone: BuyZone;
  marks: ReadonlyMap<string, SignalMark> | undefined;
  activeSymbol: string | null;
  onBack: () => void;
  /** A sub-sector's slug, or null to clear the filter. */
  onPickSub: (slug: string | null) => void;
  onOpenStock: (symbol: string) => void;
  onOrder: (symbols: string[]) => void;
  onSector: (stock: StockScore) => void;
}) {
  const rotation = data.rotation;
  const parent = group.parent_group;
  const groupStocks = useMemo(() => stocksInGroup(data.stocks, parent), [data.stocks, parent]);
  const subs = useMemo(
    () => (rotation?.subs ?? []).filter((sub) => sub.parent_group === parent),
    [rotation, parent],
  );
  const picked = subBySlug(subs, parent, subSlug);
  const pickedSub = picked?.subgroup ?? null;
  // Memoised: the list below reports its order to a parent that keeps it in state, so a list
  // rebuilt on every render would loop.
  const listed = useMemo(
    () => (pickedSub ? stocksInSub(data.stocks, parent, pickedSub) : groupStocks),
    [data.stocks, parent, pickedSub, groupStocks],
  );
  const stocksOf = useMemo(
    () => (sub: RotationGroup) => stocksInSub(data.stocks, parent, sub.subgroup ?? ''),
    [data.stocks, parent],
  );
  const entry = rotationEntry(group, 4);
  const place = strengthRank(group, rotation?.groups ?? []);
  const topSub = useMemo(() => {
    let best: RotationGroup | null = null;
    for (const sub of subs) {
      const score = sub.s26.at(-1);
      if (score == null || sub.scored_count < 3) continue;
      if (best === null || score > (best.s26.at(-1) ?? 0)) best = sub;
    }
    return best;
  }, [subs]);
  const marketAbove = shareAboveAverage(data.stocks);
  const above = shareAboveAverage(groupStocks);
  const median = medianReturn(groupStocks);

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← All sectors
        </Button>
        <span className="text-faint">›</span>
        <h2 className="font-semibold text-foreground">{parent}</h2>
        <span className="text-muted">
          {formatInt(groupStocks.length)} stocks · {formatInt(subs.length)} sub-sectors
        </span>
      </nav>

      <section aria-label={`${parent} headline`} className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <QuadrantBadge quadrant={entry.quadrant} />
          {entry.changed && entry.before ? (
            <span className="text-xs text-faint">
              was {QUADRANT_LABEL[entry.before]} {MOMENTUM_STEP} weeks ago
            </span>
          ) : null}
          {place ? (
            <span className="ml-auto text-xs text-muted">
              #{place.place} of {place.of} sector groups by 26-week score
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard
            label="Score 4w · 13w · 26w"
            hint="The average 1–10 score of the group's stocks at each lookback."
            value={
              <ScoreStrip scores={meanScores(groupStocks, STRIP_WEEKS)} lookbacks={STRIP_WEEKS} />
            }
            note="average of its stocks"
          />
          <StatCard
            label="Above 40-week average"
            hint="The share of the group's stocks above their own 40-week average."
            value={formatPct(above, 0)}
            note={`market ${formatPct(marketAbove, 0)}`}
          />
          <StatCard
            label="Median 26-week return"
            value={formatPct(median, 1, { sign: true })}
            tone={(median ?? 0) >= 0 ? 'positive' : 'negative'}
            note={`market ${formatPct(medianReturn(data.stocks), 1, { sign: true })}`}
          />
          <StatCard
            label="Leaders in this sector"
            hint="Stocks strong on every horizon (see the trend tag)."
            value={formatInt(leaderCount(groupStocks))}
            note={`of ${formatInt(leaderCount(data.stocks))} in the market`}
          />
          <StatCard
            label="Strongest sub-sector"
            hint="The sub-sector with the highest 26-week score, among those with at least three scored stocks."
            value={
              <span
                className="line-clamp-2 break-words text-base leading-snug"
                title={topSub?.subgroup ?? ''}
              >
                {topSub?.subgroup ?? '—'}
              </span>
            }
            note={topSub ? `${formatInt(topSub.scored_count)} stocks scored` : undefined}
          />
        </div>
      </section>

      <RotationPanel
        groups={subs}
        stocksOf={stocksOf}
        lookbacks={data.lookbacks}
        selectedKey={picked?.key ?? null}
        onSelect={(key) => {
          const sub = subs.find((s) => s.key === key);
          const slug = sub?.subgroup ? slugify(sub.subgroup) : null;
          onPickSub(slug && slug !== subSlug ? slug : null);
        }}
        title={`${parent} sub-sectors`}
        meta="strongest first"
        unit="sub-sector"
        hint="Click a sub-sector to list only its stocks below; click it again to show them all."
      />

      <StocksLeaderboard
        stocks={listed}
        lookbacks={data.lookbacks}
        zone={zone}
        marks={marks}
        scoredCount={data.stocks.length}
        heading={`Stocks in ${parent}`}
        {...(picked?.subgroup
          ? { chip: { label: `Sub-sector: ${picked.subgroup}`, onClear: () => onPickSub(null) } }
          : {})}
        showGroupFilter={false}
        activeSymbol={activeSymbol}
        onOpenStock={onOpenStock}
        onOrder={onOrder}
        onSector={onSector}
      />
    </div>
  );
}
