'use client';

/**
 * The F&O view's widgets below the chart: the summary block, the monthly heat cells with the FY
 * table, and the accounts with the year's charges by kind. Every figure is the API's.
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

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'positive' | 'negative' | undefined;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-2 px-3 py-2.5">
      <p className="truncate text-xs text-faint">{label}</p>
      <p
        className={cn(
          'metric mt-0.5 truncate text-lg font-medium',
          tone === 'positive' && 'text-positive',
          tone === 'negative' && 'text-negative',
          !tone && 'text-foreground',
        )}
      >
        {value}
      </p>
      <p className="truncate text-xs text-muted">{sub}</p>
    </div>
  );
}

function signTone(v: number | null): 'positive' | 'negative' | undefined {
  if (v === null || v === 0) return undefined;
  return v > 0 ? 'positive' : 'negative';
}

/** The sheet's summary block over the picked year. */
export function TradeBookSummaryCells({ s }: { s: TradeBookSummaryBlock }) {
  const pctOf = (v: number | null) =>
    v === null ? 'no capital typed' : `${formatPct(v, 1, { unit: 'percent' })} of capital`;
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Cell
        label="Net profit"
        value={formatInr(s.net)}
        sub={pctOf(s.profit_pct)}
        tone={signTone(s.net)}
      />
      <Cell
        label="Max drawdown"
        value={formatInr(s.max_drawdown)}
        sub={pctOf(s.max_drawdown_pct)}
        tone={s.max_drawdown < 0 ? 'negative' : undefined}
      />
      <Cell
        label="Longest drawdown"
        value={`${formatInt(s.longest_drawdown)} sessions`}
        sub="below the running peak"
      />
      <Cell
        label="Win days"
        value={formatPct(s.win_pct, 0, { unit: 'percent' })}
        sub={`${s.win_days} won · ${s.loss_days} lost`}
      />
      <Cell
        label="Avg win day"
        value={formatInr(s.avg_win)}
        sub="profit on a winning day"
        tone={signTone(s.avg_win)}
      />
      <Cell
        label="Avg loss day"
        value={formatInr(s.avg_loss)}
        sub="loss on a losing day"
        tone={signTone(s.avg_loss)}
      />
      <Cell
        label="Avg day"
        value={formatInr(s.avg_day)}
        sub={`net per traded day (${formatInt(s.traded_sessions)})`}
        tone={signTone(s.avg_day)}
      />
      <Cell
        label="Charges"
        value={formatInr(s.charges)}
        sub={
          s.charge_profit_pct === null
            ? 'no net profit to compare'
            : `${formatPct(s.charge_profit_pct, 0, { unit: 'percent' })} of net profit`
        }
      />
    </div>
  );
}

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
