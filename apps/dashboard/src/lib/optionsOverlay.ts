/** BL-227: Momentum › Options overlay — labels, defaults and the run bar's chips. */

import type {
  OverlayDirection,
  OverlayMarketFilter,
  OverlayMoneyness,
  OverlayRequest,
  OverlayResult,
  OverlaySizing,
} from '../types/optionsOverlay';
import { formatInr, formatPct } from './format';

export const DIRECTION_LABEL: Record<OverlayDirection, string> = {
  calls: 'Calls on the picks',
  puts: 'Puts on falling stocks',
  mirror: 'Mirror pool',
  switch: 'Market switch',
  both: 'Both sides',
};

export const DIRECTION_HELP: Record<OverlayDirection, string> = {
  calls: "Buy a call on every stock the strategy holds that week (BL-226's book).",
  puts: 'Buy a put on the N weakest F&O stocks whose own trend is down: 26-week return below zero and below the 40-week average (BL-228).',
  mirror:
    "Every F&O stock's chart and its inverse ranked together; a stock in the top N buys its call, an inverse buys the stock's put (BL-228 Phase 0b).",
  switch:
    "The strategy's calls while the market is rising, the falling stocks' puts while it is falling.",
  both: "The strategy's calls and the falling stocks' puts every week, the budget split between them.",
};

export const SIZING_LABEL: Record<OverlaySizing, string> = {
  one_lot: 'One lot per stock',
  premium: 'Premium per stock',
  capital_share: 'Share of capital a week',
};

export const MARKET_FILTER_LABEL: Record<OverlayMarketFilter, string> = {
  nifty_200dma: 'NIFTY below its 200-day average',
  nifty_26w: "NIFTY's 26-week return below zero",
  breadth: 'Under 40 % of F&O stocks above their 40-week average',
};

export const MONEYNESS: readonly OverlayMoneyness[] = ['ATM', 'OTM1', 'OTM2', 'OTM3'];

/** BL-226's slippage by moneyness, a share of premium each way. */
export const DEFAULT_SLIPPAGE: Record<OverlayMoneyness, number> = {
  ATM: 0.01,
  OTM1: 0.02,
  OTM2: 0.03,
  OTM3: 0.04,
};

export function needsStrategy(direction: OverlayDirection): boolean {
  return direction === 'calls' || direction === 'switch' || direction === 'both';
}

export function usesPutList(direction: OverlayDirection): boolean {
  return direction !== 'calls';
}

export const DEFAULT_REQUEST: OverlayRequest = {
  favourite_id: null,
  direction: 'calls',
  moneyness: 'ATM',
  sizing: 'one_lot',
  sizing_value: null,
  capital: 1_000_000,
  n: 5,
  min_sessions_left: 10,
  min_oi_lots: 10,
  slippage: null,
  tax: true,
  market_filter: 'nifty_200dma',
  put_share: 0.5,
  start: '2020-01-01',
  end: null,
};

/** Why the request cannot run yet, or null. */
export function requestProblem(request: OverlayRequest): string | null {
  if (needsStrategy(request.direction) && !request.favourite_id)
    return 'Pick a strategy: its holdings are what the calls are bought on.';
  if (request.sizing === 'capital_share' && !(request.sizing_value && request.sizing_value <= 1))
    return 'Set the share of capital spent on premium a week.';
  return null;
}

/** The run bar's chips: what the next run tests, in a few words each. */
export function requestChips(request: OverlayRequest, strategyName: string | null): string[] {
  const chips: string[] = [];
  if (needsStrategy(request.direction)) chips.push(strategyName ?? 'No strategy');
  chips.push(DIRECTION_LABEL[request.direction]);
  if (usesPutList(request.direction)) chips.push(`N ${request.n}`);
  chips.push(request.moneyness);
  chips.push(
    request.sizing === 'one_lot'
      ? 'One lot'
      : request.sizing === 'premium'
        ? request.sizing_value
          ? `${formatInr(request.sizing_value, { compact: true })} a stock`
          : 'Capital ÷ N a stock'
        : `${formatPct(request.sizing_value ?? 0, 0)} of capital a week`,
  );
  chips.push(formatInr(request.capital, { compact: true }));
  if (request.direction === 'switch') chips.push(MARKET_FILTER_LABEL[request.market_filter]);
  if (request.direction === 'both') chips.push(`Puts ${formatPct(request.put_share, 0)}`);
  chips.push(request.tax ? 'After tax' : 'Before tax');
  chips.push(`From ${request.start}`);
  return chips;
}

/** Growth of each book from the first day, as fractions for the line chart. */
export function growthLines(result: OverlayResult): {
  options: number[];
  shares: number[] | null;
  nifty: number[] | null;
} {
  const capital = result.settings.capital;
  const growth = (values: number[] | undefined) =>
    values ? values.map((value) => value / capital - 1) : null;
  return {
    options: growth(result.series.options) ?? [],
    shares: growth(result.series.shares),
    nifty: growth(result.series.nifty),
  };
}

/** Skip and fill counts with plain labels, largest first, zeros left out. */
export const COUNT_LABEL: Record<string, string> = {
  entries: 'Picks considered',
  thin: 'Skipped: open interest under the minimum',
  not_a_stock: 'Skipped: not a stock (gold, an index, cash)',
  banned: 'Skipped: in the F&O ban list',
  no_contract: 'Skipped: no contract or price',
  no_spot: 'Skipped: no cash close that day',
  too_dear: 'Skipped: one lot over twice the budget',
  settle_entry: 'Bought at the settle price (no trade that day)',
  settle_exit: 'Sold at the settle price (no trade that day)',
  restruck: 'Re-struck by a corporate action, followed',
  zero_booked: 'Contract gone on the exit day, booked at zero',
};

export function countRows(counts: Record<string, number>): Array<{ label: string; value: number }> {
  return Object.entries(counts)
    .filter(([key, value]) => key !== 'entries' && value > 0)
    .map(([key, value]) => ({ label: COUNT_LABEL[key] ?? key, value }))
    .sort((a, b) => b.value - a.value);
}

/** Names a hover line shows before "+N more". */
const HOVER_NAMES = 12;

function nameList(names: string[]): string {
  const shown = names.slice(0, HOVER_NAMES).join(', ');
  return names.length > HOVER_NAMES ? `${shown} +${names.length - HOVER_NAMES} more` : shown;
}

/**
 * For each day of the chart, the options bought that day (the week's positions, held to the next
 * point): "Puts (3): A, B, C" and "Calls (2): D, E" on their own lines; '' when nothing was bought.
 */
export function boughtByDay(result: OverlayResult): string[] {
  const byDay = new Map<string, { CE: string[]; PE: string[] }>();
  for (const trade of result.trades) {
    const day = byDay.get(trade.entry) ?? { CE: [], PE: [] };
    const label = trade.lots > 1 ? `${trade.symbol} ×${trade.lots}` : trade.symbol;
    if (!day[trade.right].includes(label)) day[trade.right].push(label);
    byDay.set(trade.entry, day);
  }
  return result.series.days.map((d) => {
    const day = byDay.get(d);
    if (!day) return '';
    const lines: string[] = [];
    if (day.PE.length) lines.push(`Puts (${day.PE.length}): ${nameList([...day.PE].sort())}`);
    if (day.CE.length) lines.push(`Calls (${day.CE.length}): ${nameList([...day.CE].sort())}`);
    return lines.join('\n');
  });
}
