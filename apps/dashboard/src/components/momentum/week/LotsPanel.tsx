'use client';

import { useEffect, useRef } from 'react';

import { usePolledResource } from '../../../hooks/usePolledResource';
import { cn } from '../../../lib/cn';
import {
  EMPTY,
  formatDayShort,
  formatInr,
  formatInt,
  formatIstDateTime,
} from '../../../lib/format';
import {
  closeDaysText,
  holdsText,
  lastOrdersText,
  lotState,
  plannedGap,
  plannedText,
} from '../../../lib/momentumLots';
import type { MomentumLot, MomentumLotsView } from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import { RefreshButton } from '../../ui/RefreshButton';
import { Skeleton } from '../../ui/Skeleton';
import { StateMessage } from '../../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';

type LotsView = Extract<MomentumLotsView, { available: true }>;

/**
 * Momentum › This week's Lots panel (BL-142 Phase 4): the followed strategy's real lots on Kite,
 * one row per lot (one per sleeve): the shares the ledger has booked to it, their value at the last
 * close, its last and next rebalance Friday, whether it is due this Friday and what the last Friday
 * orders said for it. Below, what Kite holds beyond the lots, beside what those orders told each
 * lot to buy. The same ledger as `mbt lots show`; read-only (nothing here reads Kite or books a
 * share). Left out when the headline is not followed lot by lot.
 *
 * Always about now: the ledger and this coming Friday, whatever week the page shows
 * (`shownWeek`: the `?week=` the reader picked, said when it differs). `ordersVersion`
 * changes when Your orders made or reloaded orders, or its settings changed: the panel then
 * reads the ledger again.
 */
