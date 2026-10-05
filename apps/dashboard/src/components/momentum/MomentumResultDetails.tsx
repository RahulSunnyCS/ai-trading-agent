'use client';

import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Download } from 'lucide-react';
import { useMemo, useState } from 'react';

import { cn } from '../../lib/cn';
import { downloadCsv } from '../../lib/csv';
import {
  EMPTY,
  formatDay,
  formatDuration,
  formatInr,
  formatIstTime,
  formatNumber,
  formatPct,
  formatPp,
} from '../../lib/format';
import { describeConfig } from '../../lib/momentumConfig';
import type { MomentumResult, MomentumSavedRun } from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { InfoTooltip } from '../ui/InfoTooltip';
import { Input } from '../ui/Input';
import { SegmentedControl } from '../ui/SegmentedControl';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { TabPanel, Tabs } from '../ui/Tabs';
import { MomentumCompare } from './MomentumCompare';
import { MomentumHoldingsSplit } from './MomentumHoldingsSplit';
import { MomentumInsights } from './MomentumInsights';
import { MomentumKpiCards } from './MomentumKpiCards';
import { MomentumMonthlyHeatmap } from './MomentumMonthlyHeatmap';
import { useResultFlash } from './MomentumRunProgress';
import { MomentumTimelineChart } from './MomentumTimelineChart';
import { MomentumYearlyChart } from './MomentumYearlyChart';
import { ResultSection } from './ResultSection';

type Panel = 'returns' | 'week' | 'trades' | 'split' | 'risk' | 'compare';
type ReturnsView = 'chart' | 'table' | 'monthly';

const TABS: Array<{ value: Panel; label: string }> = [
  { value: 'returns', label: 'Returns' },
  { value: 'week', label: 'This week' },
  { value: 'trades', label: 'Trades' },
  { value: 'split', label: 'Trade split' },
  { value: 'risk', label: 'Risk' },
  { value: 'compare', label: 'Compare' },
];

const RETURNS_VIEWS: Array<[ReturnsView, string, string, string]> = [
  [
    'chart',
    'Yearly chart',
    'Year by year',
    'Green bars beat the benchmark that calendar year, red trailed it',
  ],
  [
    'table',
    'Yearly table',
    'Annual performance',
    'Calendar-year returns against the benchmark and the liquid fund',
  ],
  ['monthly', 'Monthly', 'Monthly returns', 'Strategy return by calendar month'],
];

const RETURNS_COPY: Record<ReturnsView, [string, string]> = Object.fromEntries(
  RETURNS_VIEWS.map(([id, , title, description]) => [id, [title, description]]),
) as Record<ReturnsView, [string, string]>;

const DATASET_LABELS: Record<string, string> = {
  etf: 'ETF Rotation',
  stock: 'Nifty 50 Stocks',
  custom_index: 'Custom Index',
  broad: 'Broad Momentum',
};

const COLUMNS: Record<'holdings' | 'trades' | 'risk', Array<[string, string]>> = {
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
  'cash',
  'return',
]);

function format(value: unknown, key = ''): string {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (key === 'vs_benchmark') return formatPp(value);
    if (PERCENT_KEYS.has(key)) return formatPct(value);
    if (key === 'pnl' || key === 'value') return formatInr(value);
    if (key === 'year') return String(value);
    return formatNumber(value, 2, { trim: true });
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
    describeConfig(config, String(dataset)).cadenceChip,
    config.sell_every_week ? 'Exits sold weekly' : null,
    config.portfolio === 'buffer' ? 'Buffer rule' : 'Fixed slots',
    dataset === 'etf' && Number(config.exclude_high_vol ?? 0) > 0
      ? `Skips most volatile ${Math.round(Number(config.exclude_high_vol) * 100)}%`
      : null,
    dataset === 'etf' && Number(config.reversal_tilt ?? 0) > 0
      ? `Beaten-down tilt ${Math.round(Number(config.reversal_tilt) * 100)}%`
      : null,
    dataset === 'broad' && Number(config.broad_reversal_tilt ?? 0) > 0
      ? `Beaten-down tilt ${Math.round(Number(config.broad_reversal_tilt) * 100)}%`
      : null,
    dataset === 'broad' && config.broad_universe === 'all_liquid' ? 'Whole NSE market' : null,
    dataset === 'broad' && config.broad_respect_circuits ? 'Circuit locks respected' : null,
    dataset === 'broad' && (config.broad_universe === 'all_liquid' || config.broad_liquidity_filter)
      ? `Tradable: ≥ ₹${Number(config.broad_liq_min_turnover_cr ?? 1)} Cr/day${
          config.broad_liq_circuit === false ? '' : ', no circuit lock'
        }${
          typeof config.broad_liq_max_circuit_days === 'number'
            ? `, ≤ ${config.broad_liq_max_circuit_days} circuit days/60`
            : ''
        }`
      : null,
    config.cost_model === 'itemised' ? 'Itemised costs' : `${config.cost_pct}% cost per side`,
    dataset === 'etf' ? (config.track === 'etf' ? 'ETF prices' : 'Index prices') : null,
    dataset === 'etf' ? (execLabel[String(config.execution)] ?? null) : null,
    config.tax ? 'After tax' : 'Pre-tax',
    `vs ${result.benchmark_name}`,
  ].filter((value): value is string => Boolean(value));
}

