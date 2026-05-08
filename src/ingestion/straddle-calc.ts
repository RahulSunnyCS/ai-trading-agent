import { query } from '../db/client';
import { streamPublish, streamRead, STREAMS } from '../redis/client';
import type { Underlying, OptionType } from '../db/schema';

// ── ATM Strike calculation ─────────────────────────────────────────────────────

// NSE strike intervals per underlying
const STRIKE_INTERVALS: Record<Underlying, number> = {
  NIFTY:     50,
  BANKNIFTY: 100,
  SENSEX:    100,
};

export function getAtmStrike(spot: number, underlying: Underlying): number {
  const interval = STRIKE_INTERVALS[underlying];
  return Math.round(spot / interval) * interval;
}

// ── Live price cache (populated by tick stream) ────────────────────────────────

interface LivePrice {
  ltp: number;
  time: Date;
}

// symbol → latest price
const priceCache = new Map<string, LivePrice>();

export function updatePrice(symbol: string, ltp: number, time: Date): void {
  priceCache.set(symbol, { ltp, time });
}

export function getPrice(symbol: string): LivePrice | undefined {
  return priceCache.get(symbol);
}

// ── Symbol name builder ────────────────────────────────────────────────────────
// NSE option symbol format: NIFTY25JUN23000CE
// This is illustrative — adapt to your broker's exact format.

export function buildOptionSymbol(
  underlying: Underlying,
  expiry: Date,
  strike: number,
  optionType: OptionType
): string {
  const month = expiry.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  const year  = String(expiry.getFullYear()).slice(2);
  return `${underlying}${year}${month}${strike}${optionType}`;
}

// ── Straddle calculator ────────────────────────────────────────────────────────

interface StraddleState {
  openValue: number | null;
  prevRoc:   number | null;
  prevValue: number | null;
}

const straddleState: Record<string, StraddleState> = {};

function getStateKey(underlying: Underlying, expiry: Date): string {
  return `${underlying}:${expiry.toISOString().slice(0, 10)}`;
}

function initState(underlying: Underlying, expiry: Date): StraddleState {
  const key = getStateKey(underlying, expiry);
  if (!straddleState[key]) {
    straddleState[key] = { openValue: null, prevRoc: null, prevValue: null };
  }
  return straddleState[key];
}

export function resetDayState(): void {
  for (const key of Object.keys(straddleState)) {
    delete straddleState[key];
  }
  console.log('[straddle-calc] Day state reset');
}

// ── Main snapshot computation ──────────────────────────────────────────────────
// Called every 15 seconds by the scheduler.

export async function computeAndSaveSnapshot(
  underlying: Underlying,
  expiry: Date,
  spot: number,
  vix: number | null
): Promise<void> {
  const atmStrike = getAtmStrike(spot, underlying);
  const ceSymbol  = buildOptionSymbol(underlying, expiry, atmStrike, 'CE');
  const peSymbol  = buildOptionSymbol(underlying, expiry, atmStrike, 'PE');

  const cePrice = getPrice(ceSymbol);
  const pePrice = getPrice(peSymbol);

  if (!cePrice || !pePrice) {
    // Prices not yet received for these symbols — skip this tick
    return;
  }

  const ceLtp = cePrice.ltp;
  const peLtp = pePrice.ltp;
  const straddleValue = ceLtp + peLtp;

  const state = initState(underlying, expiry);

  // Set open value at market open (first snapshot of the day)
  if (state.openValue === null) {
    state.openValue = straddleValue;
  }

  const straddleChangePct = ((straddleValue - state.openValue) / state.openValue) * 100;

  // Rate of change: % change since last snapshot
  let roc: number | null = null;
  if (state.prevValue !== null && state.prevValue > 0) {
    roc = (straddleValue - state.prevValue) / state.prevValue;
  }

  // Acceleration: change in ROC (second derivative)
  let acceleration: number | null = null;
  if (roc !== null && state.prevRoc !== null) {
    acceleration = roc - state.prevRoc;
  }

  const now = new Date();

  // Persist snapshot
  await query(
    `INSERT INTO straddle_snapshots
       (time, underlying, expiry, atm_strike, ce_ltp, pe_ltp,
        straddle_value, straddle_change_pct, roc, acceleration, vix)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      now, underlying, expiry, atmStrike,
      ceLtp, peLtp, straddleValue,
      straddleChangePct,
      roc, acceleration, vix,
    ]
  );

  // Publish to Redis Stream for signal engine to consume
  await streamPublish(STREAMS.STRADDLE_VALUES, {
    underlying:            underlying,
    expiry:                expiry.toISOString().slice(0, 10),
    atm_strike:            String(atmStrike),
    ce_ltp:                String(ceLtp),
    pe_ltp:                String(peLtp),
    straddle_value:        String(straddleValue),
    straddle_change_pct:   String(straddleChangePct.toFixed(4)),
    roc:                   roc !== null ? String(roc.toFixed(6)) : '',
    acceleration:          acceleration !== null ? String(acceleration.toFixed(6)) : '',
    vix:                   vix !== null ? String(vix) : '',
    time:                  now.toISOString(),
  });

  // Update state for next tick
  state.prevRoc   = roc;
  state.prevValue = straddleValue;
}

// ── Tick stream consumer ───────────────────────────────────────────────────────
// Reads from market.ticks stream and updates the price cache.

let lastTickStreamId = '$'; // start from now on first run

export async function consumeTickStream(): Promise<void> {
  const entries = await streamRead(STREAMS.MARKET_TICKS, lastTickStreamId, 500);
  for (const entry of entries) {
    const { fields } = entry;
    const ltp = parseFloat(fields.ltp);
    if (fields.symbol && !isNaN(ltp)) {
      updatePrice(fields.symbol, ltp, new Date(fields.time));
    }
    lastTickStreamId = entry.id;
  }
}
