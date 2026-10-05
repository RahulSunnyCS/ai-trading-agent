/**
 * One row per strategy, sortable, ranked by Net / lot: the replacement for the per-strategy
 * stat cards. Everything is ₹ per lot over the days in view (legwiseStats / legwiseResults).
 */

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { seriesCssColor } from '../../../lib/chartTheme';
import { cn } from '../../../lib/cn';
import { EMPTY, formatInt, formatNumber, formatPct, formatPnl } from '../../../lib/format';
import {
  type ComparisonRow,
  DEFAULT_SORT,
  type SortKey,
  type SortState,
  ariaSort,
  nextSort,
  sortComparison,
  sparkline,
} from '../../../lib/legwiseResults';
import { MIN_DAYS_FOR_RATIOS } from '../../../lib/legwiseStats';
import { InfoTooltip } from '../../ui/InfoTooltip';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { pnlClass } from '../shared';

const SPARK_W = 96;
const SPARK_H = 28;

/** Cumulative ₹ per lot from flat, drawn in the strategy's series colour. */
export function Sparkline({ row }: { row: ComparisonRow }) {
  const values = row.stats.cumulative.map((p) => p.value);
  const { path, zeroY } = sparkline(values, SPARK_W, SPARK_H);
  if (path === '') return <span className="text-faint">{EMPTY}</span>;
  return (
    <svg
      role="img"
      aria-label={`Cumulative P&L per lot over ${formatInt(row.stats.days)} days, ending at ${formatPnl(row.stats.total)}`}
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      className="inline-block align-middle text-border-strong"
    >
      {zeroY !== null && (
        <line
          x1={0}
          x2={SPARK_W}
          y1={zeroY}
          y2={zeroY}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      )}
      <path
        d={path}
        fill="none"
        stroke={seriesCssColor(row.colorIndex)}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  align = 'right',
  help,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
  help?: string;
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <Th align={align} aria-sort={ariaSort(sort, sortKey)}>
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'justify-end')}>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={cn(
            'inline-flex items-center gap-1 rounded uppercase tracking-wider transition-colors hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            active && 'text-foreground',
          )}
        >
          {label}
          <Icon className={cn('h-3 w-3', !active && 'opacity-50')} aria-hidden="true" />
        </button>
        {help ? <InfoTooltip text={help} label={`About ${label}`} /> : null}
      </span>
    </Th>
  );
}

export function ComparisonTable({
  rows,
  actions,
}: {
  rows: ComparisonRow[];
  /** Shown right of the caption (a Refresh button, say). */
  actions?: ReactNode;
}) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const sorted = useMemo(() => sortComparison(rows, sort), [rows, sort]);
  const onSort = (key: SortKey) => setSort((current) => nextSort(current, key));
  const anyThin = rows.some((r) => r.stats.thin);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          ₹ per lot, net of costs (a strategy's lot is its smallest leg).
          {anyThin ? (
            <span className="text-warning">
              {' '}
              Fewer than {MIN_DAYS_FOR_RATIOS} days: ratios are noise, read the days instead.
            </span>
          ) : null}
        </p>
        {actions}
      </div>
      <Table stickyFirstCol>
        <THead>
          <SortTh label="Strategy" sortKey="name" sort={sort} onSort={onSort} align="left" />
          <Th>Version</Th>
          <SortTh label="Days" sortKey="days" sort={sort} onSort={onSort} />
          <SortTh label="Net / lot" sortKey="total" sort={sort} onSort={onSort} />
          <SortTh label="Up days" sortKey="up" sort={sort} onSort={onSort} />
          <SortTh label="Win rate" sortKey="winRate" sort={sort} onSort={onSort} />
          <SortTh
            label="Expectancy"
            sortKey="expectancy"
            sort={sort}
            onSort={onSort}
            help="Average net ₹ per lot per day: total net divided by the number of days. What one more average day is worth."
          />
          <SortTh
            label="Profit factor"
            sortKey="profitFactor"
            sort={sort}
            onSort={onSort}
            help="Sum of the winning days divided by the sum of the losing days. Above 1 means the wins outweigh the losses. Blank when there is no losing day yet."
          />
          <SortTh label="Worst day" sortKey="worst" sort={sort} onSort={onSort} />
          <SortTh
            label="Worst MTM"
            sortKey="worstMtm"
            sort={sort}
            onSort={onSort}
            help="The deepest intraday mark-to-market loss on any day, per lot: how far underwater the position went before the day closed, even if it recovered."
          />
          <SortTh
            label="Max drawdown"
            sortKey="maxDrawdown"
            sort={sort}
            onSort={onSort}
            help="The largest fall in cumulative net P&L from a peak to a later low, per lot, using day-end values."
          />
          <Th align="right">Cumulative</Th>
        </THead>
        <tbody>
          {sorted.map((row) => {
            const st = row.stats;
            const ratio = st.thin ? 'text-faint' : '';
            return (
              <TRow key={row.id}>
                <Td className="max-w-[16rem]">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: seriesCssColor(row.colorIndex) }}
                    />
                    <span className="truncate font-medium" title={row.name}>
                      {row.name}
                    </span>
                  </span>
                </Td>
                <Td numeric className="text-xs text-muted" title={`Strategy version ${row.sha}`}>
                  {row.sha.slice(0, 7)}
                </Td>
                <Td align="right" numeric>
                  {formatInt(st.days)}
                </Td>
                <Td
                  align="right"
                  numeric
                  className={cn('font-semibold', st.days ? pnlClass(st.total) : 'text-faint')}
                >
                  {st.days ? formatPnl(st.total) : EMPTY}
                </Td>
                <Td align="right" numeric>
                  {st.days ? formatInt(st.up) : EMPTY}
                </Td>
                <Td align="right" numeric className={ratio}>
                  {formatPct(st.winRate, 0)}
                </Td>
                <Td
                  align="right"
                  numeric
                  className={st.thin ? ratio : pnlClass(st.expectancy ?? 0)}
                >
                  {formatPnl(st.expectancy)}
                </Td>
                <Td align="right" numeric className={ratio}>
                  {formatNumber(st.profitFactor, 2)}
                </Td>
                <Td align="right" numeric className={pnlClass(st.worst ?? 0)}>
                  {formatPnl(st.worst)}
                </Td>
                <Td align="right" numeric className={pnlClass(row.worstMtm ?? 0)}>
                  {formatPnl(row.worstMtm)}
                </Td>
                <Td align="right" numeric className={pnlClass(st.maxDrawdown)}>
                  {st.days ? formatPnl(st.maxDrawdown) : EMPTY}
                </Td>
                <Td align="right">
                  <Sparkline row={row} />
                </Td>
              </TRow>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
