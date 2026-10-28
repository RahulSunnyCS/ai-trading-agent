/**
 * Momentum › This week's Lots panel (BL-142 Phase 4): words for the lot ledger the API sends
 * (`GET /api/momentum/lots`). Every figure is the server's; this file only chooses the words and
 * the tone, so the panel says the same as `mbt lots show` and the Friday Telegram.
 */
import type { MomentumLot, MomentumLotOrders, MomentumLotsView } from '../types/momentum';
import { formatDayShort, formatInr, formatInt } from './format';

/** The Friday orders' word for a lot (the Telegram's "NEW lot", "rebalance", …). */
export const LOT_ORDER_STATUS: Record<MomentumLotOrders['status'], string> = {
  new: 'New lot: buy',
  rebalance: 'Rebalance',
  exit: 'Sell only',
  'not due': 'Not due',
};

export type LotTone = 'primary' | 'neutral' | 'warning';

/** Where a lot stands for this page's Friday. */
export function lotState(lot: MomentumLot): { label: string; tone: LotTone } {
  if (lot.due) {
    return {
      label: `Due ${formatDayShort(lot.next, { weekday: true })}`,
      tone: 'primary',
    };
  }
  if (!lot.funded && !lot.pending && !lot.last) return { label: 'Not started', tone: 'neutral' };
  return { label: 'Not due', tone: 'neutral' };
}

/** "CUPID 40 · NAZARA 33", or why there is nothing. */
export function holdsText(lot: MomentumLot): string {
  if (lot.holds.length) {
    return lot.holds.map((h) => `${h.symbol} ${formatInt(h.shares)}`).join(' · ');
  }
  if (lot.pending) return 'nothing booked yet: its buys are booked at the next Friday run';
  return lot.last ? 'holds nothing' : 'nothing yet';
}

/** The last stored orders' line for this lot, as the Friday Telegram put it. */
export function lastOrdersText(lot: MomentumLot): string | null {
  const said = lot.last_orders;
  if (!said) return null;
  const parts = [LOT_ORDER_STATUS[said.status]];
  if ((said.status === 'new' || said.status === 'rebalance') && said.budget != null) {
    parts.push(formatInr(said.budget));
  }
  return parts.join(' · ');
}

/** "Lot 2: buy 35", from what the last orders told each lot to trade in this stock. */
export function plannedText(planned: Array<{ lot: string; shares: number }>): string {
  if (!planned.length) return 'not in the last orders';
  return planned
    .map((p) => `${p.lot}: ${p.shares > 0 ? 'buy' : 'sell'} ${formatInt(Math.abs(p.shares))}`)
    .join(', ');
}

/** How Kite's extra shares compare with what the orders said: null when they match. */
export function plannedGap(
  delta: number,
  planned: Array<{ lot: string; shares: number }>,
): string | null {
  if (!planned.length) return null;
  if (Math.abs(delta) < 1e-6) return 'not traded in Kite yet';
  const gap = delta - planned.reduce((sum, p) => sum + p.shares, 0);
  if (Math.abs(gap) < 1e-6) return null;
  return `${formatInt(Math.abs(gap))} ${gap > 0 ? 'more' : 'fewer'} than the orders said`;
}

/** "the close of Fri 23 Oct", or the range when the names' last closes differ. */
export function closeDaysText(days: [string, string] | null): string {
  if (!days) return 'no stored close';
  const [first, last] = days;
  if (first === last) return `the close of ${formatDayShort(last, { weekday: true })}`;
  return `each name's last close (${formatDayShort(first, { weekday: true })} to ${formatDayShort(last, { weekday: true })})`;
}

/** The value of what Kite holds beyond the lots (priced rows only) and how many rows had no
 * close: an unpriced row is counted, never read as zero. */
export function beyondValue(view: Extract<MomentumLotsView, { available: true }>): {
  value: number;
  unpriced: number;
} {
  let value = 0;
  let unpriced = 0;
  for (const row of view.not_in_a_lot) {
    if (row.value == null) unpriced += 1;
    else value += row.value;
  }
  return { value, unpriced };
}
