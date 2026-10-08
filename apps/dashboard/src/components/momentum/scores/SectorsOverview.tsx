'use client';

import { useMemo } from 'react';

import {
  type BuyZone,
  type MomentumScores,
  type RotationGroup,
  type SignalMark,
  type StockScore,
  slugify,
  stocksInGroup,
} from '../../../lib/momentumScores';
import { RotationPanel } from './RotationPanel';
import { ScoresMovers } from './ScoresMarket';
import { StocksLeaderboard } from './StocksLeaderboard';

/** How many of the strongest stocks the Sectors view shows before sending you to the full list. */
const TOP_STOCKS = 10;

/**
 * The default Scores view, under the market strip: the rotation map of the sector groups with
 * its table, what changed this week, and the strongest stocks. Clicking a group opens its page.
 */
export function SectorsOverview({
  data,
  zone,
  marks,
  activeSymbol,
  onOpenGroup,
  onShowAllStocks,
  onOpenStock,
  onOrder,
  onSector,
}: {
  data: MomentumScores;
  zone: BuyZone;
  marks: ReadonlyMap<string, SignalMark> | undefined;
  activeSymbol: string | null;
  /** A group's slug. */
  onOpenGroup: (slug: string) => void;
  onShowAllStocks: () => void;
  onOpenStock: (symbol: string) => void;
  onOrder: (symbols: string[]) => void;
  onSector: (stock: StockScore) => void;
}) {
  const groups = data.rotation?.groups ?? [];
  const stocksOf = useMemo(
    () => (group: RotationGroup) => stocksInGroup(data.stocks, group.parent_group),
    [data.stocks],
  );
  return (
    <div className="space-y-4">
      <RotationPanel
        groups={groups}
        stocksOf={stocksOf}
        lookbacks={data.lookbacks}
        selectedKey={null}
        onSelect={(key) => onOpenGroup(slugify(key))}
        title="Sector groups"
        meta="strongest first"
        unit="group"
        hint="Click a group to see its sub-sectors and its stocks."
      />
      <ScoresMovers stocks={data.stocks} zone={zone} marks={marks} />
      <StocksLeaderboard
        stocks={data.stocks}
        lookbacks={data.lookbacks}
        zone={zone}
        marks={marks}
        scoredCount={data.stocks.length}
        heading="Strongest stocks right now"
        top={{ limit: TOP_STOCKS, onShowAll: onShowAllStocks }}
        activeSymbol={activeSymbol}
        onOpenStock={onOpenStock}
        onOrder={onOrder}
        onSector={onSector}
      />
    </div>
  );
}
