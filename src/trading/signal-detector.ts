import { query } from '../db/client';
import { streamRead, streamPublish, STREAMS } from '../redis/client';
import type { Underlying, StraddleSignal, ConfidenceTier } from '../db/schema';

// ── Configuration ──────────────────────────────────────────────────────────────

export interface ExhaustionConfig {
  minExpansionPct:          number;  // default 10
  accelerationThreshold:    number;  // default -0.5 (negative = decelerating)
  rocDeclineWindow:         number;  // consecutive candles of declining ROC, default 2
  windowSize:               number;  // rolling snapshot window to keep, default 8
}

const DEFAULT_CONFIG: ExhaustionConfig = {
  minExpansionPct:       10,
  accelerationThreshold: -0.5,
  rocDeclineWindow:      2,
  windowSize:            8,
};

// ── Internal state ─────────────────────────────────────────────────────────────

interface SnapshotEntry {
  time: Date;
  straddleValue: number;
  roc: number | null;
  acceleration: number | null;
  vix: number | null;
}

interface SnapshotWindow {
  openStraddle: number | null;  // first snapshot of the day
  entries: SnapshotEntry[];
  firedToday: boolean;          // one signal per underlying:expiry per day
}

// keyed by `${underlying}:${expiry.toISOString()}`
const windows = new Map<string, SnapshotWindow>();
let lastStreamId = '0-0';

