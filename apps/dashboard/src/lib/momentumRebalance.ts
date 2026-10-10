/**
 * Pure logic for the Momentum › Rebalance preview: validating the holdings form, parsing a
 * pasted holdings list, and building the full current → target table from a preview result.
 */

import type { MomentumRebalanceGroup, MomentumRebalanceResult } from '../types/momentum';
import { sleeveLabel } from './momentumWeek';

/** The engine's name for unallocated money (`IDLE` in momentum_backtesting/engine.py). */
export const IDLE_CASH = 'Idle cash';

const TOLERANCE = 0.0001;

/** One editable holdings row: both fields are what the user typed. */
export interface HoldingDraft {
  asset: string;
  percent: string;
}

// ---------------------------------------------------------------------------
// Form validation

export interface HoldingsValidation {
  /** Asset → percent, for the request. Empty when `error` is set. */
  holdings: Record<string, number>;
  allocated: number;
  error: string | null;
}

/** Fully blank rows are ignored; a half-filled, out-of-range or repeated row is an error. */
export function validateHoldings(rows: readonly HoldingDraft[]): HoldingsValidation {
  const holdings: Record<string, number> = {};
  let allocated = 0;
  for (const row of rows) allocated += Number(row.percent) || 0;
  const fail = (error: string): HoldingsValidation => ({ holdings: {}, allocated, error });
  for (const [index, row] of rows.entries()) {
    const name = row.asset.trim();
    const typed = row.percent.trim();
    if (!name && !typed) continue;
    const weight = Number(typed);
    if (!name) return fail(`Holding ${index + 1}: choose an asset.`);
    if (!typed || !Number.isFinite(weight) || weight < 0 || weight > 100) {
      return fail(`Holding ${index + 1} (${name}): enter a percentage from 0 to 100.`);
    }
    if (Object.hasOwn(holdings, name)) return fail(`Duplicate holding: ${name}.`);
    holdings[name] = weight;
  }
  if (allocated > 100 + TOLERANCE) {
    return fail('Holdings total more than 100%. Reduce a weight before previewing.');
  }
  return { holdings, allocated, error: null };
}

/** Why Preview cannot run right now, or null when it can. Shown beside the button. */
export function previewBlocker(input: {
  loading: boolean;
  hasConfig: boolean;
  holdingsError: string | null;
  portfolioValue: string;
  strategyStartDate: string;
}): string | null {
  if (input.loading) return 'Strategy settings are still loading.';
  if (!input.hasConfig) return 'Strategy settings could not be loaded.';
  if (input.holdingsError) return input.holdingsError;
  const capital = Number(input.portfolioValue);
  if (!input.portfolioValue.trim() || !Number.isFinite(capital) || capital <= 0) {
    return 'Enter a positive total portfolio value.';
  }
  if (!input.strategyStartDate) return 'Choose the date you started this strategy.';
  return null;
}

// ---------------------------------------------------------------------------
// Paste holdings

export interface PasteResult {
  /** Parsed holdings in first-seen order, duplicates already summed. */
  holdings: Array<{ asset: string; percent: number }>;
  /** Lines that could not be read (1-based line numbers of the pasted text). */
  errors: Array<{ line: number; text: string; reason: string }>;
  /** Assets that appeared on more than one line and were added together. */
  merged: string[];
  total: number;
  /** The parsed holdings add up to more than 100%. */
  overAllocated: boolean;
}

const HEADER = /^(symbol|asset|name|stock|ticker|company|scrip|instrument)\b/i;
const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

function round(value: number, dp: number): number {
  const scale = 10 ** dp;
  return Math.round(value * scale) / scale;
}

/**
 * Split one line into an asset and a percent. A spreadsheet row (tabs, commas or semicolons)
 * uses its first cell as the asset and its last as the percent, so a middle "company name"
 * column is ignored. Free text ("RELIANCE 12.5%", "Gold: 10") takes the trailing number.
 */
function splitLine(line: string): { asset: string; value: string } | null {
  const cells = line
    .split(/[\t,;|]/)
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '');
  if (cells.length >= 2) {
    return { asset: cells[0] ?? '', value: cells[cells.length - 1] ?? '' };
  }
  const match = /^(.*\S)[\s:=]+(\S+)$/.exec(line);
  return match
    ? { asset: (match[1] ?? '').replace(/[:=]$/, '').trim(), value: match[2] ?? '' }
    : null;
}

