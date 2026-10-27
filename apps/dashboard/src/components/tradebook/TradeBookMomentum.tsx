'use client';

/**
 * The Momentum view: the Zerodha (Kite) contract notes, every transaction booked to Momentum since
 * that account trades nothing else. What was bought and sold, the charges, and every fill.
 */

import { ExternalLink } from 'lucide-react';

import { navigateToLink } from '../../hooks/useQueryState';
import { type TradeBookRange, useTradeBookMomentum } from '../../hooks/useTradeBook';
import { EMPTY, formatDay, formatInr, formatInt, formatNumber, formatPct } from '../../lib/format';
import { kiteTotals } from '../../lib/tradeBookView';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { Loaded, Stat, TradeBookWidget } from './parts';

export function TradeBookMomentum({ range }: { range: TradeBookRange }) {
  const res = useTradeBookMomentum(range);
  return (
    <Loaded data={res.data} loading={res.loading} error={res.error} retry={res.refetch} rows={6}>
      {(data) => {
        const t = kiteTotals(data.notes);
        const turnover = t.bought + t.sold;
        return (
          <div className="space-y-4">
            <section
              aria-label="Momentum totals"
              className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-surface px-4 py-3 shadow-card lg:grid-cols-5"
            >
              <Stat label="Bought" sub={`${formatInt(t.buys)} buys`}>
                {formatInr(t.bought)}
              </Stat>
              <Stat label="Sold" sub={`${formatInt(t.sells)} sells`}>
                {formatInr(t.sold)}
              </Stat>
              <Stat
                label="Charges"
                sub={turnover ? `${formatPct(t.charges / turnover, 2)} of turnover` : 'no turnover'}
              >
                {formatInr(t.charges)}
              </Stat>
              <Stat label="Notes" sub="Zerodha contract notes">
                {formatInt(t.notes)}
              </Stat>
              <div className="col-span-2 flex items-center lg:col-span-1">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => navigateToLink('/momentum/week')}
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Open Momentum › This week
                </Button>
              </div>
            </section>
            <TradeBookWidget
              title="Fills"
              badge={`${formatInt(t.buys + t.sells)}`}
              description="Every transaction on the Zerodha notes, newest first. That account trades nothing but Momentum."
            >
              {() =>
                data.notes.length === 0 ? (
                  <p className="text-xs text-faint">No Zerodha notes in this period.</p>
                ) : (
                  <Table maxHeight={640}>
                    <THead>
                      <Th dense>Day</Th>
                      <Th dense>Time</Th>
                      <Th dense>Symbol</Th>
                      <Th dense>Side</Th>
                      <Th dense align="right">
                        Qty
                      </Th>
                      <Th dense align="right">
                        Price
                      </Th>
                      <Th dense align="right">
                        Value
                      </Th>
                    </THead>
                    <tbody>
                      {[...data.notes].reverse().flatMap((n) =>
                        n.trades.map((tr, i) => (
                          <TRow key={`${n.day}-${n.account}-${i}`} className="whitespace-nowrap">
                            <Td dense>{formatDay(n.day, { weekday: true }).slice(0, 10)}</Td>
                            <Td dense numeric align="right">
                              {tr.time?.slice(0, 5) ?? EMPTY}
                            </Td>
                            <Td dense>{tr.symbol}</Td>
                            <Td dense>
                              <Badge tone={tr.side === 'buy' ? 'info' : 'accent'}>{tr.side}</Badge>
                            </Td>
                            <Td dense numeric align="right">
                              {formatInt(tr.qty)}
                            </Td>
                            <Td dense numeric align="right">
                              {formatNumber(tr.price, 2)}
                            </Td>
                            <Td dense numeric align="right">
                              {formatInr(Math.abs(tr.value))}
                            </Td>
                          </TRow>
                        )),
                      )}
                    </tbody>
                  </Table>
                )
              }
            </TradeBookWidget>
          </div>
        );
      }}
    </Loaded>
  );
}
