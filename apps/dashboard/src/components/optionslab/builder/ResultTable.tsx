/**
 * The full result of a builder backtest: headline tiles, the cumulative line and one row per
 * day. Clicking a day (or Enter / Space on it) opens its trade log directly under that row.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';

import { formatInt, formatNumber, formatPnl } from '../../../lib/format';
import { type BaselineComparison, statsOf } from '../../../lib/legwiseStats';
import type { BacktestResponse } from '../../../types/legwise';
import { Card, CardHeader } from '../../ui/Card';
import { StatCard } from '../../ui/StatCard';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { CumulativeLines, TradeLog, pnlClass } from '../shared';

export function ResultTable({
  result,
  lots,
  comparison,
}: {
  result: BacktestResponse;
  /** The run's "one lot" (its smallest leg size), fixed when the run was made. */
  lots: number;
  /** Against the saved version's stored results, when it has any for these days. */
  comparison: BaselineComparison | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // Same divisor statsOf and compareToBaseline use, so every column is ₹ per lot.
  const perLot = lots > 0 ? lots : 1;
  const st = statsOf(result.days, lots);
  const cmp = comparison && comparison.shared > 0 ? comparison : null;
  const columns = cmp ? 7 : 5;

  return (
    <Card>
      <CardHeader
        title="Backtest result"
        description={`${result.strategy_id} over ${formatInt(st.days)} collected days · ₹ per lot${
          st.thin ? ' · fewer than 20 days: ratios are noise' : ''
        }`}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Net / lot"
          value={formatPnl(st.total)}
          tone={st.total >= 0 ? 'positive' : 'negative'}
        />
        <StatCard label="Up days" value={`${formatInt(st.up)} / ${formatInt(st.days)}`} />
        <StatCard label="Expectancy" value={formatPnl(st.expectancy)} note="avg ₹ / day" />
        <StatCard
          label="Profit factor"
          value={formatNumber(st.profitFactor, 2)}
          note={st.avgLoss === null ? 'no losing day' : `avg loss ${formatPnl(st.avgLoss)}`}
        />
        <StatCard
          label="Worst day"
          value={formatPnl(st.worst)}
          tone="negative"
          note={`losing streak ${formatInt(st.longestLosingStreak)}`}
        />
        <StatCard label="Max drawdown" value={formatPnl(st.maxDrawdown)} tone="negative" />
      </div>
      {cmp && (
        <p className="mb-3 text-sm">
          <span className="text-muted">
            Versus the saved version over {formatInt(cmp.shared)} shared days:{' '}
          </span>
          <span className={pnlClass(cmp.deltaTotal)}>
            {formatPnl(cmp.deltaTotal)} per lot (
            {cmp.deltaTotal >= 0 ? 'edit did better' : 'edit did worse'})
          </span>
          {cmp.uncovered > 0 && (
            <span className="text-faint">
              {' '}
              · {formatInt(cmp.uncovered)} days have no stored result for the saved version and are
              not compared
            </span>
          )}
        </p>
      )}
      <CumulativeLines lines={[{ id: result.strategy_id, points: st.cumulative }]} />
      <Table>
        <THead>
          <Th>Day</Th>
          <Th align="right">Trades</Th>
          <Th align="right">Net / lot</Th>
          {cmp && <Th align="right">Saved (₹/lot)</Th>}
          {cmp && <Th align="right">Δ / lot</Th>}
          <Th align="right">Worst MTM / lot</Th>
          <Th>Note</Th>
        </THead>
        <tbody>
          {result.days.map((d) => {
            const isOpen = open === d.day;
            const versus = cmp?.byDay.get(d.day);
            return (
              <Fragment key={d.day}>
                <TRow onClick={() => setOpen(isOpen ? null : d.day)} selected={isOpen}>
                  <Td numeric className="whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 text-faint" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-faint" aria-hidden="true" />
                      )}
                      {d.day}
                    </span>
                  </Td>
                  <Td align="right" numeric>
                    {formatInt(d.trades.length)}
                  </Td>
                  <Td align="right" numeric className={pnlClass(d.net)}>
                    {formatPnl(d.net / perLot)}
                  </Td>
                  {cmp && (
                    <Td align="right" numeric className="text-muted">
                      {formatPnl(versus?.saved)}
                    </Td>
                  )}
                  {cmp && (
                    <Td align="right" numeric className={pnlClass(versus?.delta ?? 0)}>
                      {formatPnl(versus?.delta)}
                    </Td>
                  )}
                  <Td align="right" numeric>
                    {formatPnl(d.worst_mtm / perLot)}
                  </Td>
                  <Td className="text-xs text-muted">
                    {[d.stopped_by, ...d.notes].filter(Boolean).join('; ')}
                  </Td>
                </TRow>
                {isOpen && (
                  <tr className="border-b border-border/60 bg-surface-2/30">
                    <td colSpan={columns} className="px-4 py-3">
                      <p className="mb-2 text-xs font-medium text-muted">
                        Trades on {d.day} · ₹ for the strategy’s full size
                      </p>
                      <TradeLog trades={d.trades} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
