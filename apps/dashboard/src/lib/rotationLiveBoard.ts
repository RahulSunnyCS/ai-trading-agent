/**
 * The Live board card's view logic (BL-203), kept pure so it is tested without a DOM: which figure
 * a toggle shows, what a pick's state reads as, the chart's points and the status line under the
 * header. Every rupee figure comes from the API; nothing here works one out except multiplying a
 * per-lot figure by the lots the API says a pick trades.
 */

import type {
  LiveBoardResponse,
  LiveBook,
  LivePick,
  LivePickState,
} from '../types/rotationLiveBoard';
import { formatIstTime } from './format';

export type LotsView = 'lot' | 'yours';

/** The card polls the snapshot file this often; Angel One is read by the loop every 5 minutes. */
export const POLL_MS = 60_000;
/** …and this often while a refresh runs, so the new figures appear as soon as they land. */
export const POLL_REFRESHING_MS = 3_000;

export const STATE_LABEL: Record<LivePickState, string> = {
  waiting: 'Waiting',
  open: 'Open',
  closed: 'Closed',
  no_data: 'No data',
};

/** The book's total in the chosen view, with or without slippage. */
export function bookNet(book: LiveBook, view: LotsView, slippage: boolean): number {
  const t = view === 'yours' ? book.yours : book.per_lot;
  return slippage ? t.net_slipped : t.net;
}

/** A pick's figure in the chosen view: per lot, or times the lots it trades. */
export function pickNet(pick: LivePick, view: LotsView, slippage: boolean): number {
  const per = slippage ? pick.net_slipped : pick.net;
  return view === 'yours' ? per * (pick.lots ?? 0) : per;
}

/** The lots line beside a book's name in "Your lots": "3 lots · quantiply · angelone ×1". */
export function lotsLine(book: LiveBook): string {
  if (book.accounts.length === 0)
    return 'Not traded: no account in Settings › Automation trades it';
  const n = book.yours.lots;
  return `${n} lot${n === 1 ? '' : 's'} · ${book.accounts.join(', ')}`;
}

/** Session minute (0 = 09:15 IST) -> a UTC timestamp whose clock reads the IST time, so the chart's
 * axis shows exchange time without a timezone option. */
export function minuteToChartTime(day: string, minute: number): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, 9, 15 + minute) / 1000;
}

/** One line per book for the chart, in the chosen view (slippage is not on the curve: the engine's
 * minute-by-minute MTM is at the prices it read). */
export function chartLines(
  day: string,
  books: LiveBook[],
  view: LotsView,
): { id: string; points: { time: number; value: number }[] }[] {
  return books
    .map((b) => ({
      id: b.name,
      points: (view === 'yours' ? b.curve_yours : b.curve).map(([m, v]) => ({
        time: minuteToChartTime(day, m),
        value: v,
      })),
    }))
    .filter((line) => line.points.length > 0);
}

/** What the header's status line says: when the figures are from, and what happens next. */
export function statusLine(res: LiveBoardResponse, nowMs: number = Date.now()): string {
  const snap = res.snapshot;
  const parts: string[] = [];
  if (res.state.refreshing) parts.push('Refreshing from Angel One…');
  if (snap && snap.day === res.today) {
    parts.push(`Prices to ${snap.as_of ?? '—'}, read at ${formatIstTime(snap.refreshed_at)}`);
  } else if (snap) {
    parts.push(`No refresh today yet; showing ${snap.day}`);
  } else {
    parts.push('No refresh yet');
  }
  if (res.loop.running && res.loop.next_at) {
    const next = Date.parse(res.loop.next_at);
    if (!Number.isNaN(next) && next > nowMs)
      parts.push(`next at ${formatIstTime(res.loop.next_at)}`);
  } else if (!res.state.refreshing) {
    parts.push('the 5-minute refresh is not running (it runs 09:18 to 15:31 on trading days)');
  }
  return parts.join(' · ');
}

/** The last error, when it is newer than the last good refresh. */
export function staleError(res: LiveBoardResponse): string | null {
  const { last_error, last_error_at, last_ok_at } = res.state;
  if (!last_error) return null;
  if (last_ok_at && last_error_at && Date.parse(last_ok_at) > Date.parse(last_error_at))
    return null;
  return last_error;
}

/** A leg's exit column: the time and reason, or "open" while held. */
export function legExit(leg: { exit: string | null; reason: string }): string {
  if (leg.exit === null) return 'open';
  const reason = leg.reason === 'EXIT_TIME' ? 'exit time' : leg.reason;
  return `${leg.exit} ${reason}`;
}
