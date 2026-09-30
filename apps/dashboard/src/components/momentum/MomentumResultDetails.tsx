'use client';

import { ArrowDown, ArrowUp, Download } from 'lucide-react';
import { useMemo, useState } from 'react';

import { downloadCsv } from '../../lib/csv';
import type { MomentumResult, MomentumSavedRun } from '../../types/momentum';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { MomentumCompare } from './MomentumCompare';
import { MomentumHoldingsSplit } from './MomentumHoldingsSplit';
import { MomentumInsights } from './MomentumInsights';
import { MomentumKpiCards } from './MomentumKpiCards';
import { MomentumMonthlyHeatmap } from './MomentumMonthlyHeatmap';
import { MomentumTimelineChart } from './MomentumTimelineChart';
import { MomentumYearlyChart } from './MomentumYearlyChart';

type Panel = 'overview' | 'holdings' | 'trades' | 'split' | 'risk' | 'compare';

const COLUMNS: Record<Exclude<Panel, 'overview' | 'split' | 'compare'>, Array<[string, string]>> = {
  holdings: [
    ['asset', 'Asset'],
    ['group', 'Group'],
    ['positions', 'Positions'],
    ['top_ups', 'Top ups'],
    ['weeks_held', 'Weeks held'],
    ['avg_share', 'Avg share'],
    ['win_rate', 'Win rate'],
    ['avg_return', 'Avg return'],
    ['pnl', 'P&L'],
    ['held_now', 'Held now'],
  ],
  trades: [
    ['asset', 'Asset'],
    ['entry_week', 'Entry'],
    ['exit_week', 'Exit'],
    ['weeks_held', 'Weeks'],
    ['entry_rank', 'Entry rank'],
    ['exit_rank', 'Exit rank'],
    ['position_return', 'Return'],
    ['pnl', 'P&L'],
    ['reason', 'Reason'],
    ['proxy', 'Index proxy'],
  ],
  risk: [
    ['benchmark peak', 'Benchmark peak'],
    ['benchmark trough', 'Benchmark trough'],
    ['benchmark', 'Benchmark'],
    ['strategy', 'Strategy'],
  ],
};

const PERCENT_KEYS = new Set([
  'avg_share',
  'win_rate',
  'avg_return',
  'position_return',
  'strategy',
  'benchmark',
  'vs_benchmark',
  'return',
]);

function format(value: unknown, key = ''): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (PERCENT_KEYS.has(key)) return `${(value * 100).toFixed(1)}%`;
    if (key === 'pnl' || key === 'value')
      return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    if (key === 'year') return String(value);
    return value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  return String(value);
}

function rowKey(row: Record<string, unknown>, index: number): string {
  return `${String(row.asset ?? row.year ?? row['benchmark peak'] ?? index)}-${index}`;
}