/**
 * Parse pasted holdings, one per line: `RELIANCE 12.5`, `RELIANCE,12.5`, `RELIANCE\t12.5%`.
 *
 * - A leading header row ("Symbol  Weight") is skipped.
 * - The same asset on several lines is SUMMED (a broker export lists one line per lot or
 *   account) and named in `merged`.
 * - A total over 100% is flagged in `overAllocated`, not rejected: the rows still load so the
 *   weights can be corrected in the form.
 * - `knownAssets` fixes case only: "reliance" becomes "RELIANCE" when that is a known asset.
 */
export function parseHoldingsPaste(text: string, knownAssets: readonly string[] = []): PasteResult {
  const canonical = new Map(knownAssets.map((name) => [name.toLowerCase(), name]));
  const totals = new Map<string, number>();
  const merged = new Set<string>();
  const errors: PasteResult['errors'] = [];
  let seenContent = false;

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim().replace(/\s+%/g, '%');
    if (!line) continue;
    const first = !seenContent;
    seenContent = true;
    const fail = (reason: string) => errors.push({ line: index + 1, text: line, reason });
    const parts = splitLine(line);
    const value = parts?.value.replace(/%$/, '').trim() ?? '';
    if (!parts || !NUMBER.test(value)) {
      if (first && HEADER.test(line)) continue;
      fail(parts ? `"${parts.value}" is not a percentage` : 'needs an asset and a percentage');
      continue;
    }
    const percent = Number(value);
    if (!parts.asset) {
      fail('no asset name');
      continue;
    }
    if (percent < 0 || percent > 100) {
      fail('percentage must be from 0 to 100');
      continue;
    }
    const asset = canonical.get(parts.asset.toLowerCase()) ?? parts.asset;
    if (totals.has(asset)) merged.add(asset);
    totals.set(asset, (totals.get(asset) ?? 0) + percent);
  }

  const holdings = [...totals].map(([asset, percent]) => ({ asset, percent: round(percent, 4) }));
  const total = round(
    holdings.reduce((sum, item) => sum + item.percent, 0),
    4,
  );
  return {
    holdings,
    errors,
    merged: [...merged],
    total,
    overAllocated: total > 100 + TOLERANCE,
  };
}

/** Holdings rows for the form from parsed or model weights (percent as a typed string). */
export function toDrafts(
  holdings: ReadonlyArray<{ asset: string; percent: number }>,
): HoldingDraft[] {
  return holdings.map((item) => ({ asset: item.asset, percent: String(round(item.percent, 2)) }));
}

/** The previewed model target as holdings (cash is the form's remainder, so it is left out). */
export function targetAsHoldings(
  plan: Pick<MomentumRebalanceResult, 'target_pct'>,
): HoldingDraft[] {
  return toDrafts(
    Object.entries(plan.target_pct)
      .filter(([asset, percent]) => asset !== IDLE_CASH && percent >= 0.005)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([asset, percent]) => ({ asset, percent })),
  );
}

// ---------------------------------------------------------------------------
// Current → target table

export type RebalanceAction = 'BUY' | 'SELL' | 'HOLD';

export interface RebalanceTableRow {
  asset: string;
  symbol: string | null;
  currentPct: number;
  targetPct: number;
  deltaPct: number;
  action: RebalanceAction;
  /** Null for HOLD rows: the preview only prices the assets it trades. */
  price: number | null;
  /** Rupee size of the trade; null for HOLD. */
  value: number | null;
  quantity: number | null;
}

export interface RebalanceTable {
  /** Sells, then buys, then holds; the largest change first within each. */
  rows: RebalanceTableRow[];
  /** Unallocated cash, kept out of `rows` so it can sit above the totals. */
  cash: RebalanceTableRow | null;
  totals: {
    currentPct: number;
    targetPct: number;
    buyValue: number;
    sellValue: number;
    buys: number;
    sells: number;
    holds: number;
  };
}

/** The server omits a row when the change is under 0.01 pp; those are the HOLD rows. */
const HOLD_BELOW_PP = 0.01;
const ACTION_ORDER: Record<RebalanceAction, number> = { SELL: 0, BUY: 1, HOLD: 2 };

