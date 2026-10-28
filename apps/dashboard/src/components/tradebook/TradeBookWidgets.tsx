'use client';

/**
 * The F&O view's widgets below the chart: the monthly heat cells with the FY table, and the
 * accounts with the year's charges by kind. Every figure is the API's. (The sheet's summary block
 * is folded into the headline and its secondary line.)
 */

import { useState } from 'react';

import { cn } from '../../lib/cn';
import {
  EMPTY,
  formatDay,
  formatDayShort,
  formatInr,
  formatInt,
  formatPct,
} from '../../lib/format';
import {
  accountLabel,
  fyLabel,
  heatClass,
  monthCells,
  parseFy,
  yearChargeParts,
} from '../../lib/tradeBookView';
import type {
  TradeBookAccount,
  TradeBookFiscalYear,
  TradeBookMonth,
  TradeBookSummaryBlock,
} from '../../types/tradeBook';
import { SegmentedControl } from '../ui/SegmentedControl';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { ChargeBar, Inr } from './parts';

/** The monthly tab: April to March as heat cells, % of capital or rupees, and the FY rows. */
export function TradeBookMonths({
  start,
  months,
  years,
  lastDay,
  onPickYear,
}: {
  start: number;
  months: TradeBookMonth[];
  years: TradeBookFiscalYear[];
  lastDay: string | null;
  onPickYear: (start: number) => void;
}) {
  const [unit, setUnit] = useState<'pct' | 'inr'>('pct');
  const cells = monthCells(start, months);
  const scale = Math.max(
    0,
    ...cells.map((c) => Math.abs((unit === 'pct' ? c.data?.pct : c.data?.profit) ?? 0)),
  );
  const current = fyLabel(start).slice(3);
  return (
    <div className="space-y-3">
      <SegmentedControl
        ariaLabel="Monthly figure"
        size="sm"
        value={unit}
        onChange={setUnit}
        options={[
          { value: 'pct', label: '% of capital' },
          { value: 'inr', label: '₹' },
        ]}
      />
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 lg:grid-cols-12">
        {cells.map((c) => {
          const value = unit === 'pct' ? (c.data?.pct ?? null) : (c.data?.profit ?? null);
          return (
            <div
              key={c.month}
              className={cn(
                'rounded-md px-1 py-1.5 text-center text-[11px]',
                heatClass(value, scale),
              )}
              title={
                c.data
                  ? `${c.label}: ${formatInr(c.data.profit)}, ${c.data.sessions} sessions, charges ${formatInr(c.data.charges)}`
                  : `${c.label}: no sessions`
              }
            >
              <p className="text-muted">{c.label}</p>
              <p
                className={cn(
                  'metric font-medium',
                  value === null && 'text-faint',
                  value !== null && value > 0 && 'text-positive',
                  value !== null && value < 0 && 'text-negative',
                )}
              >
                {c.data === null
                  ? EMPTY
                  : unit === 'pct'
                    ? formatPct(c.data.pct, 1, { unit: 'percent', sign: true })
                    : formatInr(c.data.profit, { compact: true })}
              </p>
              <p className="metric text-faint">
                {c.data?.avg3_pct == null
                  ? '·'
                  : `3m ${formatPct(c.data.avg3_pct, 1, { unit: 'percent' })}`}
              </p>
            </div>
          );
        })}
      </div>
      <Table>
        <THead>
          <Th>Year</Th>
          <Th align="right">Profit</Th>
          <Th align="right">% of capital</Th>
          <Th align="right">Avg capital</Th>
          <Th align="right">Sessions</Th>
          <Th align="right">Max drawdown</Th>
        </THead>
        <tbody>
          {years.map((y) => {
            const ys = parseFy(y.fy);
            const isCurrent = y.fy === current;
            return (
              <TRow
                key={y.fy}
                className="whitespace-nowrap"
                selected={isCurrent}
                onClick={ys === null || isCurrent ? undefined : () => onPickYear(ys)}
              >
                <Td>
                  FY {y.fy}
                  {isCurrent && lastDay ? (
                    <span className="text-faint"> to {formatDayShort(lastDay)}</span>
                  ) : null}
                </Td>
                <Td numeric align="right">
                  <Inr value={y.profit} />
                </Td>
                <Td numeric align="right">
                  {formatPct(y.pct, 2, { unit: 'percent' })}
                </Td>
                <Td numeric align="right">
                  {formatInr(y.capital)}
                </Td>
                <Td numeric align="right">
                  {formatInt(y.sessions)}
                </Td>
                <Td numeric align="right">
                  <Inr value={y.max_drawdown} />
                </Td>
              </TRow>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

/** Each account's net, capital, return and charge / profit, the algo fees, and charges by kind. */
export function TradeBookAccounts({
  accounts,
  summary,
  allAccounts,
  showAlgoFees,
}: {
  accounts: TradeBookAccount[];
  summary: TradeBookSummaryBlock;
  allAccounts: string[];
  showAlgoFees: boolean;
}) {
  return (
    <div className="space-y-4">
      <Table>
        <THead>
          <Th>Account</Th>
          <Th align="right">Net</Th>
          <Th align="right">Capital</Th>
          <Th align="right">Return</Th>
          <Th align="right">Charge/profit</Th>
        </THead>
        <tbody>
          {accounts.map((a) => (
            <TRow key={a.account} className="whitespace-nowrap">
              <Td className="max-w-[14rem] truncate" title={accountLabel(a.account, allAccounts)}>
                {accountLabel(a.account, allAccounts)}
              </Td>
              <Td numeric align="right">
                <Inr value={a.sessions ? a.net : null} />
              </Td>
              <Td numeric align="right">
                {formatInr(a.capital)}
              </Td>
              <Td numeric align="right">
                {formatPct(a.profit_pct, 1, { unit: 'percent' })}
              </Td>
              <Td numeric align="right">
                {formatPct(a.charge_profit_pct, 1, { unit: 'percent' })}
              </Td>
            </TRow>
          ))}
          {showAlgoFees ? (
            <TRow className="whitespace-nowrap">
              <Td className="text-muted">Algo fees (the sheet's formula)</Td>
              <Td numeric align="right">
                <Inr value={summary.algo_fees ? -summary.algo_fees : null} />
              </Td>
              <Td colSpan={3}>{null}</Td>
            </TRow>
          ) : null}
        </tbody>
      </Table>
      <div>
        <p className="mb-2 text-xs text-faint">Charges by kind</p>
        <ChargeBar parts={yearChargeParts(summary)} />
        <p className="mt-2 text-xs text-faint">
          Collateral interest and the other debits (an estimate: ₹1,000 per broker a year) are shown
          beside the charges, never inside the net: the sheet never had them. The notes' charges
          split by kind for one day are in its drawer.
        </p>
      </div>
    </div>
  );
}
