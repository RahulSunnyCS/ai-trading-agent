'use client';

/**
 * One session in the drawer: the day's net and charges, each account's note (or why there is
 * none), every charge by kind, the fills paired into trades with their source and best / worst
 * point, the day's market context, the ledger e-mails and the typed inputs with Edit.
 */

import { ChevronLeft, ChevronRight, Pencil } from 'lucide-react';
import { useState } from 'react';

import { useTradeBookDay } from '../../hooks/useTradeBook';
import {
  EMPTY,
  formatDay,
  formatDayShort,
  formatInr,
  formatInt,
  formatNumber,
  formatPct,
} from '../../lib/format';
import {
  accountLabel,
  contractLabel,
  dayChargeParts,
  dayState,
  eventAmount,
  eventLabel,
  lineStatus,
  tripTimes,
} from '../../lib/tradeBookView';
import type { TradeBookDayDetail } from '../../types/tradeBook';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { TradeBookInputsDialog } from './TradeBookInputsDialog';
import { ChargeBar, Inr, Loaded, SourceBadge, Stat } from './parts';

function contextText(d: TradeBookDayDetail): string {
  const parts: string[] = [];
  if (d.context.vix_open !== null) {
    parts.push(
      `VIX ${formatNumber(d.context.vix_open, 1)}${d.context.vix_pct !== null ? ` (${formatInt(d.context.vix_pct)} pct)` : ''}`,
    );
  }
  for (const [name, ix] of Object.entries(d.context.indices)) {
    if (!ix) continue;
    const bits = [
      ix.gap_pct !== null
        ? `gap ${formatPct(ix.gap_pct, 1, { unit: 'percent', sign: true })}`
        : null,
      ix.range_pct !== null ? `range ${formatPct(ix.range_pct, 1, { unit: 'percent' })}` : null,
      ix.expiry_day ? 'expiry' : null,
    ].filter(Boolean);
    parts.push(`${name} ${bits.join(', ')}`);
  }
  return parts.length ? parts.join(' · ') : 'no market data stored for this day';
}

const TRIPS_SHOWN = 12;
/** The F&O brokers; the Zerodha notes are Momentum's and live on its view. */
const FNO_BROKERS = ['finvasia', 'angelone'];