export function LotsPanel({
  shownWeek = null,
  ordersVersion = 0,
}: { shownWeek?: string | null; ordersVersion?: number } = {}) {
  const lots = usePolledResource<MomentumLotsView>('/api/momentum/lots', { cache: true });
  const refetch = lots.refetch;
  const seen = useRef(ordersVersion);
  useEffect(() => {
    if (seen.current === ordersVersion) return;
    seen.current = ordersVersion;
    refetch();
  }, [ordersVersion, refetch]);
  const view = lots.data;
  if (view && !view.available) return null;
  return (
    <Card flush>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <h2 className="text-base font-semibold text-foreground">Your lots</h2>
        {view ? <span className="text-xs text-muted">for {view.group}</span> : null}
        {view?.snapshot ? (
          <Badge tone={view.snapshot.today ? 'positive' : 'warning'}>
            Kite · {view.snapshot.today ? 'read' : 'last read'}{' '}
            {formatIstDateTime(view.snapshot.synced_at)}
          </Badge>
        ) : view ? (
          <Badge tone="warning">No Kite snapshot yet</Badge>
        ) : null}
        <span className="ml-auto">
          <RefreshButton onClick={lots.refetch} loading={lots.loading} />
        </span>
      </div>
      {lots.error ? (
        <p className="px-4 pt-2 text-xs text-negative">Could not load the lots: {lots.error}</p>
      ) : null}
      {!view ? (
        lots.error ? (
          <div className="px-4 py-4">
            <StateMessage
              variant="error"
              title="Could not load your lots"
              description={lots.error}
            />
          </div>
        ) : (
          <div className="space-y-2 px-4 py-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )
      ) : (
        <LotsBody view={view} shownWeek={shownWeek} />
      )}
    </Card>
  );
}

function LotsBody({ view, shownWeek }: { view: LotsView; shownWeek: string | null }) {
  const friday = formatDayShort(view.week, { weekday: true });
  return (
    <>
      {shownWeek && shownWeek !== view.week ? (
        <p className="px-4 pt-1 text-xs text-warning">
          The lots are as they stand now, for {friday}, not the week of{' '}
          {formatDayShort(shownWeek, { weekday: true })} shown above.
        </p>
      ) : null}
      <p className="px-4 pt-1 text-xs text-muted">
        One lot per sleeve; only the lot due on a Friday trades. Values at{' '}
        {closeDaysText(view.close_days)}. Free cash on Kite {formatInr(view.snapshot?.cash)}
        {view.holdings_source !== 'kite'
          ? '. Your orders read another holdings source, so they are not planned lot by lot.'
          : '.'}
      </p>
      <Table className="mt-2">
        <THead>
          <Th>Lot</Th>
          <Th>{friday}</Th>
          <Th>Holds</Th>
          <Th align="right">Value</Th>
          <Th>Last rebalance</Th>
          <Th>Next rebalance</Th>
          <Th>Last orders</Th>
        </THead>
        <tbody>
          {view.lots.map((lot) => (
            <LotRow key={lot.id} lot={lot} ordersWeek={view.last_orders?.week ?? null} />
          ))}
          <TRow>
            <Td colSpan={3} className="font-semibold text-foreground">
              In the lots
            </Td>
            <Td align="right" numeric className="font-semibold">
              {formatInr(view.total_value)}
              {view.unpriced ? (
                <span className="ml-1 text-xs font-normal text-warning">
                  +{formatInt(view.unpriced)} unpriced
                </span>
              ) : null}
            </Td>
            <Td colSpan={3} className="text-xs text-faint">
              {view.last_orders
                ? `Last orders made ${formatIstDateTime(view.last_orders.created_at)} (${
                    view.last_orders.trigger === 'scheduled' ? 'the 14:15 job' : 'by hand'
                  }), free cash then ${formatInr(view.last_orders.free_cash)}`
                : 'No lot orders made yet'}
            </Td>
          </TRow>
        </tbody>
      </Table>
      {view.not_in_a_lot.length ? (
        <div className="border-t border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">Kite minus the lots</h3>
          <p className="mt-0.5 text-xs text-muted">
            Shares Kite holds that no lot has booked yet ({formatInr(view.not_in_a_lot_value)}
            {view.not_in_a_lot_unpriced
              ? `, ${formatInt(view.not_in_a_lot_unpriced)} without a close`
              : ''}
            ). The next Friday orders run books them to the lots its last orders named, the rest to
            the lot those orders were for{view.pending ? ` (${view.pending})` : ''} when it may hold
            the name; anything it cannot place stays here until you run{' '}
            <span className="font-mono">mbt lots assign SYMBOL --lot N</span>. A row at 0 is a trade
            the last Friday orders named that Kite does not show yet.
          </p>
          <Table className="mt-2">
            <THead>
              <Th>Name</Th>
              <Th align="right">Kite − lots</Th>
              <Th align="right">Value</Th>
              <Th>The last orders said</Th>
            </THead>
            <tbody>
              {view.not_in_a_lot.map((row) => {
                const gap = plannedGap(row.delta, row.planned);
                return (
                  <TRow key={row.symbol}>
                    <Td className="font-semibold text-foreground">{row.symbol}</Td>
                    <Td align="right" numeric>
                      {row.delta === 0
                        ? '0'
                        : `${row.delta > 0 ? '+' : '−'}${formatInt(Math.abs(row.delta))}`}
                    </Td>
                    <Td align="right" numeric>
                      {formatInr(row.value)}
                    </Td>
                    <Td
                      className={cn(
                        'whitespace-nowrap text-xs',
                        gap ? 'text-warning' : 'text-muted',
                      )}
                    >
                      {plannedText(row.planned)}
                      {gap ? ` · ${gap}` : ''}
                    </Td>
                  </TRow>
                );
              })}
            </tbody>
          </Table>
        </div>
      ) : null}
    </>
  );
}

function LotRow({ lot, ordersWeek }: { lot: MomentumLot; ordersWeek: string | null }) {
  const state = lotState(lot);
  const holds = holdsText(lot);
  const said = lastOrdersText(lot);
  return (
    <TRow className={lot.due ? 'bg-primary/5' : ''}>
      <Td className="whitespace-nowrap font-semibold text-foreground">
        <span title={lot.sleeve}>{lot.label}</span>
      </Td>
      <Td className="whitespace-nowrap">
        <Badge tone={state.tone}>{state.label}</Badge>
        {lot.pending ? (
          <span
            className="ml-1.5 text-xs text-faint"
            title="A change in Kite the last orders did not name is booked to this lot when it may hold the name"
          >
            last orders were for it
          </span>
        ) : null}
      </Td>
      <Td
        className={cn(
          'max-w-80 truncate whitespace-nowrap text-xs',
          !lot.holds.length && 'text-faint',
        )}
      >
        <span title={holds}>{holds}</span>
      </Td>
      <Td align="right" numeric>
        {lot.holds.length ? formatInr(lot.value) : EMPTY}
        {lot.unpriced.length ? (
          <span
            className="ml-1 text-xs text-warning"
            title={`No close for ${lot.unpriced.join(', ')}`}
          >
            +{formatInt(lot.unpriced.length)} unpriced
          </span>
        ) : null}
      </Td>
      <Td className="whitespace-nowrap">{formatDayShort(lot.last, { weekday: true })}</Td>
      <Td className="whitespace-nowrap">{formatDayShort(lot.next, { weekday: true })}</Td>
      <Td className="whitespace-nowrap text-xs text-muted">
        {said ? (
          <>
            {said}
            {ordersWeek ? (
              <span className="text-faint"> ({formatDayShort(ordersWeek, { weekday: true })})</span>
            ) : null}
          </>
        ) : (
          EMPTY
        )}
      </Td>
    </TRow>
  );
}