/** Sortable, CSV-exportable data table — replaces the old static DataTable everywhere. */
function DataTable({
  rows,
  columns,
  csvName,
}: { rows: Array<Record<string, unknown>>; columns: Array<[string, string]>; csvName?: string }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * sortDir;
    });
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: string): void {
    if (sortKey === key) setSortDir((dir) => (dir === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  if (rows.length === 0) return <p className="text-sm text-muted">No rows for this run.</p>;
  return (
    <div className="space-y-2">
      {csvName ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => downloadCsv(csvName, columns, sorted)}>
            <Download className="h-3.5 w-3.5" /> Download CSV
          </Button>
        </div>
      ) : null}
      <Table>
        <THead>
          {columns.map(([key, title]) => (
            <Th key={key}>
              <button
                type="button"
                onClick={() => toggleSort(key)}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                {title}
                {sortKey === key ? (
                  sortDir === 1 ? (
                    <ArrowUp className="h-3 w-3" />
                  ) : (
                    <ArrowDown className="h-3 w-3" />
                  )
                ) : null}
              </button>
            </Th>
          ))}
        </THead>
        <tbody>
          {sorted.map((row, index) => (
            <TRow key={rowKey(row, index)}>
              {columns.map(([key]) => (
                <Td key={key} numeric={typeof row[key] === 'number'}>
                  {format(row[key], key)}
                </Td>
              ))}
            </TRow>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function signalReason(
  row: MomentumResult['latest']['rows'][number],
  config: Record<string, unknown>,
): string {
  const action = row.action || '';
  const rank = row.rank ?? 0;
  const broad = config.dataset === 'broad';
  const broadOn = broad && config.broad_category_mode === 'on';
  const top = broad
    ? Number((broadOn ? config.broad_category_top_n : config.broad_off_top_n) ?? 0)
    : Number(config.top_n ?? 0);
  const exit = broad
    ? Number((broadOn ? config.broad_category_exit_rank : config.broad_off_exit_rank) ?? 0)
    : Number(config.exit_rank ?? 0);
  if (action === 'NOT A MEMBER') return "Outside this week's eligible universe.";
  if (action.startsWith('BUY')) {
    return action.includes('make room')
      ? `Rank ${rank} is within the top ${top}; existing holdings are trimmed to fund it.`
      : `New position; rank ${rank} is within the top ${top}.`;
  }
  if (action === 'ADD') return 'Existing position received more capital under the portfolio rule.';
  if (action === 'WAIT') return `Ranked in the top ${top}; entry waits for cash or a sale.`;
  if (action === 'AT CAP') return 'Position is at its configured size limit.';
  if (action.startsWith('TRIM')) return 'Position exceeded its configured size limit.';
  if (action === 'SELL') {
    return rank > exit
      ? `Rank ${rank} fell past the exit rank ${exit}.`
      : 'Exit triggered by the portfolio or protection rule.';
  }
  if (action === 'HOLD') {
    return rank > top && rank <= exit
      ? `Held in the rank buffer (${top + 1}–${exit}).`
      : 'Position remains open under the portfolio rule.';
  }
  return row.held ? 'Position remains open.' : 'Not selected for a position this week.';
}

function assumptionChips(result: MomentumResult, config: Record<string, unknown>): string[] {
  const dataset = config.dataset;
  const execLabel: Record<string, string> = {
    fri_close: 'Friday close',
    mon_open: 'Monday open',
    mon_10am: 'Monday 10:00',
  };
  return [
    config.rebalance === 'monthly' ? 'Monthly rebalance' : 'Weekly rebalance',
    config.portfolio === 'buffer' ? 'Buffer rule' : 'Fixed slots',
    config.cost_model === 'itemised' ? 'Itemised costs' : `${config.cost_pct}% cost per side`,
    dataset === 'etf' ? (config.track === 'etf' ? 'ETF prices' : 'Index prices') : null,
    dataset === 'etf' ? (execLabel[String(config.execution)] ?? null) : null,
    config.tax ? 'After tax' : 'Pre-tax',
    `vs ${result.benchmark_name}`,
  ].filter((value): value is string => Boolean(value));
}

export function MomentumResultDetails({
  result,
  config,
  savedRuns = [],
}: { result: MomentumResult; config: Record<string, unknown>; savedRuns?: MomentumSavedRun[] }) {
  const [panel, setPanel] = useState<Panel>('overview');
  const [tradeFilter, setTradeFilter] = useState('');
  const trades = result.trades.filter((trade) =>
    `${trade.asset ?? ''} ${trade.reason ?? ''}`.toLowerCase().includes(tradeFilter.toLowerCase()),
  );
  const notes = [
    ...(result.fills?.warnings ?? []),
    ...(result.fills?.proxy_trades
      ? [`${result.fills.proxy_trades} trades used an index proxy before the ETF was listed.`]
      : []),
    ...(result.skipped_categories?.length
      ? [`${result.skipped_categories.length} categories were excluded for insufficient data.`]
      : []),
    ...(result.missing_symbols?.length
      ? [`${result.missing_symbols.length} symbols lacked usable price history.`]
      : []),
  ];
  const signalRows = result.latest.rows.map((row) => ({
    ...row,
    reason: signalReason(row, config),
  }));

  return (
    <div className="space-y-5">
      <MomentumInsights result={result} />

      <Card>
        <CardHeader
          title="Backtest results"
          description={`${result.series.dates[0] ?? ''} → ${result.series.dates.at(-1) ?? ''}`}
        />
        <div className="mb-3 flex flex-wrap gap-1.5">
          {assumptionChips(result, config).map((chip) => (
            <span
              key={chip}
              className="rounded-full border border-border bg-surface-2/50 px-2.5 py-1 text-xs text-muted"
            >
              {chip}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {(['overview', 'holdings', 'trades', 'split', 'risk', 'compare'] as const).map((item) => (
            <Button
              key={item}
              size="sm"
              variant={panel === item ? 'primary' : 'secondary'}
              onClick={() => setPanel(item)}
            >
              {item === 'split' ? 'Split & holdings' : item.charAt(0).toUpperCase() + item.slice(1)}
            </Button>
          ))}
        </div>
        {notes.length ? (
          <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-muted">
            {notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        ) : null}
      </Card>

      {panel === 'overview' ? (
        <>
          <MomentumKpiCards result={result} tax={Boolean(config.tax)} />
          <MomentumYearlyChart rows={result.yearly} benchmarkName={result.benchmark_name} />
          <Card>
            <CardHeader title="Annual performance" />
            <DataTable
              rows={result.yearly}
              columns={[
                ['year', 'Year'],
                ['strategy', 'Strategy'],
                ['benchmark', result.benchmark_name],
                ['cash', 'Liquid fund'],
                ['vs_benchmark', 'Difference'],
              ]}
              csvName="momentum-yearly"
            />
          </Card>
          <MomentumMonthlyHeatmap series={result.series} />
        </>
      ) : null}

      {panel === 'holdings' ? (
        <>
          <Card>
            <CardHeader
              title={`This week · ${result.latest.week}`}
              description={result.latest.explain}
            />
            <Table>
              <THead>
                <Th>Rank</Th>
                <Th>Asset</Th>
                <Th>Action</Th>
                <Th>Why</Th>
                <Th>Score</Th>
                <Th>Held</Th>
              </THead>
              <tbody>
                {signalRows.map((row) => (
                  <TRow key={row.asset}>
                    <Td numeric>{format(row.rank)}</Td>
                    <Td>{row.asset}</Td>
                    <Td>{row.action || '—'}</Td>
                    <Td className="text-muted">{row.reason}</Td>
                    <Td numeric>{format(row.score)}</Td>
                    <Td>{row.held ? 'Yes' : 'No'}</Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </Card>
          {result.held_categories?.length ? (
            <Card>
              <CardHeader
                title="Held categories"
                description="Fresh selections and positions still held through the exit buffer"
              />
              <DataTable
                rows={result.held_categories.map((row) => ({
                  ...row,
                  picks: row.picks.join(', '),
                }))}
                columns={[
                  ['position', '#'],
                  ['status', 'Status'],
                  ['category', 'Category'],
                  ['picks', 'Stock picks'],
                ]}
              />
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Open positions" />
            <DataTable
              rows={result.open_positions}
              columns={[
                ['asset', 'Asset'],
                ['entry_week', 'Since'],
                ['weeks_held', 'Weeks'],
                ['rank', 'Rank'],
                ['position_return', 'Return'],
                ['value', 'Value'],
                ['pnl', 'P&L'],
              ]}
              csvName="momentum-open-positions"
            />
          </Card>
          <Card>
            <CardHeader title="Instrument attribution" />
            <DataTable
              rows={result.instruments}
              columns={COLUMNS.holdings}
              csvName="momentum-instruments"
            />
          </Card>
        </>
      ) : null}

      {panel === 'trades' ? (
        <Card>
          <CardHeader
            title="Closed trades"
            description="Position returns include all purchases and top ups"
            actions={
              <input
                type="search"
                aria-label="Filter trades"
                placeholder="Filter asset or reason…"
                value={tradeFilter}
                onChange={(event) => setTradeFilter(event.target.value)}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
              />
            }
          />
          <DataTable rows={trades} columns={COLUMNS.trades} csvName="momentum-trades" />
        </Card>
      ) : null}

      {panel === 'split' ? (
        <div className="grid gap-5 lg:grid-cols-[1fr,360px]">
          <MomentumTimelineChart rows={result.timeline} />
          <MomentumHoldingsSplit positions={result.open_positions} />
        </div>
      ) : null}

      {panel === 'risk' ? (
        <Card>
          <CardHeader
            title="Worst benchmark falls"
            description="Strategy and benchmark over the same peak to trough windows"
          />
          <DataTable rows={result.crashes} columns={COLUMNS.risk} csvName="momentum-crashes" />
        </Card>
      ) : null}

      {panel === 'compare' ? <MomentumCompare runs={savedRuns} /> : null}
    </div>
  );
}
