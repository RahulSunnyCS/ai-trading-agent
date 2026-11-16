/** BL-227: Momentum › Options overlay — labels, defaults and the run bar's chips. */

import type {
  OverlayCustom,
  OverlayDirection,
  OverlayJob,
  OverlayMarketFilter,
  OverlayMoneyness,
  OverlayRequest,
  OverlayResult,
  OverlaySizing,
  OverlayTrade,
} from '../types/optionsOverlay';
import { formatInr, formatNumber, formatPct } from './format';

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

export const CUSTOM_LOOKBACKS: readonly number[] = [1, 4, 13, 26, 52];

export const DEFAULT_CUSTOM: OverlayCustom = {
  lookbacks: [1, 4, 13, 26, 52],
  top_n: 10,
  exit_rank: 20,
  rebalance: 'weekly',
  score: 'ranksum',
};

/** "Custom · top 10 · 52w · weekly", as the server names it. */
export function customName(custom: OverlayCustom): string {
  const longest = custom.lookbacks.length ? `${Math.max(...custom.lookbacks)}w` : '?';
  return `Custom · top ${custom.top_n} · ${longest} · ${custom.rebalance}`;
}

export const DEFAULT_REQUEST: OverlayRequest = {
  favourite_id: null,
  custom: null,
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
  profit_step: null,
  withdraw_share: 0.75,
  refill: true,
};

/** Why the request cannot run yet, or null. */
export function requestProblem(request: OverlayRequest): string | null {
  if (needsStrategy(request.direction) && !request.favourite_id && !request.custom)
    return 'Pick a strategy: its holdings are what the calls are bought on.';
  if (needsStrategy(request.direction) && request.custom) {
    if (!request.custom.lookbacks.length) return 'Pick at least one look-back.';
    if (request.custom.exit_rank < request.custom.top_n)
      return 'The exit rank must be at least the number held.';
  }
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
  if (request.profit_step)
    chips.push(
      `Take out ${formatPct(request.withdraw_share, 0)} of each ${formatInr(request.profit_step, { compact: true })}${request.refill ? ', refill' : ''}`,
    );
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
  no_capital: 'Skipped: the trading account could not pay for it',
};

export function countRows(counts: Record<string, number>): Array<{ label: string; value: number }> {
  return Object.entries(counts)
    .filter(([key, value]) => key !== 'entries' && value > 0)
    .map(([key, value]) => ({ label: COUNT_LABEL[key] ?? key, value }))
    .sort((a, b) => b.value - a.value);
}

/** "Buy LAURUSLABS 2,000 CE ×2 at 34.50" (×N = N lots). */
export function buyText(trade: OverlayTrade): string {
  const lots = trade.lots > 1 ? ` ×${trade.lots}` : '';
  return `Buy ${trade.symbol} ${formatNumber(trade.strike, 2, { trim: true })} ${trade.right}${lots} at ${formatNumber(trade.p0, 2)}`;
}

/** "Sell at 52.00" (or how a re-struck or vanished contract was closed). */
export function sellText(trade: OverlayTrade): string {
  if (trade.exit_how === 'zero') return 'Contract gone: booked at 0';
  const restruck = trade.exit_how === 'restruck' ? ' (re-struck contract)' : '';
  return `Sell at ${formatNumber(trade.p1, 2)}${restruck}`;
}

/** The whole trade in one line: "Buy LAURUSLABS 2,000 CE at 34.50 → Sell at 52.00". */
export function tradeText(trade: OverlayTrade): string {
  return `${buyText(trade)} → ${sellText(trade)}`;
}

/** Lines a hover block shows before "+N more". */
const HOVER_LINES = 10;

function capped(lines: string[]): string[] {
  return lines.length > HOVER_LINES
    ? [...lines.slice(0, HOVER_LINES), `+${lines.length - HOVER_LINES} more (All trades)`]
    : lines;
}

/**
 * For each day of the chart, what the book did that day: the positions it sold (bought the week
 * before, with their P&L) and the ones it bought, puts first, one per line; '' on a day with
 * neither.
 */
export function tradesByDay(result: OverlayResult): string[] {
  const buys = new Map<string, OverlayTrade[]>();
  const sells = new Map<string, OverlayTrade[]>();
  for (const trade of result.trades) {
    buys.set(trade.entry, [...(buys.get(trade.entry) ?? []), trade]);
    sells.set(trade.exit, [...(sells.get(trade.exit) ?? []), trade]);
  }
  const order = (a: OverlayTrade, b: OverlayTrade) =>
    a.right === b.right ? a.symbol.localeCompare(b.symbol) : a.right === 'PE' ? -1 : 1;
  return result.series.days.map((d) => {
    const lines: string[] = [];
    const sold = [...(sells.get(d) ?? [])].sort(order);
    if (sold.length) {
      const net = sold.reduce((sum, t) => sum + t.pnl, 0);
      lines.push(`Sold ${sold.length} (${formatInr(net, { sign: true, compact: true })}):`);
      lines.push(
        ...capped(
          sold.map(
            (t) =>
              `· ${t.symbol} ${formatNumber(t.strike, 2, { trim: true })} ${t.right}: ${sellText(t)} (${formatInr(t.pnl, { sign: true, compact: true })})`,
          ),
        ),
      );
    }
    const bought = [...(buys.get(d) ?? [])].sort(order);
    if (bought.length) {
      lines.push(`Bought ${bought.length}:`);
      lines.push(...capped(bought.map((t) => `· ${buyText(t)}`)));
    }
    return lines.join('\n');
  });
}

/**
 * Whether the page is still waiting on a run. A failed poll ends the wait whatever the last good
 * answer was: `usePolledResource` keeps that answer on screen, so a job last seen "running" would
 * otherwise wait for ever once the service restarted and forgot it (a 404 on every poll).
 */
export function jobRunning(state: {
  starting: boolean;
  jobId: string | null;
  job: OverlayJob | null;
  pollError: string | null;
}): boolean {
  if (state.starting) return true;
  if (state.jobId === null || state.pollError !== null) return false;
  return state.job === null || state.job.status === 'running';
}

/** The slippage field's text for a stored fraction: 0.07 → "7" (not 7.000000000000001). */
export function slippageText(value: number | null): string {
  return value === null ? '' : formatNumber(value * 100, 4, { trim: true });
}

/** What the slippage field's text means: a fraction, or null (blank, not a number, or out of range). */
export function parseSlippage(text: string): number | null {
  if (text.trim() === '') return null;
  const percent = Number(text);
  return percent >= 0 && percent < 50 ? percent / 100 : null;
}
