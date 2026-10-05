'use client';

import { useMemo, useState } from 'react';

import {
  EMPTY,
  formatInr,
  formatInt,
  formatIstDate,
  formatIstDateTimeShort,
  formatIstTime,
  formatNumber,
  formatPct,
} from '../../lib/format';
import { regimeBadge } from '../../lib/regimeMeta';
import {
  DEFAULT_TRADE_SORT,
  type TradeRow,
  type TradeSort,
  type TradeSortKey,
  formatHoldTime,
  nextTradeSort,
  optionalColumns,
  sortTradeRows,
} from '../../lib/trades';
import { Badge } from '../ui/Badge';
import { THead, TRow, Table, Td } from '../ui/Table';
import { SortTh } from './SortTh';

const dash = <span className="text-faint">{EMPTY}</span>;

function toneClass(value: number | null): string {
  if (value === null || value === 0) return 'text-muted';
  return value > 0 ? 'text-positive' : 'text-negative';
}

function PnlCell({ value }: { value: number | null }) {
  if (value === null) return dash;
  return (
    <span className={`font-medium ${toneClass(value)}`}>
      {formatInr(value, { dp: 2, sign: true })}
    </span>
  );
}

function PctCell({ value }: { value: number | null }) {
  if (value === null) return dash;
  return <span className={toneClass(value)}>{formatPct(value, 1, { sign: true })}</span>;
}

function contractText(row: TradeRow): string | null {
  const parts = [
    row.symbol,
    row.strike === null ? null : formatNumber(row.strike, 2, { trim: true }),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' ') : null;
}

function ExitCell({ row }: { row: TradeRow }) {
  if (row.exitTime === null) return dash;
  const sameDay = formatIstDate(row.exitTime) === formatIstDate(row.entryTime);
  return (
    <div className="leading-tight">
      <div>{sameDay ? formatIstTime(row.exitTime) : formatIstDateTimeShort(row.exitTime)}</div>
      <div className="text-xs text-faint">held {formatHoldTime(row.durationMs)}</div>
    </div>
  );
}

/**
 * The trades table: sortable headers (aria-sort), the first column sticky when the table
 * scrolls sideways, and the header sticky inside its own scroll box. Contract, Regime and
 * VIX columns appear only when some row carries the field.
 */
export function TradesTable({ rows }: { rows: TradeRow[] }) {
  const [sort, setSort] = useState<TradeSort>(DEFAULT_TRADE_SORT);
  const sorted = useMemo(() => sortTradeRows(rows, sort), [rows, sort]);
  const show = useMemo(() => optionalColumns(rows), [rows]);

  const onSort = (key: TradeSortKey) => setSort((current) => nextTradeSort(current, key));
  const th = (
    label: string,
    key: TradeSortKey,
    align: 'left' | 'right' = 'left',
    help?: string,
  ) => (
    <SortTh
      label={label}
      sortKey={key}
      activeKey={sort.key}
      dir={sort.dir}
      onSort={onSort}
      align={align}
      {...(help ? { help } : {})}
    />
  );

  return (
    <Table stickyFirstCol maxHeight="70vh">
      <THead>
        {th('Personality', 'personality')}
        {th('Status', 'status')}
        {show.contract ? th('Contract', 'contract') : null}
        {th('Entry (IST)', 'entry')}
        {th('Exit · held', 'exit')}
        {th('Lots × size', 'quantity', 'right')}
        {th('Straddle @ entry', 'straddle', 'right')}
        {th('Net P&L', 'net', 'right')}
        {th(
          'P&L %',
          'pnlPct',
          'right',
          'Net P&L as a share of the premium collected: net ÷ (straddle at entry × lots × lot size).',
        )}
        {th('Exit reason', 'reason')}
        {show.regime
          ? th('Regime', 'regime', 'left', "The day's regime tag, filled in by the EOD job.")
          : null}
        {show.vix ? th('VIX @ entry', 'vix', 'right') : null}
      </THead>
      <tbody>
        {sorted.map((row) => {
          const regime = row.regime === null ? null : regimeBadge(row.regime);
          const contract = contractText(row);
          return (
            <TRow key={row.id}>
              <Td className="whitespace-nowrap font-medium">
                <span className={row.personalityId === null ? 'text-muted' : undefined}>
                  {row.personalityName}
                </span>
              </Td>
              <Td>
                <Badge status={row.status === 'open' ? 'open' : 'closed'} dot>
                  {row.status === 'open' ? 'Open' : 'Closed'}
                </Badge>
              </Td>
              {show.contract ? (
                <Td className="whitespace-nowrap">
                  {contract ?? dash}
                  {row.expiry !== null ? (
                    <div className="text-xs text-faint">exp {formatIstDate(row.expiry)}</div>
                  ) : null}
                </Td>
              ) : null}
              <Td numeric className="whitespace-nowrap text-muted">
                {formatIstDateTimeShort(row.entryTime)}
              </Td>
              <Td numeric className="whitespace-nowrap text-muted">
                <ExitCell row={row} />
              </Td>
              <Td numeric align="right" className="whitespace-nowrap">
                {row.lots === null || row.lotSize === null
                  ? dash
                  : `${formatInt(row.lots)} × ${formatInt(row.lotSize)}`}
              </Td>
              <Td numeric align="right">
                {row.straddleAtEntry === null ? dash : formatInr(row.straddleAtEntry, { dp: 2 })}
              </Td>
              <Td numeric align="right" className="whitespace-nowrap">
                <PnlCell value={row.netPnl} />
              </Td>
              <Td numeric align="right">
                <PctCell value={row.pnlPct} />
              </Td>
              <Td className="whitespace-nowrap text-muted">
                {row.exitReasonLabel ? (
                  <span title={row.exitReason ?? undefined}>{row.exitReasonLabel}</span>
                ) : (
                  dash
                )}
              </Td>
              {show.regime ? (
                <Td>
                  {regime ? (
                    <span title={regime.title}>
                      <Badge tone={regime.tone}>{regime.text}</Badge>
                    </span>
                  ) : (
                    dash
                  )}
                </Td>
              ) : null}
              {show.vix ? (
                <Td numeric align="right">
                  {row.vixAtEntry === null ? dash : formatNumber(row.vixAtEntry, 2)}
                </Td>
              ) : null}
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}
