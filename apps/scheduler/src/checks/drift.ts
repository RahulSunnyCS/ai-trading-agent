import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Underlying, lotSize } from '@trading/market-reference';
import type { Job } from '../jobs.js';
import type { Builtin } from '../runner.js';
import { tradingDays } from '../schedule.js';
import { type CheckResult, checkBuiltin, checkJob } from './types.js';

// BL-012 inventory S1 and S2: reference data that goes stale when an exchange revises it.
// Both checks only look; they never edit a CSV or the catalog.

export const FYERS_NSE_FO_URL = 'https://public.fyers.in/sym_details/NSE_FO.csv';
export const NIFTY50_LIVE_URL = 'https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv';
export const MEMBERSHIP_CSV =
  'packages/momentum-backtesting/src/momentum_backtesting/stocks/curated/nifty50_membership.csv';

/** Underlyings in the NSE F&O symbol master that `lot_sizes.csv` tracks (SENSEX is BSE). */
const NSE_UNDERLYINGS: Underlying[] = ['NIFTY', 'BANKNIFTY'];

/** Fyers symbol-master columns (0-based): minimum lot size and underlying symbol. */
const COL_LOT = 3;
const COL_UNDERLYING = 13;

export type Fetcher = (url: string) => Promise<string>;

export const httpFetch: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '');
}

/** Lot sizes per underlying as the Fyers master lists them (a set, so a mixed listing shows). */
export function masterLotSizes(csv: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const line of lines(csv)) {
    const cells = line.split(',');
    const underlying = cells[COL_UNDERLYING]?.trim();
    const lot = Number(cells[COL_LOT]);
    if (!underlying || !Number.isInteger(lot) || lot <= 0) continue;
    const set = out.get(underlying) ?? new Set<number>();
    set.add(lot);
    out.set(underlying, set);
  }
  return out;
}

export async function checkLotSizes(fetcher: Fetcher, asOf: Date): Promise<CheckResult> {
  let csv: string;
  try {
    csv = await fetcher(FYERS_NSE_FO_URL);
  } catch (error) {
    return { ok: false, detail: `could not reach the Fyers symbol master: ${String(error)}` };
  }
  const master = masterLotSizes(csv);
  const mismatches: string[] = [];
  const checked: string[] = [];
  for (const underlying of NSE_UNDERLYINGS) {
    const lots = master.get(underlying);
    if (!lots) {
      return {
        ok: false,
        detail: `the Fyers symbol master has no ${underlying} rows (format changed?)`,
      };
    }
    const mine = lotSize(underlying, asOf);
    checked.push(`${underlying} ${mine}`);
    if (lots.size !== 1 || !lots.has(mine)) {
      mismatches.push(`${underlying}: lot_sizes.csv ${mine}, Fyers ${[...lots].join('/')}`);
    }
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      detail: `lot size differs from the Fyers symbol master — ${mismatches.join('; ')}`,
    };
  }
  return { ok: true, detail: `lot sizes match the Fyers symbol master (${checked.join(', ')})` };
}

/** Symbols of the live niftyindices list (CSV with a `Symbol` column). */
export function liveSymbols(csv: string): string[] {
  const [header, ...rows] = lines(csv);
  const cols = (header ?? '').split(',').map((c) => c.trim());
  const i = cols.indexOf('Symbol');
  if (i < 0) throw new Error('no Symbol column in the niftyindices list');
  return rows.map((r) => (r.split(',')[i] ?? '').trim()).filter(Boolean);
}

/** Symbols of rows with an empty `to` in nifty50_membership.csv (first four cells are unquoted). */
export function openMembers(csv: string): string[] {
  const [, ...rows] = lines(csv);
  const out: string[] = [];
  for (const row of rows) {
    const [, symbol, , to] = row.split(',');
    if (symbol && (to ?? '').trim() === '') out.push(symbol.trim());
  }
  return out;
}

export async function checkNifty50(
  fetcher: Fetcher,
  readMembership: () => string,
): Promise<CheckResult> {
  let live: string[];
  try {
    live = liveSymbols(await fetcher(NIFTY50_LIVE_URL));
  } catch (error) {
    return { ok: false, detail: `could not reach niftyindices.com: ${String(error)}` };
  }
  if (live.length < 40) {
    return {
      ok: false,
      detail: `the niftyindices list has only ${live.length} symbols (format changed?)`,
    };
  }
  const file = new Set(openMembers(readMembership()));
  const liveSet = new Set(live);
  const added = live.filter((s) => !file.has(s)).sort();
  const removed = [...file].filter((s) => !liveSet.has(s)).sort();
  if (added.length === 0 && removed.length === 0) {
    return {
      ok: true,
      detail: `Nifty 50 list matches the membership file (${live.length} symbols)`,
    };
  }
  const parts: string[] = [];
  if (added.length) parts.push(`in the live index but not the file: ${added.join(', ')}`);
  if (removed.length) parts.push(`in the file but not the live index: ${removed.join(', ')}`);
  return { ok: false, detail: `Nifty 50 membership changed — ${parts.join('; ')}` };
}

export const jobs: Job[] = [
  checkJob({
    id: 'check-lot-sizes',
    description: 'Compare lot_sizes.csv with the Fyers NSE F&O symbol master',
    schedule: { at: '17:00', on: tradingDays, label: 'trading days 17:00' },
    builtin: 'check-lot-sizes',
    retries: 2,
    retryDelayMinutes: 30,
    fixHint:
      "cd packages/trading-data && uv run tdata reference sql \"INSERT INTO ref_lot_sizes VALUES ('NIFTY', <new lot>, DATE '<effective date>')\"  (one row per changed underlying)",
  }),
  checkJob({
    id: 'check-nifty50-membership',
    description: 'Compare the live Nifty 50 list with nifty50_membership.csv',
    schedule: { at: '08:30', on: tradingDays, label: 'trading days 08:30' },
    builtin: 'check-nifty50-membership',
    retries: 2,
    retryDelayMinutes: 30,
    needs: ['home'],
    fixHint: `Edit ${MEMBERSHIP_CSV} (and the curated companies/aliases), then: cd packages/momentum-backtesting && uv run mbt stocks fetch && uv run mbt stocks pin-manifest`,
  }),
];

export const builtins: Record<string, Builtin> = {
  'check-lot-sizes': checkBuiltin((ctx) => checkLotSizes(httpFetch, ctx.now())),
  'check-nifty50-membership': checkBuiltin((ctx) =>
    checkNifty50(httpFetch, () => readFileSync(join(ctx.repoRoot, MEMBERSHIP_CSV), 'utf8')),
  ),
};