/**
 * Merge `current_pct`, `target_pct` and the BUY / SELL rows into one row per asset. An asset
 * with no trade row is a HOLD. Cash is separated; totals cover every row including cash.
 */
export function buildRebalanceTable(
  plan: Pick<MomentumRebalanceResult, 'current_pct' | 'target_pct' | 'rows'>,
): RebalanceTable {
  const trades = new Map(plan.rows.map((row) => [row.asset, row]));
  const names = new Set([
    ...Object.keys(plan.current_pct),
    ...Object.keys(plan.target_pct),
    ...trades.keys(),
  ]);
  const all: RebalanceTableRow[] = [];
  for (const asset of names) {
    const trade = trades.get(asset);
    const currentPct = trade?.current_pct ?? plan.current_pct[asset] ?? 0;
    const targetPct = trade?.target_pct ?? plan.target_pct[asset] ?? 0;
    const deltaPct = trade?.delta_pct ?? round(targetPct - currentPct, 4);
    const action: RebalanceAction =
      trade?.action ??
      (Math.abs(deltaPct) < HOLD_BELOW_PP ? 'HOLD' : deltaPct > 0 ? 'BUY' : 'SELL');
    if (action === 'HOLD' && currentPct < TOLERANCE && targetPct < TOLERANCE) continue;
    all.push({
      asset,
      symbol: trade?.symbol ?? null,
      currentPct,
      targetPct,
      deltaPct,
      action,
      price: trade?.ltp ?? null,
      value: action === 'HOLD' ? null : (trade?.indicative_value ?? null),
      quantity: trade?.indicative_quantity ?? null,
    });
  }
  const cash = all.find((row) => row.asset === IDLE_CASH) ?? null;
  const rows = all
    .filter((row) => row.asset !== IDLE_CASH)
    .sort(
      (a, b) =>
        ACTION_ORDER[a.action] - ACTION_ORDER[b.action] ||
        Math.abs(b.deltaPct) - Math.abs(a.deltaPct) ||
        b.targetPct - a.targetPct ||
        a.asset.localeCompare(b.asset),
    );
  const sum = (pick: (row: RebalanceTableRow) => number) =>
    round(
      all.reduce((total, row) => total + pick(row), 0),
      4,
    );
  const count = (action: RebalanceAction) => rows.filter((row) => row.action === action).length;
  const value = (action: RebalanceAction) =>
    round(
      rows.reduce((total, row) => total + (row.action === action ? (row.value ?? 0) : 0), 0),
      2,
    );
  return {
    rows,
    cash,
    totals: {
      currentPct: sum((row) => row.currentPct),
      targetPct: sum((row) => row.targetPct),
      buyValue: value('BUY'),
      sellValue: value('SELL'),
      buys: count('BUY'),
      sells: count('SELL'),
      holds: count('HOLD'),
    },
  };
}

// ---------------------------------------------------------------------------
// A favourite group previewed as one account (BL-087)

export interface GroupSleeveLine {
  id: string;
  label: string;
  /** Share of the whole group, a fraction. */
  share: number;
  trades: boolean;
  next: string | null;
}

export interface GroupPreviewSummary {
  lines: GroupSleeveLine[];
  /** Labels of the sleeves that rebalance this week. */
  trading: string[];
  /** One sentence saying who trades and what the target is. */
  sentence: string;
}

/** What a previewed group says about its sleeves: who trades this week, each one's share. */
export function summariseGroup(
  group: MomentumRebalanceGroup,
  firstAllocation = false,
): GroupPreviewSummary {
  const lines = group.sleeves.map((sleeve) => ({
    id: sleeve.id,
    label: sleeveLabel(sleeve.name, group.name),
    share: sleeve.share,
    trades: sleeve.on_cadence,
    next: sleeve.next,
  }));
  const trading = lines.filter((line) => line.trades).map((line) => line.label);
  const sentence = firstAllocation
    ? 'First allocation: every sleeve invests now, each with an equal share. From then on one sleeve trades each week.'
    : trading.length === 0
      ? 'No sleeve rebalances this week. The target below is the whole group as it stands.'
      : `${trading.join(' and ')} ${trading.length === 1 ? 'trades' : 'trade'} this week; the other sleeves hold. The target is the whole group: every sleeve, weighted by its value since the April reset.`;
  return { lines, trading, sentence };
}
