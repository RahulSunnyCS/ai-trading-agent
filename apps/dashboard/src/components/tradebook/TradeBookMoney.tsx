'use client';

/**
 * The Money view: money in and out of the accounts from the brokers' ledger e-mails (a deposit is
 * never profit), the collateral interest, margin pressure, the time-weighted return with deposits
 * taken out, and the capital line the figures are measured against.
 */

import type { Time } from 'lightweight-charts';
import { useEffect, useMemo, useRef } from 'react';

import { useChart } from '../../hooks/useChart';
import { type TradeBookRange, useTradeBookMoney } from '../../hooks/useTradeBook';
import { getChartTheme, getSeriesPalette, pickSeries } from '../../lib/chartTheme';
import { cn } from '../../lib/cn';
import { EMPTY, formatDay, formatInr, formatInt, formatPct } from '../../lib/format';
import {
  MARGIN_HIGH_PCT,
  accountLabel,
  eventAmount,
  eventLabel,
  eventsFor,
  moneyTotals,
} from '../../lib/tradeBookView';
import type { TradeBookDay, TradeBookSummaryBlock } from '../../types/tradeBook';
import { Badge } from '../ui/Badge';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { Inr, Loaded, TradeBookWidget } from './parts';

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'positive' | 'negative' | 'warning' | undefined;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface px-4 py-3 shadow-card">
      <p className="truncate text-xs text-faint">{label}</p>
      <p
        className={cn(
          'metric mt-0.5 truncate text-2xl font-medium',
          tone === 'positive' && 'text-positive',
          tone === 'negative' && 'text-negative',
          tone === 'warning' && 'text-warning',
          !tone && 'text-foreground',
        )}
      >
        {value}
      </p>
      <p className="truncate text-xs text-faint">{sub}</p>
    </div>
  );
}

function CapitalChart({ rows }: { rows: TradeBookDay[] }) {
  const box = useRef<HTMLDivElement>(null);
  const { chartRef, ready, theme } = useChart(box, false, 260);
  const points = useMemo(
    () => rows.flatMap((r) => (r.capital === null ? [] : [{ day: r.day, value: r.capital }])),
    [rows],
  );
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || chart === null) return;
    const t = getChartTheme(theme);
    chart.applyOptions({
      localization: { priceFormatter: (v: number) => formatInr(v, { compact: true }) },
    });
    const line = chart.addLineSeries({
      color: pickSeries(getSeriesPalette(theme), 0),
      lineWidth: 2,
      lineType: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    line.setData(points.map((p) => ({ time: p.day as Time, value: p.value })));
    line.setMarkers(
      rows
        .filter((r) => r.deposits > 0 || r.withdrawals > 0)
        .map((r) => ({
          time: r.day as Time,
          position: r.deposits > 0 ? ('belowBar' as const) : ('aboveBar' as const),
          shape: r.deposits > 0 ? ('arrowUp' as const) : ('arrowDown' as const),
          color: r.deposits > 0 ? t.positive : t.negative,
          text: formatInr(r.deposits > 0 ? r.deposits : -r.withdrawals, { compact: true }),
        })),
    );
    chart.timeScale().fitContent();
    return () => {
      if (chartRef.current) chartRef.current.removeSeries(line);
    };
  }, [chartRef, ready, theme, points, rows]);
  if (!points.length) {
    return <p className="text-xs text-faint">No capital typed or read for this period.</p>;
  }
  return <div ref={box} className="w-full" style={{ height: 260 }} />;
}

export function TradeBookMoney({
  range,
  account,
  allAccounts,
  summary,
  rows,
  onOpenDay,
}: {
  range: TradeBookRange;
  account: string | null;
  allAccounts: string[];
  summary: TradeBookSummaryBlock | null;
  rows: TradeBookDay[];
  onOpenDay: (day: string) => void;
}) {
  const res = useTradeBookMoney(range);
  return (
    <Loaded data={res.data} loading={res.loading} error={res.error} retry={res.refetch} rows={6}>
      {(data) => {
        const events = eventsFor(data.events, account);
        const t = moneyTotals(events);
        const shown = [...events].reverse();
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Tile
                label="Return on money in the account"
                value={formatPct(summary?.time_weighted_return_pct, 1, { unit: 'percent' })}
                sub="time-weighted on each day's capital; deposits taken out"
                tone={
                  summary?.time_weighted_return_pct == null
                    ? undefined
                    : summary.time_weighted_return_pct >= 0
                      ? 'positive'
                      : 'negative'
                }
              />
              <Tile
                label="Money in · out"
                value={`${formatInr(t.deposits, { compact: true })} · ${formatInr(t.withdrawals, { compact: true })}`}
                sub={`${t.depositCount} deposits · ${t.withdrawalCount} payouts · ${t.settlements} settlements`}
              />
              <Tile
                label="Collateral interest"
                value={t.interest ? formatInr(-t.interest) : EMPTY}
                sub={
                  t.interestDays
                    ? `${t.interestDays} days · avg ${formatInr(t.interest / t.interestDays)}`
                    : 'no interest e-mails in this period'
                }
                tone={t.interest ? 'negative' : undefined}
              />
              <Tile
                label={`Margin above ${MARGIN_HIGH_PCT}%`}
                value={`${formatInt(t.marginHigh)} times`}
                sub={`of ${formatInt(t.marginWarnings)} margin shortfall warnings`}
                tone={t.marginHigh ? 'warning' : undefined}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <TradeBookWidget
                title="Capital"
                description="The capital each day's return is measured on: typed, imported from the sheet, or read at 15:50 for the next session; a day without one carries the last. Arrows mark deposits and payouts."
              >
                {() => <CapitalChart rows={rows} />}
              </TradeBookWidget>
              <TradeBookWidget
                title="Ledger events"
                badge={`${formatInt(events.length)}`}
                description="From the brokers' e-mails; a deposit is never profit."
              >
                {() =>
                  shown.length ? (
                    <Table maxHeight={420}>
                      <THead>
                        <Th dense>Day</Th>
                        <Th dense>Account</Th>
                        <Th dense>Event</Th>
                        <Th dense align="right">
                          Amount
                        </Th>
                      </THead>
                      <tbody>
                        {shown.map((e, i) => (
                          <TRow
                            key={`${e.day}-${e.kind}-${i}`}
                            onClick={() => onOpenDay(e.day)}
                            className="whitespace-nowrap"
                          >
                            <Td dense>{formatDay(e.day, { weekday: true }).slice(0, 10)}</Td>
                            <Td dense className="text-muted">
                              {accountLabel(`${e.broker}/${e.account ?? ''}`, allAccounts)}
                            </Td>
                            <Td dense>
                              {e.kind === 'margin_warning' ? (
                                <Badge tone="warning">
                                  margin {formatPct(e.utilisation_pct, 1, { unit: 'percent' })}
                                </Badge>
                              ) : (
                                eventLabel(e)
                              )}
                              {e.kind === 'margin_warning' && e.time ? (
                                <span className="text-faint"> {e.time.slice(0, 5)}</span>
                              ) : null}
                            </Td>
                            <Td dense numeric align="right">
                              <Inr value={eventAmount(e)} />
                            </Td>
                          </TRow>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <p className="text-xs text-faint">No ledger e-mails in this period.</p>
                  )
                }
              </TradeBookWidget>
            </div>
          </div>
        );
      }}
    </Loaded>
  );
}