export function resetSignalState(): void {
  windows.clear();
  lastStreamId = '0-0';
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Consumes new entries from the STRADDLE_VALUES stream and evaluates exhaustion
 * conditions. Inserts to straddle_signals + publishes to SIGNALS_GENERATED
 * when a signal fires.
 */
export async function detectSignals(config: ExhaustionConfig = DEFAULT_CONFIG): Promise<void> {
  const entries = await streamRead(STREAMS.STRADDLE_VALUES, lastStreamId, 50);
  if (entries.length === 0) return;

  for (const { id, fields } of entries) {
    lastStreamId = id;
    await processSnapshotEntry(fields, config);
  }
}

// ── Core logic (exported for unit testing) ────────────────────────────────────

export interface ExhaustionResult {
  triggered: boolean;
  expansionPct: number;
  reason?: string;
}

/**
 * Pure — evaluates whether the current window satisfies exhaustion conditions.
 */
export function checkExhaustionConditions(
  window: SnapshotWindow,
  config: ExhaustionConfig = DEFAULT_CONFIG,
): ExhaustionResult {
  if (window.firedToday) {
    return { triggered: false, expansionPct: 0, reason: 'already_fired_today' };
  }

  const { entries, openStraddle } = window;
  if (entries.length < config.rocDeclineWindow + 1 || openStraddle == null) {
    return { triggered: false, expansionPct: 0, reason: 'insufficient_data' };
  }

  const latest = entries[entries.length - 1];
  if (latest.straddleValue == null) {
    return { triggered: false, expansionPct: 0, reason: 'missing_straddle' };
  }

  const expansionPct = ((latest.straddleValue - openStraddle) / openStraddle) * 100;

  if (expansionPct < config.minExpansionPct) {
    return { triggered: false, expansionPct, reason: 'expansion_below_threshold' };
  }

  if (latest.acceleration == null || latest.acceleration >= config.accelerationThreshold) {
    return { triggered: false, expansionPct, reason: 'acceleration_not_negative_enough' };
  }

  // Check ROC has been declining for the required number of consecutive candles
  const recentEntries = entries.slice(-(config.rocDeclineWindow + 1));
  let rocDeclining = true;
  for (let i = 1; i < recentEntries.length; i++) {
    const prev = recentEntries[i - 1].roc;
    const curr = recentEntries[i].roc;
    if (prev == null || curr == null || curr >= prev) {
      rocDeclining = false;
      break;
    }
  }

  if (!rocDeclining) {
    return { triggered: false, expansionPct, reason: 'roc_not_consistently_declining' };
  }

  return { triggered: true, expansionPct };
}

/**
 * Pure — calculates signal probability from market context.
 */
export function calcSignalProbability(
  expansionPct: number,
  vix: number | null,
  signalTime: Date,
): number {
  let p = 0.55;

  // VIX adjustment
  if (vix != null) {
    if (vix > 20) p -= 0.05;
    else if (vix < 12) p += 0.03;
  }

  // Time-of-day adjustment (IST)
  const istMinutes = (signalTime.getUTCHours() * 60 + signalTime.getUTCMinutes() + 330) % (24 * 60);
  if (istMinutes >= 9 * 60 + 20 && istMinutes <= 9 * 60 + 45) p += 0.06; // 9:20–9:45 IST sweet spot
  else if (istMinutes >= 13 * 60 && istMinutes <= 14 * 60) p += 0.03;     // 13:00–14:00 post-lunch

  // Day-of-week adjustment
  const dayOfWeek = signalTime.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri
  if (dayOfWeek === 1 || dayOfWeek === 5) p -= 0.03; // Monday or Friday

  // Expansion strength bonus
  if (expansionPct >= 20) p += 0.04;

  return Math.min(1.0, Math.max(0.0, p));
}

function confidenceTier(probability: number): ConfidenceTier {
  if (probability >= 0.70) return 'HIGH';
  if (probability >= 0.55) return 'MEDIUM';
  return 'LOW';
}

// ── Private helpers ────────────────────────────────────────────────────────────

async function processSnapshotEntry(
  fields: Record<string, string>,
  config: ExhaustionConfig,
): Promise<void> {
  const underlying     = fields.underlying as Underlying;
  const expiryIso      = fields.expiry;
  const straddleValue  = fields.straddle_value  ? parseFloat(fields.straddle_value) : null;
  const roc            = fields.roc             ? parseFloat(fields.roc)            : null;
  const acceleration   = fields.acceleration    ? parseFloat(fields.acceleration)   : null;
  const vix            = fields.vix             ? parseFloat(fields.vix)            : null;
  const time           = new Date(fields.time ?? Date.now());

  if (!underlying || !expiryIso || straddleValue == null) return;

  const key = `${underlying}:${expiryIso}`;
  if (!windows.has(key)) {
    windows.set(key, { openStraddle: null, entries: [], firedToday: false });
  }
  const win = windows.get(key)!;

  // Set open straddle once per day (first non-null value)
  if (win.openStraddle == null) win.openStraddle = straddleValue;

  // Append to rolling window
  win.entries.push({ time, straddleValue, roc, acceleration, vix });
  if (win.entries.length > config.windowSize) win.entries.shift();

  // Evaluate conditions
  const result = checkExhaustionConditions(win, config);
  if (!result.triggered) return;

  win.firedToday = true;

  const probability = calcSignalProbability(result.expansionPct, vix, time);
  const tier        = confidenceTier(probability);
  const expiry      = new Date(expiryIso);
  const atmStrike   = fields.atm_strike ? parseInt(fields.atm_strike) : 0;

  // Persist signal
  const rows = await query<{ id: string }>(
    `INSERT INTO straddle_signals
       (underlying, expiry, signal_time, signal_type, atm_strike,
        straddle_value, expansion_pct, probability, confidence_tier,
        trigger_layer, status)
     VALUES ($1,$2,$3,'MOMENTUM_EXHAUSTION',$4,$5,$6,$7,$8,'momentum_exhaustion','active')
     RETURNING id`,
    [underlying, expiry, time, atmStrike,
     straddleValue, result.expansionPct, probability, tier],
  );

  const signalId = rows[0]?.id;
  if (!signalId) return;

  // Publish to SIGNALS_GENERATED stream
  await streamPublish(STREAMS.SIGNALS_GENERATED, {
    signal_id:     signalId,
    underlying,
    expiry:        expiryIso,
    signal_time:   time.toISOString(),
    signal_type:   'MOMENTUM_EXHAUSTION',
    atm_strike:    String(atmStrike),
    straddle_value: String(straddleValue),
    expansion_pct: String(result.expansionPct),
    probability:   String(probability),
    confidence_tier: tier,
  });

  console.log(`[signal] ${underlying} exhaustion detected — expansion ${result.expansionPct.toFixed(1)}% prob ${probability.toFixed(2)} (${tier})`);
}