function DayBody({
  d,
  allAccounts,
  onEdit,
}: {
  d: TradeBookDayDetail;
  allAccounts: string[];
  onEdit: () => void;
}) {
  const [allTrips, setAllTrips] = useState(false);
  const row = d.row;
  const lines = d.lines.filter((l) => FNO_BROKERS.includes(l.broker));
  const fills = lines.reduce((n, l) => n + (l.status === 'note' ? l.trades : 0), 0);
  const trips = allTrips ? d.trips : d.trips.slice(0, TRIPS_SHOWN);
  const manual = d.manual;
  const capital =
    manual?.capital_total != null
      ? formatInr(manual.capital_total, { compact: true })
      : manual?.capital
        ? [manual.capital.finvasia, manual.capital.angelone]
            .map((v) => (v == null ? EMPTY : formatInr(v, { compact: true })))
            .join(' · ')
        : null;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Net profit">
          {row?.profit == null ? (
            <span className="text-faint">no note</span>
          ) : (
            <Inr value={row.profit} />
          )}
        </Stat>
        <Stat label="Charges">{row?.charges == null ? EMPTY : formatInr(row.charges)}</Stat>
        <Stat label="Fills">{formatInt(fills)}</Stat>
      </div>
      <p className="text-xs text-muted">
        <span className="text-faint">Context </span>
        {contextText(d)}
      </p>

      <div>
        <p className="mb-1 text-xs text-faint">Accounts</p>
        <Table>
          <THead>
            <Th dense>Account</Th>
            <Th dense align="right">
              Obligation
            </Th>
            <Th dense align="right">
              Charges
            </Th>
            <Th dense align="right">
              Net
            </Th>
          </THead>
          <tbody>
            {lines.map((l) => (
              <TRow key={`${l.broker}/${l.account}`}>
                <Td dense className="whitespace-nowrap">
                  {accountLabel(`${l.broker}/${l.account}`, allAccounts)}
                  {l.status !== 'note' ? (
                    <Badge tone={l.status === 'failed' ? 'warning' : 'neutral'} className="ml-2">
                      {lineStatus(l.status)}
                    </Badge>
                  ) : null}
                </Td>
                <Td dense numeric align="right">
                  {formatInr(l.fno?.payin_payout_obligation)}
                </Td>
                <Td dense numeric align="right">
                  {formatInr(l.fno?.total_charges)}
                </Td>
                <Td dense numeric align="right">
                  <Inr value={l.fno?.final_net} />
                </Td>
              </TRow>
            ))}
          </tbody>
        </Table>
        {lines.some((l) => l.status === 'failed' && l.reason) ? (
          <p className="mt-1 text-xs text-warning">
            {lines
              .filter((l) => l.status === 'failed' && l.reason)
              .map((l) => l.reason)
              .join(' · ')}
          </p>
        ) : null}
      </div>

      <div>
        <p className="mb-2 text-xs text-faint">Charges</p>
        <ChargeBar parts={dayChargeParts(d)} amounts />
      </div>

      <div>
        <p className="mb-1 text-xs text-faint">Fills, paired into trades</p>
        {d.trips.length === 0 ? (
          <p className="text-xs text-faint">
            No round trips: no note, or its trades did not add up to its obligation.
          </p>
        ) : (
          <>
            <Table>
              <THead>
                <Th dense>Time</Th>
                <Th dense>Contract</Th>
                <Th dense>Source</Th>
                <Th dense align="right">
                  Qty
                </Th>
                <Th dense align="right">
                  In → out
                </Th>
                <Th dense align="right">
                  Worst
                </Th>
                <Th dense align="right">
                  Best
                </Th>
                <Th dense align="right">
                  P&amp;L
                </Th>
              </THead>
              <tbody>
                {trips.map((t, i) => (
                  <TRow key={`${t.account}-${contractLabel(t)}-${i}`} className="whitespace-nowrap">
                    <Td dense numeric align="right">
                      {t.entry_day !== t.day ? (
                        <span className="text-faint">from {formatDayShort(t.entry_day)}</span>
                      ) : (
                        (tripTimes(t) ?? <span className="text-faint">no times</span>)
                      )}
                    </Td>
                    <Td dense>{contractLabel(t)}</Td>
                    <Td dense>
                      <SourceBadge source={t.source} />
                    </Td>
                    <Td dense numeric align="right">
                      {formatInt(t.qty)}
                    </Td>
                    <Td dense numeric align="right">
                      {formatNumber(t.entry_price, 1)} → {formatNumber(t.exit_price, 1)}
                    </Td>
                    <Td dense numeric align="right">
                      <Inr value={t.mae} />
                    </Td>
                    <Td dense numeric align="right">
                      <Inr value={t.mfe} />
                    </Td>
                    <Td dense numeric align="right">
                      {t.pnl === null ? (
                        <span className="text-faint">{t.status}</span>
                      ) : (
                        <Inr value={t.pnl} />
                      )}
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
            {d.trips.length > TRIPS_SHOWN ? (
              <Button size="sm" variant="ghost" onClick={() => setAllTrips((v) => !v)}>
                {allTrips ? 'Show fewer' : `${d.trips.length - TRIPS_SHOWN} more trades`}
              </Button>
            ) : null}
          </>
        )}
      </div>

      {d.ledger.length ? (
        <div>
          <p className="mb-1 text-xs text-faint">Ledger e-mails</p>
          <ul className="space-y-1 text-xs">
            {d.ledger.map((e, i) => (
              <li key={`${e.kind}-${i}`} className="flex justify-between gap-3">
                <span className="text-muted">
                  {eventLabel(e)}
                  {e.kind === 'margin_warning' && e.utilisation_pct != null
                    ? ` ${formatPct(e.utilisation_pct, 1, { unit: 'percent' })}${e.time ? ` at ${e.time.slice(0, 5)}` : ''}`
                    : ''}
                  <span className="text-faint">
                    {' '}
                    · {accountLabel(`${e.broker}/${e.account ?? ''}`, allAccounts)}
                  </span>
                </span>
                <Inr value={eventAmount(e)} className="metric" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-strong px-3 text-xs text-muted">
          Algos{' '}
          <span className="metric text-foreground">
            {manual?.algos == null ? 'not typed' : formatInt(manual.algos)}
          </span>
          {manual?.algos != null && row ? (
            <span className="text-faint">· fee {formatInr(row.algo_fees)}</span>
          ) : null}
        </span>
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-strong px-3 text-xs text-muted">
          Capital <span className="metric text-foreground">{capital ?? 'not typed'}</span>
          {row?.capital_source === 'carried' ? <span className="text-faint">· carried</span> : null}
          {manual?.source ? <span className="text-faint">· {manual.source}</span> : null}
        </span>
        <Button size="sm" variant="secondary" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Edit inputs
        </Button>
      </div>
    </div>
  );
}

export function TradeBookDayDrawer({
  day,
  days,
  allAccounts,
  onDay,
  onSaved,
}: {
  day: string | null;
  /** Every day of the year, in order, for previous / next. */
  days: string[];
  allAccounts: string[];
  onDay: (day: string | null) => void;
  onSaved: () => void;
}) {
  const detail = useTradeBookDay(day);
  const [editing, setEditing] = useState(false);
  // The sessions either side, by date: a day not in the list (a weekend ledger e-mail, another
  // account's session) still steps to its neighbours.
  const prev = day ? days.filter((d) => d < day).at(-1) : undefined;
  const next = day ? days.find((d) => d > day) : undefined;
  const row = detail.data?.day === day ? detail.data?.row : null;
  const state = row ? dayState(row) : null;
  return (
    <Drawer
      size="lg"
      open={day !== null}
      onOpenChange={(open) => {
        if (!open) onDay(null);
      }}
      title={day ? formatDay(day, { weekday: true }) : ''}
      subtitle={state ? state.label : undefined}
      actions={
        <>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous day"
            disabled={!prev}
            onClick={() => prev && onDay(prev)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next day"
            disabled={!next}
            onClick={() => next && onDay(next)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </>
      }
    >
      <Loaded
        data={detail.data?.day === day ? detail.data : null}
        loading={detail.loading}
        error={detail.error}
        retry={detail.refetch}
        rows={8}
      >
        {(d) => (
          <>
            <DayBody d={d} allAccounts={allAccounts} onEdit={() => setEditing(true)} />
            <TradeBookInputsDialog
              day={d.day}
              manual={d.manual}
              open={editing}
              onOpenChange={setEditing}
              onSaved={() => {
                detail.refetch();
                onSaved();
              }}
            />
          </>
        )}
      </Loaded>
    </Drawer>
  );
}
