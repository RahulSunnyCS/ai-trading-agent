'use client';

import type { MomentumWeeklyJobState } from '../../../hooks/useMomentumWeeklyJob';
import { usePolledResource } from '../../../hooks/usePolledResource';
import type { MomentumStockActionReview } from '../../../types/momentum';
import { Drawer } from '../../ui/Drawer';
import { RunWeeklyPanel, StockActionAlertRow } from '../MomentumWeeklyView';

/** This week's "Run by hand": the manual preview/final run, data readiness, the schedule. */
export function RunByHandDrawer({
  open,
  onClose,
  weekly,
}: {
  open: boolean;
  onClose: () => void;
  weekly: MomentumWeeklyJobState;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title="Run by hand"
      subtitle="Normally the Friday schedule does all of this."
    >
      <RunWeeklyPanel weekly={weekly} />
    </Drawer>
  );
}

/** Classify one possible split or bonus (opened from Needs attention). */
export function ClassifySplitDrawer({
  symbol,
  onClose,
  onSaved,
}: {
  symbol: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const actions = usePolledResource<MomentumStockActionReview>('/api/momentum/stock-actions', {
    cache: true,
  });
  const items = actions.data?.items.filter((item) => item.symbol === symbol) ?? [];
  return (
    <Drawer
      open={symbol !== null}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title="Classify a possible split"
      subtitle="A stock that halves overnight has usually split, not crashed. Check the exchange announcement first."
    >
      {items.length ? (
        <div className="space-y-3">
          {items.map((item) => (
            <StockActionAlertRow
              key={`${item.symbol}-${item.ex_date}`}
              item={item}
              onSaved={() => {
                actions.refetch();
                onSaved();
                onClose();
              }}
            />
          ))}
          <p className="text-xs text-muted">
            Saving applies the share factor to every backtest from that date. The journal is not
            changed: its entries keep what was recorded.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">
          {actions.loading ? 'Loading…' : `Nothing left to classify for ${symbol}.`}
        </p>
      )}
    </Drawer>
  );
}
