'use client';

import { useState } from 'react';

import type { MomentumResult } from '../../types/momentum';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

type Panel = 'overview' | 'holdings' | 'trades' | 'risk';

const COLUMNS: Record<Exclude<Panel, 'overview'>, Array<[string, string]>> = {
  holdings: [
    ['asset', 'Asset'], ['group', 'Group'], ['positions', 'Positions'], ['top_ups', 'Top ups'],
    ['weeks_held', 'Weeks held'], ['avg_share', 'Avg share'], ['win_rate', 'Win rate'],
    ['avg_return', 'Avg return'], ['pnl', 'P&L'], ['held_now', 'Held now'],
  ],
  trades: [
    ['asset', 'Asset'], ['entry_week', 'Entry'], ['exit_week', 'Exit'], ['weeks_held', 'Weeks'],
    ['entry_rank', 'Entry rank'], ['exit_rank', 'Exit rank'], ['position_return', 'Return'],
    ['pnl', 'P&L'], ['reason', 'Reason'], ['proxy', 'Index proxy'],
  ],
  risk: [
    ['benchmark peak', 'Benchmark peak'], ['benchmark trough', 'Benchmark trough'],
    ['benchmark', 'Benchmark'], ['strategy', 'Strategy'],
  ],
};

const PERCENT_KEYS = new Set([
  'avg_share', 'win_rate', 'avg_return', 'position_return', 'strategy', 'benchmark', 'vs_benchmark', 'return',
]);

function format(value: unknown, key = ''): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (PERCENT_KEYS.has(key)) return `${(value * 100).toFixed(1)}%`;
    if (key === 'pnl' || key === 'value') return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    return value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  return String(value);
}

function DataTable({ rows, columns }: { rows: Array<Record<string, unknown>>; columns: Array<[string, string]> }) {
  if (rows.length === 0) return <p className="text-sm text-muted">No rows for this run.</p>;
  return (
    <Table>
      <THead>{columns.map(([key, title]) => <Th key={key}>{title}</Th>)}</THead>
      <tbody>{rows.map((row, index) => (
        <TRow key={`${String(row.asset ?? row.year ?? row['benchmark peak'] ?? index)}-${index}`}>
          {columns.map(([key]) => <Td key={key} numeric={typeof row[key] === 'number'}>{format(row[key], key)}</Td>)}
        </TRow>
      ))}</tbody>
    </Table>
  );
}

export function MomentumResultDetails({ result }: { result: MomentumResult }) {
  const [panel, setPanel] = useState<Panel>('overview');
  const [tradeFilter, setTradeFilter] = useState('');
  const trades = result.trades.filter((trade) =>
    `${trade.asset ?? ''} ${trade.reason ?? ''}`.toLowerCase().includes(tradeFilter.toLowerCase()),
  );
  const notes = [
    ...(result.fills?.warnings ?? []),
    ...(result.fills?.proxy_trades ? [`${result.fills.proxy_trades} trades used an index proxy before the ETF was listed.`] : []),
    ...(result.skipped_categories?.length ? [`${result.skipped_categories.length} categories were excluded for insufficient data.`] : []),
    ...(result.missing_symbols?.length ? [`${result.missing_symbols.length} symbols lacked usable price history.`] : []),
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Backtest results" description={`${result.series.dates[0] ?? ''} → ${result.series.dates.at(-1) ?? ''}`} />
        <div className="flex flex-wrap gap-2">
          {(['overview', 'holdings', 'trades', 'risk'] as const).map((item) => (
            <Button key={item} size="sm" variant={panel === item ? 'primary' : 'secondary'} onClick={() => setPanel(item)}>{item.charAt(0).toUpperCase() + item.slice(1)}</Button>
          ))}
        </div>
        {notes.length ? <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-muted">{notes.map((note) => <p key={note}>{note}</p>)}</div> : null}
      </Card>

      {panel === 'overview' ? (
        <>
          <Card>
            <CardHeader title="Performance" />
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {Object.entries(result.kpis).map(([key, value]) => (
                <div key={key} className="rounded-lg bg-surface-2/50 p-3">
                  <dt className="text-xs text-muted">{key.replaceAll('_', ' ')}</dt>
                  <dd className="mt-1 text-sm font-semibold text-foreground">{typeof value === 'number' && (key.includes('return') || key.includes('cagr') || key.includes('drawdown') || key.includes('rate') || key.includes('share')) ? `${(value * 100).toFixed(1)}%` : format(value, key)}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card>
            <CardHeader title="Annual performance" />
            <DataTable rows={result.yearly} columns={[["year", "Year"], ["strategy", "Strategy"], ["benchmark", result.benchmark_name], ["cash", "Liquid fund"], ["vs_benchmark", "Difference"]]} />
          </Card>
        </>
      ) : null}

      {panel === 'holdings' ? (
        <>
          <Card>
            <CardHeader title={`This week · ${result.latest.week}`} description={result.latest.explain} />
            <Table>
              <THead><Th>Rank</Th><Th>Asset</Th><Th>Action</Th><Th>Score</Th><Th>Held</Th></THead>
              <tbody>{result.latest.rows.map((row) => <TRow key={row.asset}><Td numeric>{format(row.rank)}</Td><Td>{row.asset}</Td><Td>{row.action || '—'}</Td><Td numeric>{format(row.score)}</Td><Td>{row.held ? 'Yes' : 'No'}</Td></TRow>)}</tbody>
            </Table>
          </Card>
          {result.held_categories?.length ? <Card><CardHeader title="Held categories" description="Fresh selections and positions still held through the exit buffer" /><DataTable rows={result.held_categories.map((row) => ({ ...row, picks: row.picks.join(', ') }))} columns={[["position", "#"], ["status", "Status"], ["category", "Category"], ["picks", "Stock picks"]]} /></Card> : null}
          <Card><CardHeader title="Open positions" /><DataTable rows={result.open_positions} columns={[["asset", "Asset"], ["entry_week", "Since"], ["weeks_held", "Weeks"], ["rank", "Rank"], ["position_return", "Return"], ["value", "Value"], ["pnl", "P&L"]]} /></Card>
          <Card><CardHeader title="Instrument attribution" /><DataTable rows={result.instruments} columns={COLUMNS.holdings} /></Card>
          <Card><CardHeader title="Holdings timeline" description="Every closed and open position, with its start and end dates" /><DataTable rows={result.timeline} columns={[["asset", "Asset"], ["start", "Start"], ["end", "End"], ["weeks", "Weeks"], ["return", "Return"], ["open", "Open"]]} /></Card>
        </>
      ) : null}

      {panel === 'trades' ? (
        <Card>
          <CardHeader title="Closed trades" description="Position returns include all purchases and top ups" actions={<input type="search" aria-label="Filter trades" placeholder="Filter asset or reason…" value={tradeFilter} onChange={(event) => setTradeFilter(event.target.value)} className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm" />} />
          <DataTable rows={trades} columns={COLUMNS.trades} />
        </Card>
      ) : null}

      {panel === 'risk' ? (
        <Card><CardHeader title="Worst benchmark falls" description="Strategy and benchmark over the same peak to trough windows" /><DataTable rows={result.crashes} columns={COLUMNS.risk} /></Card>
      ) : null}
    </div>
  );
}
