/**
 * Closed paper trades grouped by the regime of their exit day (IST): count, win rate, net P&L
 * and the average per trade. The join is `pnlByRegime` in lib/regimeTags.ts.
 */

import { formatInr, formatInt, formatPct } from '../../lib/format';
import type { RegimePnl } from '../../lib/regimeTags';
import { RegimeBadge } from '../optionslab/regimes/RegimeBadge';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

function pnlClass(value: number): string {
  if (value > 0) return 'text-positive';
  if (value < 0) return 'text-negative';
  return 'text-muted';
}

export function RegimePnlTable({ pnl, windowCaption }: { pnl: RegimePnl; windowCaption: string }) {
  if (pnl.rows.length === 0) {
    return (
      <StateMessage
        variant="empty"
        title="No closed trades in this window"
        description={`P&L by regime needs closed paper trades on this underlying that exited in the window (${windowCaption}).`}
      />
    );
  }

  return (
    <div>
      <Table>
        <THead>
          <Th>Regime of exit day</Th>
          <Th align="right">Trades</Th>
          <Th align="right">Win rate</Th>
          <Th align="right">Net P&amp;L</Th>
          <Th align="right">Avg / trade</Th>
        </THead>
        <tbody>
          {pnl.rows.map((row) => (
            <TRow key={row.regime === '' ? 'untagged' : row.regime}>
              <Td>
                <RegimeBadge regime={row.regime === '' ? null : row.regime} />
              </Td>
              <Td numeric align="right">
                {formatInt(row.trades)}
              </Td>
              <Td numeric align="right">
                {formatPct(row.trades > 0 ? row.wins / row.trades : null, 0)}
              </Td>
              <Td numeric align="right" className={pnlClass(row.netPnl)}>
                {formatInr(row.netPnl, { sign: true })}
              </Td>
              <Td numeric align="right" className={pnlClass(row.netPnl)}>
                {formatInr(row.trades > 0 ? row.netPnl / row.trades : null, { sign: true })}
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
      <p className="mt-2 px-1 text-xs text-faint">
        {formatInt(pnl.joined)} closed trades · {windowCaption}
        {pnl.untagged > 0 ? ` · ${formatInt(pnl.untagged)} exited on an untagged day` : ''}
        {pnl.missingPnl > 0 ? ` · ${formatInt(pnl.missingPnl)} left out (no net P&L)` : ''}
      </p>
    </div>
  );
}