function dataNotes(result: MomentumResult): string[] {
  return [
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
}

/**
 * The first thing shown after a run: what was tested, the headline numbers and the
 * one-sentence takeaway. Always visible — never hidden behind a results tab.
 */
export interface MomentumRunInfo {
  finishedAt: number;
  durationMs: number;
  savedAs: string | null;
  /** True when the server dropped its caches and recomputed (the re-run-from-scratch icon). */
  fresh?: boolean;
}

export function MomentumPerformanceCard({
  result,
  config,
  stale = false,
  lastRunFailed = false,
  runInfo = null,
}: {
  result: MomentumResult;
  config: Record<string, unknown>;
  stale?: boolean;
  /** The last Run click failed, so these are the PREVIOUS run's results. */
  lastRunFailed?: boolean;
  runInfo?: MomentumRunInfo | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const flashing = useResultFlash(runInfo?.finishedAt ?? null);
  const notes = dataNotes(result);
  const label = DATASET_LABELS[String(config.dataset)] ?? 'Backtest';

  return (
    <Card className={cn(flashing && 'animate-result-flash')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-faint">Performance</p>
          <h2 className="mt-0.5 text-base font-semibold tracking-tight text-foreground">
            {label} · {formatDay(result.series.dates[0])} → {formatDay(result.series.dates.at(-1))}
          </h2>
          {runInfo ? (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <CheckCircle2 className="h-3.5 w-3.5 text-positive" />
              Updated {formatIstTime(runInfo.finishedAt, { seconds: true })} · took{' '}
              {formatDuration(runInfo.durationMs)}
              {runInfo.fresh ? ' · recomputed from scratch' : ''}
              {runInfo.savedAs ? ` · saved as ${runInfo.savedAs}` : ''}
              <InfoTooltip text="Every run recomputes the backtest for exactly the settings shown. A run that finishes in a second or two just means the server already had this strategy's price data and rankings cached — the numbers are still fresh for these settings. To drop the caches and recompute everything anyway, use the ↻ icon beside Strategy settings." />
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {lastRunFailed ? (
            <Badge tone="negative">Last run failed — these are the previous results</Badge>
          ) : stale ? (
            <Badge tone="warning">Results use previous settings</Badge>
          ) : null}
          <Button size="sm" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Hide detail metrics' : 'Show all metrics'}
          </Button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-start gap-1.5">
        {assumptionChips(result, config).map((chip) => (
          <span
            key={chip}
            className="rounded-full border border-border bg-surface-2/50 px-2.5 py-1 text-xs text-muted"
          >
            {chip}
          </span>
        ))}
        {notes.length ? (
          <details className="text-xs open:w-full">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-warning">
              <AlertTriangle className="h-3 w-3" />
              {notes.length} data {notes.length === 1 ? 'note' : 'notes'}
            </summary>
            <div className="mt-2 space-y-1 rounded-lg border border-warning/30 bg-warning/10 p-3 text-muted">
              {notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      <div className="mt-4 space-y-3">
        <MomentumKpiCards result={result} tax={Boolean(config.tax)} expanded={expanded} />
        <MomentumInsights result={result} />
      </div>
    </Card>
  );
}

/** Everything below the chart, as one card with tabs rather than a stack of cards. */
export function MomentumResultDetails({
  result,
  config,
  savedRuns = [],
  flashKey = null,
}: {
  result: MomentumResult;
  config: Record<string, unknown>;
  savedRuns?: MomentumSavedRun[];
  flashKey?: number | null;
}) {
  const flashing = useResultFlash(flashKey);
  const [panel, setPanel] = useState<Panel>('returns');
  const [returnsView, setReturnsView] = useState<ReturnsView>('chart');
  const [tradeFilter, setTradeFilter] = useState('');
  const trades = result.trades.filter((trade) =>
    `${trade.asset ?? ''} ${trade.reason ?? ''}`.toLowerCase().includes(tradeFilter.toLowerCase()),
  );
  const signalRows = result.latest.rows.map((row) => ({
    ...row,
    reason: signalReason(row, config),
  }));
  const [returnsTitle, returnsDescription] = RETURNS_COPY[returnsView];

  return (
    <Card flush className={cn(flashing && 'animate-result-flash')}>
      <Tabs
        ariaLabel="Result details"
        value={panel}
        items={TABS}
        onChange={setPanel}
        className="px-5"
      >
        <TabPanel value={panel} className="divide-y divide-border p-5">
          {panel === 'returns' ? (
            <ResultSection
              title={returnsTitle}
              description={returnsDescription}
              actions={
                <SegmentedControl
                  ariaLabel="Returns view"
                  size="sm"
                  value={returnsView}
                  onChange={setReturnsView}
                  options={RETURNS_VIEWS.map(([id, label]) => ({ value: id, label }))}
                />
              }
            >
              {returnsView === 'chart' ? (
                <MomentumYearlyChart rows={result.yearly} benchmarkName={result.benchmark_name} />
              ) : returnsView === 'table' ? (
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
              ) : (
                <MomentumMonthlyHeatmap series={result.series} />
              )}
            </ResultSection>
          ) : null}

          {panel === 'week' ? (
            <>
              <ResultSection
                title={`Signals · ${formatDay(result.latest.week)}`}
                description={result.latest.explain}
              >
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
                        <Td>{row.action || EMPTY}</Td>
                        <Td className="text-muted">{row.reason}</Td>
                        <Td numeric>{format(row.score)}</Td>
                        <Td>{row.held ? 'Yes' : 'No'}</Td>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              </ResultSection>
              {result.held_categories?.length ? (
                <ResultSection
                  title="Held categories"
                  description="Fresh selections and positions still held through the exit buffer"
                >
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
                </ResultSection>
              ) : null}
              <ResultSection title="Open positions">
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
              </ResultSection>
              <ResultSection
                title="Instrument attribution"
                description="How each instrument contributed across the whole run"
              >
                <DataTable
                  rows={result.instruments}
                  columns={COLUMNS.holdings}
                  csvName="momentum-instruments"
                />
              </ResultSection>
            </>
          ) : null}

          {panel === 'trades' ? (
            <ResultSection
              title="Closed trades"
              description="Position returns include all purchases and top ups"
              actions={
                <Input
                  type="search"
                  aria-label="Filter trades"
                  placeholder="Filter asset or reason…"
                  value={tradeFilter}
                  onChange={(event) => setTradeFilter(event.target.value)}
                  className="w-auto"
                />
              }
            >
              <DataTable rows={trades} columns={COLUMNS.trades} csvName="momentum-trades" />
            </ResultSection>
          ) : null}

          {panel === 'split' ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <MomentumTimelineChart rows={result.timeline} />
              <MomentumHoldingsSplit positions={result.open_positions} />
            </div>
          ) : null}

          {panel === 'risk' ? (
            <ResultSection
              title="Worst benchmark falls"
              description="Strategy and benchmark over the same peak-to-trough windows"
            >
              <DataTable rows={result.crashes} columns={COLUMNS.risk} csvName="momentum-crashes" />
            </ResultSection>
          ) : null}

          {panel === 'compare' ? <MomentumCompare runs={savedRuns} /> : null}
        </TabPanel>
      </Tabs>
    </Card>
  );
}
