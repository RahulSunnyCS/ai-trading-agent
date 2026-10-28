/**
 * The Trade book's reads (BL-168), one hook per `/api/backtest/legwise/contract-notes/*` route, all
 * on usePolledResource (cached per URL, so switching views and back is instant). Nothing polls:
 * the store changes at night, at 15:50 and when inputs are saved, and the page refetches after a
 * save.
 */

import { TRADE_BOOK_API, readQuery } from '../lib/tradeBookView';
import type {
  TradeBookDayDetail,
  TradeBookDaysResponse,
  TradeBookMomentumResponse,
  TradeBookMoneyResponse,
  TradeBookMonthsResponse,
  TradeBookSummary,
  TradeBookTripsResponse,
} from '../types/tradeBook';
import { usePolledResource } from './usePolledResource';

export interface TradeBookRange {
  from: string | null;
  to: string | null;
}

export function useTradeBookSummary(range: TradeBookRange, account: string | null, enabled = true) {
  return usePolledResource<TradeBookSummary>(
    `${TRADE_BOOK_API}/summary${readQuery({ from: range.from, to: range.to, account })}`,
    { cache: true, enabled },
  );
}

export function useTradeBookDays(range: TradeBookRange, account: string | null, enabled = true) {
  return usePolledResource<TradeBookDaysResponse>(
    `${TRADE_BOOK_API}/days${readQuery({ from: range.from, to: range.to, account })}`,
    { cache: true, enabled },
  );
}

export function useTradeBookMonths(range: TradeBookRange, account: string | null, enabled = true) {
  return usePolledResource<TradeBookMonthsResponse>(
    `${TRADE_BOOK_API}/months${readQuery({ from: range.from, to: range.to, account })}`,
    { cache: true, enabled },
  );
}

export function useTradeBookTrips(
  range: TradeBookRange,
  account: string | null,
  options: { extremes?: boolean; enabled?: boolean } = {},
) {
  const { extremes = false, enabled = true } = options;
  return usePolledResource<TradeBookTripsResponse>(
    `${TRADE_BOOK_API}/trips${readQuery({
      from: range.from,
      to: range.to,
      account,
      extremes: extremes ? '1' : null,
    })}`,
    { cache: true, enabled },
  );
}

export function useTradeBookMoney(range: TradeBookRange, enabled = true) {
  return usePolledResource<TradeBookMoneyResponse>(
    `${TRADE_BOOK_API}/money${readQuery({ from: range.from, to: range.to })}`,
    { cache: true, enabled },
  );
}

export function useTradeBookMomentum(range: TradeBookRange, enabled = true) {
  return usePolledResource<TradeBookMomentumResponse>(
    `${TRADE_BOOK_API}/momentum${readQuery({ from: range.from, to: range.to })}`,
    { cache: true, enabled },
  );
}

export function useTradeBookDay(day: string | null) {
  return usePolledResource<TradeBookDayDetail>(`${TRADE_BOOK_API}/day/${day ?? 'none'}`, {
    cache: true,
    enabled: day !== null,
  });
}
