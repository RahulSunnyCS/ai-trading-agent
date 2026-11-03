'use client';

/**
 * The Momentum rebalance log (BL-200): one block per lot per due week, newest first. What the
 * Zerodha notes show was bought and sold that week (netted per stock; never what the strategy
 * only suggested), and what the lot holds after. A missed week says where it was folded in. Every figure is the server's.
 */

import { useState } from 'react';

import { type TradeBookRange, useMomentumRebalanceLog } from '../../hooks/useTradeBook';
import { apiPost } from '../../lib/api';
import { EMPTY, formatDayShort, formatInr, formatInt } from '../../lib/format';
import {
  REBALANCE_TONE,
  foldedLine,
  holdingLine,
  kiteCheckLine,
  lineNote,
  notTradedLine,
  rebalanceStatusLabel,
  rebalanceTitle,
} from '../../lib/momentumRebalanceLog';
import type { RebalanceBlock, RebalanceLogResponse } from '../../types/tradeBook';
import { Badge } from '../ui/Badge';
import { RefreshButton } from '../ui/RefreshButton';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { toast } from '../ui/Toast';
import { Loaded, TradeBookWidget } from './parts';

export function TradeBookRebalances({ range }: { range: TradeBookRange }) {
  const res = useMomentumRebalanceLog(range);
  const blocks = res.data?.groups.flatMap((g) => g.blocks) ?? [];
  const through = res.data?.notes_through;
  const [syncing, setSyncing] = useState(false);

  /** Read Kite's holdings and free cash now (read-only), then the log again. */
  async function refreshFromKite(): Promise<void> {
    setSyncing(true);
    const response = await apiPost('/api/momentum/kite/sync', {});
    setSyncing(false);
    if (!response.ok) toast(`Could not read Kite: ${response.error}`, 'error');
    else toast('Holdings read from Kite');
    res.refetch();
  }

  return (
    <TradeBookWidget
      title="Rebalances"
      badge={res.data ? formatInt(blocks.length) : undefined}
      actions={
        <RefreshButton
          label="Refresh from Kite"
          loading={syncing}
          onClick={() => void refreshFromKite()}
          title="Read the Kite holdings and free cash now (read-only) and check them against the notes"
        />
      }
      description={`One block per lot on its Friday, newest first: the trades netted per stock and what the lot holds after. Zerodha notes read through ${
        through ? formatDayShort(through, { weekday: true }) : EMPTY
      }.`}
    >
      {() => (
        <Loaded
          data={res.data}
          loading={res.loading}
          error={res.error}
          retry={res.refetch}
          rows={4}
        >
          {(data) =>
            blocks.length === 0 ? (
              <p className="text-xs text-faint">
                {data.paper_start
                  ? 'No rebalance in this period.'
                  : 'No paper start is set, so there are no lots to show.'}
              </p>
            ) : (
              <div className="space-y-3">
                <KiteCheck check={data.kite_check} />
                {blocks.map((block) => (
                  <RebalanceCard key={`${block.week}-${block.sleeve_id}`} block={block} />
                ))}
              </div>
            )
          }
        </Loaded>
      )}
    </TradeBookWidget>
  );
}

function KiteCheck({ check }: { check: RebalanceLogResponse['kite_check'] }) {
  const line = kiteCheckLine(check);
  if (!line) return null;
  return <p className={check?.matches ? 'text-xs text-muted' : 'text-xs text-warning'}>{line}</p>;
}

function RebalanceCard({ block }: { block: RebalanceBlock }) {
  const folded = foldedLine(block);
  const notTraded = notTradedLine(block);
  return (
    <article
      aria-label={rebalanceTitle(block)}
      className="rounded-lg border border-border bg-surface-2/40 px-3 py-2.5"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold text-foreground">{rebalanceTitle(block)}</h4>
        <Badge tone={REBALANCE_TONE[block.status]} dot>
          {rebalanceStatusLabel(block.status)}
        </Badge>
        {block.new_lot ? (
          <span className="text-xs text-faint">new lot, bought from cash</span>
        ) : null}
        {block.first_trade_day && block.first_trade_day !== block.week ? (
          <span className="text-xs text-faint">
            traded {formatDayShort(block.first_trade_day, { weekday: true })}
          </span>
        ) : null}
      </header>
      {block.lines.length > 0 ? (
        <Table className="mt-2">
          <THead>
            <Th dense>Stock</Th>
            <Th dense align="right">
              Shares
            </Th>
            <Th dense align="right">
              Value
            </Th>
            <Th dense>Side</Th>
            <Th dense>Note</Th>
          </THead>
          <tbody>
            {block.lines.map((line) => (
              <TRow
                key={`${line.symbol}-${line.side}-${line.status}`}
                className="whitespace-nowrap"
              >
                <Td dense>{line.symbol}</Td>
                <Td dense numeric align="right">
                  {formatInt(line.shares)}
                </Td>
                <Td dense numeric align="right">
                  {line.value === null ? EMPTY : formatInr(line.value)}
                </Td>
                <Td dense>
                  <Badge tone={line.side === 'buy' ? 'info' : 'accent'}>{line.side}</Badge>
                </Td>
                <Td dense className="text-xs text-muted">
                  {lineNote(line) ?? ''}
                </Td>
              </TRow>
            ))}
          </tbody>
        </Table>
      ) : null}
      {notTraded ? <p className="mt-2 text-xs text-faint">{notTraded}</p> : null}
      {folded ? <p className="mt-2 text-xs text-warning">{folded}</p> : null}
      <p className="mt-2 text-xs text-muted">
        <span className="text-faint">Holding after: </span>
        {holdingLine(block)}
      </p>
      {block.bought || block.sold ? (
        <p className="mt-0.5 text-xs text-faint">
          Bought {formatInr(block.bought)} · sold {formatInr(block.sold)}
          {block.charges ? ` · charges ${formatInr(block.charges)}` : ''}
        </p>
      ) : null}
    </article>
  );
}
