'use client';

import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Download } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { type RunSection, useRunSection } from '../../hooks/useRunSection';
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
import { describeConfig, hindsightWarning } from '../../lib/momentumConfig';
import { BROAD_UNIVERSES, broadUniverse, isGatedUniverse } from '../../lib/momentumUniverse';
import type { MomentumLatest, MomentumResult, MomentumSavedRun } from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { InfoTooltip } from '../ui/InfoTooltip';
import { Input } from '../ui/Input';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
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
import { SignalsTable } from './details/SignalsTable';

export const COLUMNS: Record<'holdings' | 'trades' | 'risk', Array<[string, string]>> = {
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

/**
 * Sortable, CSV-exportable data table. Rows stay on one line: a long cell is cut short with an
 * ellipsis and shows in full on hover. `maxRows` shows the first rows (after sorting) with a
 * "Show all" toggle, for a widget that should not grow the page by hundreds of rows.
 */
export function DataTable({
  rows,
  columns,
  csvName,
  maxRows,
}: {
  rows: Array<Record<string, unknown>>;
  columns: Array<[string, string]>;
  csvName?: string;
  maxRows?: number;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [showAll, setShowAll] = useState(false);

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
  const limited = maxRows !== undefined && !showAll && sorted.length > maxRows;
  // Figures read down a column right-aligned; a column is numeric when its first value is.
  const numericColumn = new Set(
    columns
      .map(([key]) => key)
      .filter((key) => typeof rows.find((row) => row[key] != null)?.[key] === 'number'),
  );
  const shown = limited ? sorted.slice(0, maxRows) : sorted;
  return (
    <div className="space-y-2">
      <Table className="[&_td]:max-w-[18rem] [&_td]:truncate [&_td]:whitespace-nowrap [&_td]:py-1.5">
        <THead>
          {columns.map(([key, title]) => (
            <Th key={key} align={numericColumn.has(key) ? 'right' : 'left'}>
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
          {shown.map((row, index) => (
            <TRow key={rowKey(row, index)}>
              {columns.map(([key]) => {
                const text = format(row[key], key);
                return (
                  <Td
                    key={key}
                    numeric={typeof row[key] === 'number'}
                    align={numericColumn.has(key) ? 'right' : 'left'}
                    title={typeof row[key] === 'string' ? text : undefined}
                  >
                    {text}
                  </Td>
                );
              })}
            </TRow>
          ))}
        </tbody>
      </Table>
      {limited || csvName || showAll ? (
        <div className="flex items-center justify-between gap-2">
          {maxRows !== undefined && sorted.length > maxRows ? (
            <Button size="sm" variant="ghost" onClick={() => setShowAll((value) => !value)}>
              {showAll ? `Show the first ${maxRows}` : `Show all ${sorted.length}`}
            </Button>
          ) : (
            <span />
          )}
          {csvName ? (
            <Button size="sm" variant="ghost" onClick={() => downloadCsv(csvName, columns, sorted)}>
              <Download className="h-3.5 w-3.5" /> CSV
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function signalReason(
  row: MomentumLatest['rows'][number],
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
  if (action.startsWith('SKIP')) return row.reason || 'Ranked to buy, but blocked by a buy rule.';
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

export function assumptionChips(config: Record<string, unknown>): string[] {
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
    dataset === 'broad' ? BROAD_UNIVERSES[broadUniverse(config)].short : null,
    dataset === 'broad' && config.broad_respect_circuits ? 'Circuit locks respected' : null,
    dataset === 'broad' && (isGatedUniverse(broadUniverse(config)) || config.broad_liquidity_filter)
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
  ].filter((value): value is string => Boolean(value));
}

export function dataNotes(result: MomentumResult): string[] {
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

/** When and how the run on screen finished, for the headline strip. */
export interface MomentumRunInfo {
  finishedAt: number;
  durationMs: number;
  savedAs: string | null;
  /** True when the server dropped its caches and recomputed (the re-run-from-scratch icon). */
  fresh?: boolean;
}

/** A heavy section of the run while it loads, if it fails, and once it is here (BL-005). */
export function Loaded<T>({
  section,
  label,
  children,
}: {
  section: RunSection<T>;
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (section.error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span>
          Could not load {label}. {section.error}
        </span>
        <Button size="sm" onClick={section.retry}>
          Try again
        </Button>
      </div>
    );
  }
  if (section.data === undefined) return section.loading ? <SkeletonRows rows={6} /> : null;
  if (section.data === null) return null;
  return <>{children(section.data)}</>;
}

/**
 * This week: the latest signals beside what the portfolio holds now. Signals is a fetched
 * section (`latest`); the open positions and held categories come with the core result.
 */
export function WeekPanel({
  runId,
  result,
  config,
}: {
  runId: string;
  result: MomentumResult;
  config: Record<string, unknown>;
}) {
  const latest = useRunSection(runId, 'latest');
  return (
    <div className="grid gap-x-6 gap-y-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Loaded section={latest} label="this week's signals">
        {(week) => (
          <ResultSection
            padded={false}
            title={`Signals · ${formatDay(week.week)}`}
            description={week.explain}
          >
            <SignalsTable
              rows={week.rows.map((row) => ({ ...row, reason: signalReason(row, config) }))}
            />
          </ResultSection>
        )}
      </Loaded>
      <div className="min-w-0 space-y-4">
        <ResultSection padded={false} title="Open positions">
          <DataTable
            rows={result.open_positions}
            // Narrow beside the signals: the entry week is in the CSV and the Trades widget.
            columns={[
              ['asset', 'Asset'],
              ['weeks_held', 'Weeks'],
              ['rank', 'Rank'],
              ['position_return', 'Return'],
              ['value', 'Value'],
              ['pnl', 'P&L'],
            ]}
            csvName="momentum-open-positions"
          />
        </ResultSection>
        {result.held_categories?.length ? (
          <ResultSection
            padded={false}
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
      </div>
    </div>
  );
}

/** How each instrument contributed across the whole run (a fetched section). */
export function InstrumentsPanel({ runId }: { runId: string }) {
  const instruments = useRunSection(runId, 'instruments');
  return (
    <Loaded section={instruments} label="instrument attribution">
      {(rows) => (
        <DataTable
          rows={rows}
          columns={COLUMNS.holdings}
          csvName="momentum-instruments"
          maxRows={12}
        />
      )}
    </Loaded>
  );
}

/** Every closed trade, filterable; the newest first. */
export function TradesPanel({
  runId,
  filter,
  onFilter,
}: {
  runId: string;
  filter: string;
  onFilter: (value: string) => void;
}) {
  const trades = useRunSection(runId, 'trades');
  return (
    <div className="space-y-2">
      <Input
        type="search"
        aria-label="Filter trades"
        placeholder="Filter asset or reason…"
        value={filter}
        onChange={(event) => onFilter(event.target.value)}
        className="h-8 w-64 max-w-full"
      />
      <Loaded section={trades} label="the trades">
        {(rows) => (
          <DataTable
            rows={[...rows]
              .reverse()
              .filter((trade) =>
                `${trade.asset ?? ''} ${trade.reason ?? ''}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )}
            columns={COLUMNS.trades}
            csvName="momentum-trades"
            maxRows={10}
          />
        )}
      </Loaded>
    </div>
  );
}

export function TimelinePanel({ runId, result }: { runId: string; result: MomentumResult }) {
  const timeline = useRunSection(runId, 'timeline');
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Loaded section={timeline} label="the holdings timeline">
        {(rows) => <MomentumTimelineChart rows={rows} />}
      </Loaded>
      <MomentumHoldingsSplit positions={result.open_positions} />
    </div>
  );
}
