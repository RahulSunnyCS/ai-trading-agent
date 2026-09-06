/**
 * TradesView — renders the paper trades log polled from GET /api/trades.
 *
 * States: loading skeleton → reassuring error banner (stale data kept) →
 * calm empty state → a summary strip + the trades table with tone-coded P&L.
 */

import { useMemo } from 'react';

import { usePaperTrades } from '../hooks/usePaperTrades.js';
import { formatIstDateTime, formatPnl, toNumberOrNull } from '../lib/format.js';
import type { PaperTrade } from '../types/trading.js';
import { Badge } from './ui/Badge';
import { Card, CardHeader } from './ui/Card';
import { SkeletonRows } from './ui/Skeleton';
import { StatCard } from './ui/StatCard';
import { StateMessage } from './ui/StateMessage';
import { THead, TRow, Table, Td, Th } from './ui/Table';

/** Colour-codes a P&L cell by sign; em dash for null (open trades). */
function PnlCell({ raw }: { raw: string | null }) {
  const value = toNumberOrNull(raw);
  if (value === null) return <span className="text-faint">—</span>;
  const tone = value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : 'text-muted';
  return <span className={`font-medium ${tone}`}>{formatPnl(value)}</span>;
}

function StraddleCell({ raw }: { raw: string | null }) {
  const value = toNumberOrNull(raw);
  if (value === null) return <span className="text-faint">—</span>;
  return (
    <span className="tabular-nums">
      {new Intl.NumberFormat('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)}
    </span>
  );
}

interface Summary {
  total: number;
  open: number;
  closed: number;
  net: number;
}

function summarise(trades: PaperTrade[]): Summary {
  let open = 0;
  let net = 0;
  for (const t of trades) {
    if (t.status === 'open') open += 1;
    const n = toNumberOrNull(t.net_pnl);
    if (n !== null) net += n;
  }
  return { total: trades.length, open, closed: trades.length - open, net };
}

function TradesTable({ trades }: { trades: PaperTrade[] }) {
  const sorted = [...trades].sort(
    (a, b) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime(),
  );

  return (
    <Table>
      <THead>
        <Th>Entry Time (IST)</Th>
        <Th>Status</Th>
        <Th align="right">Straddle @ Entry</Th>
        <Th align="right">Gross P&amp;L</Th>
        <Th align="right">Net P&amp;L</Th>
        <Th>Exit Reason</Th>
      </THead>
      <tbody>
        {sorted.map((trade) => (
          <TRow key={trade.id}>
            <Td numeric className="text-muted">
              {formatIstDateTime(trade.entry_time)}
            </Td>
            <Td>
              <Badge tone={trade.status === 'open' ? 'positive' : 'neutral'} dot>
                {trade.status === 'open' ? 'Open' : 'Closed'}
              </Badge>
            </Td>
            <Td numeric align="right">
              <StraddleCell raw={trade.straddle_at_entry} />
            </Td>
            <Td numeric align="right">
              <PnlCell raw={trade.gross_pnl} />
            </Td>
            <Td numeric align="right">
              <PnlCell raw={trade.net_pnl} />
            </Td>
            <Td className="text-muted">
              {trade.exit_reason ?? <span className="text-faint">—</span>}
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

export function TradesView() {
  const { trades, loading, error } = usePaperTrades();
  const summary = useMemo(() => summarise(trades), [trades]);
  const hasData = trades.length > 0;

  return (
    <div className="space-y-5">
      {hasData ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Total trades" value={summary.total} />
          <StatCard
            label="Open"
            value={summary.open}
            tone={summary.open > 0 ? 'default' : 'muted'}
          />
          <StatCard label="Closed" value={summary.closed} tone="muted" />
          <StatCard
            label="Net P&L"
            value={formatPnl(summary.net)}
            tone={summary.net > 0 ? 'positive' : summary.net < 0 ? 'negative' : 'muted'}
          />
        </div>
      ) : null}

      <Card flush={hasData}>
        {!hasData ? (
          <CardHeader
            title="Paper Trades"
            description="Simulated entries and exits, newest first"
          />
        ) : (
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-base font-semibold tracking-tight text-foreground">Paper Trades</h2>
          </div>
        )}

        <div className={hasData ? 'px-2 py-1' : ''}>
          {loading && !hasData && <SkeletonRows rows={4} className="pt-2" />}
          {error !== null && (
            <StateMessage
              variant="error"
              title="Couldn't load trades — retrying…"
              description={error}
              className={hasData ? 'm-3' : 'mt-4'}
            />
          )}
          {!loading && error === null && !hasData && (
            <StateMessage
              variant="empty"
              title="No paper trades yet"
              description="Trades will appear here once the engine enters a position."
            />
          )}
          {hasData && <TradesTable trades={trades} />}
        </div>
      </Card>
    </div>
  );
}
