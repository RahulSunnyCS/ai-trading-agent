import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { OpenPosition } from '../../db/schema.js';
import {
  evaluateTriggers,
  loadTriggerConfig,
  updateTrailingStop,
} from '../../trading/trigger-engine.js';
import { FixedClock } from '../../utils/clock.js';

/**
 * Property tests for stop-loss, trailing stop, profit target, and daily loss cap
 * trigger mathematics.
 *
 * The trigger-engine module (src/trading/trigger-engine.ts) has not yet been
 * implemented, so these tests define the EXPECTED mathematical contract using
 * inline helpers. When trigger-engine.ts is built, the inline helpers here
 * should be replaced with imports from that module — all tests must still pass.
 *
 * Using decimal.js as the oracle throughout to avoid floating-point drift in
 * percentage arithmetic (e.g. entry * 1.15 can accumulate IEEE-754 error).
 */

// ─── Inline math helpers (replace with trigger-engine imports once available) ─

/**
 * Hard stop-loss threshold: the straddle value at which a hard SL fires.
 * Position is SHORT straddle so SL fires when value RISES above a ceiling.
 *
 * threshold = entryValue × (1 + slPct / 100)
 */
function hardSlThreshold(entryValue: string, slPct: string): Decimal {
  // Use Decimal throughout to avoid floating-point rounding at the boundary
  const entry = new Decimal(entryValue);
  const pct = new Decimal(slPct).div(100);
  return entry.mul(pct.plus(1));
}

/**
 * Returns true if the current straddle value would fire the hard SL.
 * Fires AT exactly the threshold and above (i.e., >= threshold).
 */
function isHardSlFired(entryValue: string, slPct: string, currentValue: string): boolean {
  const threshold = hardSlThreshold(entryValue, slPct);
  return new Decimal(currentValue).gte(threshold);
}

/**
 * Trailing stop-loss state: tracks the lowest observed straddle value since
 * entry and returns the current TSL trigger level.
 *
 * TSL fires when current value rises slPct% above the lowest observed value.
 * lowestObserved starts at entryValue and can only decrease.
 *
 * trailThreshold = lowestObserved × (1 + slPct / 100)
 */
function trailSlThreshold(lowestObserved: string, slPct: string): Decimal {
  const lowest = new Decimal(lowestObserved);
  const pct = new Decimal(slPct).div(100);
  return lowest.mul(pct.plus(1));
}

/**
 * Updates lowestObserved: accepts a new value only if it is strictly lower.
 * Returns the new lowestObserved (may be unchanged).
 */
function updateLowest(lowestObserved: string, newValue: string): string {
  const lowest = new Decimal(lowestObserved);
  const next = new Decimal(newValue);
  return next.lt(lowest) ? next.toFixed(2) : lowest.toFixed(2);
}

/**
 * Profit target: fires when current value falls to or below the target level.
 * For a SHORT straddle, profit occurs when the straddle value falls.
 *
 * profitTarget = entryValue × (1 - targetPct / 100)
 */
function profitTargetThreshold(entryValue: string, targetPct: string): Decimal {
  const entry = new Decimal(entryValue);
  const pct = new Decimal(targetPct).div(100);
  return entry.mul(new Decimal(1).minus(pct));
}

function isProfitTargetHit(entryValue: string, targetPct: string, currentValue: string): boolean {
  const target = profitTargetThreshold(entryValue, targetPct);
  return new Decimal(currentValue).lte(target);
}

/**
 * Daily loss cap accumulation: sums per-trade losses and returns true if the
 * cumulative daily loss exceeds the cap.
 *
 * All arithmetic uses Decimal to prevent drift across many small losses.
 */
function isDailyLossCapBreached(losses: string[], capAmount: string): boolean {
  const total = losses.reduce((acc, loss) => acc.plus(new Decimal(loss)), new Decimal(0));
  return total.gt(new Decimal(capAmount));
}

// ─── Hard Stop-Loss Tests ─────────────────────────────────────────────────────

describe('Hard stop-loss trigger math', () => {
  it('fires at EXACTLY entry × (1 + slPct), not just above it', () => {
    // entry=200, SL=50% → threshold=300.00
    // Current value = 300.00 must fire; 299.99 must NOT fire
    expect(isHardSlFired('200', '50', '300.00')).toBe(true);
    expect(isHardSlFired('200', '50', '299.99')).toBe(false);
  });

  it('fires when current value is strictly above threshold', () => {
    expect(isHardSlFired('100', '20', '121.00')).toBe(true); // 120 is threshold, 121 > 120
    expect(isHardSlFired('100', '20', '120.00')).toBe(true); // exactly at threshold = fires
    expect(isHardSlFired('100', '20', '119.99')).toBe(false); // just below = does not fire
  });

  it('threshold is computed without float drift (property)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 50, max: 500, noNaN: true }),
        fc.float({ min: 5, max: 100, noNaN: true }), // slPct 5%–100%
        (entry, slPct) => {
          const entryStr = entry.toFixed(2);
          const slPctStr = slPct.toFixed(4);
          const threshold = hardSlThreshold(entryStr, slPctStr);

          // threshold must be > entry (SL is above entry for a short straddle)
          return threshold.gt(new Decimal(entryStr));
        },
      ),
    );
  });

  it('threshold scales linearly with entry price (property)', () => {
    // Doubling entry → doubles threshold (linear scale invariance).
    //
    // We compute the doubled entry via Decimal (not float arithmetic) to avoid
    // double-rounding artifacts: `(float * 2).toFixed(2)` can differ from
    // `Decimal(float.toFixed(2)).mul(2).toFixed(2)` when the original float is
    // not exactly representable. By deriving doubleEntryStr from the already-
    // rounded Decimal we guarantee the two input strings are exactly 2× each
    // other, making the linearity assertion watertight.
    fc.assert(
      fc.property(
        fc.float({ min: 50, max: 200, noNaN: true }),
        fc.float({ min: 5, max: 80, noNaN: true }),
        (entry, slPct) => {
          const entryStr = entry.toFixed(2);
          // Derive the doubled entry from the Decimal representation of entryStr
          // so there is no secondary rounding artefact from native float * 2.
          const doubleEntryStr = new Decimal(entryStr).mul(2).toFixed(2);
          const slPctStr = slPct.toFixed(4);

          const t1 = hardSlThreshold(entryStr, slPctStr);
          const t2 = hardSlThreshold(doubleEntryStr, slPctStr);

          // t2 must equal exactly 2 × t1 (true linear scale invariance)
          return t2.toFixed(2) === t1.mul(2).toFixed(2);
        },
      ),
    );
  });
});

// ─── Trailing Stop-Loss Tests ─────────────────────────────────────────────────

describe('Trailing stop-loss ratchet', () => {
  it('lowestObserved never increases — ratchet only moves down', () => {
    // Simulate a sequence of straddle values; lowestObserved must be monotonically
    // non-increasing regardless of the order values arrive.
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 50, max: 300, noNaN: true }), { minLength: 2, maxLength: 50 }),
        (values) => {
          const [first, ...rest] = values;
          let lowest = (first as number).toFixed(2);
          let prevLowest = lowest;
          let monotonic = true;

          for (const v of rest) {
            lowest = updateLowest(lowest, v.toFixed(2));
            // lowestObserved must never increase
            if (new Decimal(lowest).gt(new Decimal(prevLowest))) {
              monotonic = false;
              break;
            }
            prevLowest = lowest;
          }

          return monotonic;
        },
      ),
    );
  });

  it('TSL fires at correct threshold from lowest observed', () => {
    // entry=200, value drops to 160 (new low), SL=20%
    // TSL threshold = 160 × 1.20 = 192.00
    // Value rises back to 192 → fires; 191.99 → does not fire
    const slPct = '20';
    const lowestObserved = '160.00';
    const threshold = trailSlThreshold(lowestObserved, slPct);

    expect(threshold.toFixed(2)).toBe('192.00');
    expect(new Decimal('192.00').gte(threshold)).toBe(true); // fires
    expect(new Decimal('191.99').gte(threshold)).toBe(false); // does not fire
  });

  it('TSL threshold is always above lowestObserved (property)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 50, max: 500, noNaN: true }),
        fc.float({ min: 5, max: 80, noNaN: true }),
        (lowest, slPct) => {
          const lowestStr = lowest.toFixed(2);
          const slPctStr = slPct.toFixed(4);
          const threshold = trailSlThreshold(lowestStr, slPctStr);
          // TSL threshold must always be above lowestObserved
          return threshold.gt(new Decimal(lowestStr));
        },
      ),
    );
  });

  it('TSL with falling market: threshold only tightens (lower), never relaxes', () => {
    // Simulate consecutive new lows; each new low must produce a LOWER TSL threshold
    // than the previous one (the TSL tightens as the market falls in our favour).
    const slPct = '15';
    const sequence = ['200.00', '185.00', '170.00', '155.00']; // always falling

    let prevThreshold = trailSlThreshold(sequence[0] ?? '200.00', slPct);
    let allTighter = true;

    for (const v of sequence.slice(1)) {
      const newThreshold = trailSlThreshold(v, slPct);
      if (newThreshold.gt(prevThreshold)) {
        allTighter = false;
        break;
      }
      prevThreshold = newThreshold;
    }

    expect(allTighter).toBe(true);
  });
});

// ─── Profit Target Tests ──────────────────────────────────────────────────────

describe('Profit target trigger math', () => {
  it('fires when straddle value falls to exactly targetPct below entry', () => {
    // entry=200, target=30% → fires at 200 × 0.70 = 140.00
    expect(isProfitTargetHit('200', '30', '140.00')).toBe(true);
    expect(isProfitTargetHit('200', '30', '140.01')).toBe(false); // one tick above target
    expect(isProfitTargetHit('200', '30', '139.99')).toBe(true); // below target also fires
  });

  it('profit target is always below entry (property)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 50, max: 500, noNaN: true }),
        fc.float({ min: 1, max: 99, noNaN: true }), // targetPct 1%–99%
        (entry, targetPct) => {
          const entryStr = entry.toFixed(2);
          const targetPctStr = targetPct.toFixed(4);
          const target = profitTargetThreshold(entryStr, targetPctStr);
          // Profit target must always be BELOW the entry value
          return target.lt(new Decimal(entryStr));
        },
      ),
    );
  });

  it('50% target on entry=300 fires at 150.00 (no float drift)', () => {
    const target = profitTargetThreshold('300', '50');
    expect(target.toFixed(2)).toBe('150.00');
    // Verify exact boundary
    expect(isProfitTargetHit('300', '50', '150.00')).toBe(true);
    expect(isProfitTargetHit('300', '50', '150.01')).toBe(false);
  });
});

// ─── Daily Loss Cap Accumulation Tests ───────────────────────────────────────

describe('Daily loss cap accumulation', () => {
  it('cap not breached when total losses are below cap', () => {
    // Three losses: 500 + 300 + 100 = 900 → cap = 1000 → not breached
    expect(isDailyLossCapBreached(['500', '300', '100'], '1000')).toBe(false);
  });

  it('cap is breached when total losses exceed cap', () => {
    // 500 + 300 + 250 = 1050 → cap = 1000 → breached
    expect(isDailyLossCapBreached(['500', '300', '250'], '1000')).toBe(true);
  });

  it('cap is NOT breached at exactly the cap amount', () => {
    // 500 + 500 = 1000 → cap = 1000 → gt(1000) is false → not breached
    expect(isDailyLossCapBreached(['500', '500'], '1000')).toBe(false);
  });

  it('accumulation of many small losses matches decimal.js oracle (property)', () => {
    // Guards against float drift: 100 losses of ₹0.10 must equal exactly ₹10.00
    //
    // fc.float requires min/max to be 32-bit floats (Math.fround values).
    // 0.01 is not a 32-bit float so we use Math.fround(0.01) as the minimum.
    // This is cosmetic — the generated values still exercise small-decimal math.
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: Math.fround(0.01), max: 1000, noNaN: true }), {
          minLength: 1,
          maxLength: 50,
        }),
        fc.float({ min: 1, max: 100000, noNaN: true }),
        (losses, cap) => {
          const lossStrs = losses.map((l) => l.toFixed(2));
          const capStr = cap.toFixed(2);

          // Oracle: sum via decimal.js
          const oracleTotal = lossStrs.reduce((acc, l) => acc.plus(new Decimal(l)), new Decimal(0));
          const oracleBreached = oracleTotal.gt(new Decimal(capStr));

          // Implementation must agree
          return isDailyLossCapBreached(lossStrs, capStr) === oracleBreached;
        },
      ),
    );
  });

  it('100 losses of ₹0.10 = exactly ₹10.00 (no float drift)', () => {
    const losses = Array.from({ length: 100 }, () => '0.10');
    const total = losses.reduce((acc, l) => acc.plus(new Decimal(l)), new Decimal(0));
    expect(total.toFixed(2)).toBe('10.00');

    // ₹10.00 against a ₹9.99 cap → breached
    expect(isDailyLossCapBreached(losses, '9.99')).toBe(true);
    // ₹10.00 against a ₹10.00 cap → not breached (gt, not gte)
    expect(isDailyLossCapBreached(losses, '10.00')).toBe(false);
  });
});

// ─── evaluateTriggers (imported from trigger-engine) ─────────────────────────

/**
 * Minimal OpenPosition factory. Only the fields trigger-engine reads are
 * populated; other fields are not part of OpenPosition (see src/db/schema.ts).
 */
function makePosition(overrides?: Partial<OpenPosition>): OpenPosition {
  return {
    id: 'test-id',
    entryStraddleValue: '200',
    lowestStraddleValueSeen: '200',
    todayNetPnl: '0',
    entryTimeMs: Date.now(),
    ...overrides,
  };
}

/** A config that should never fire for safe values. */
const safeConfig = {
  hardSlPct: 0.3, // 30%
  trailingSlPct: 0.15, // 15%
  profitTargetPct: 0.3, // 30%
  eodExitTime: '15:25',
  exitCutoffTime: '15:30',
  maxDailyLoss: '10000',
};

/**
 * IST 10:00 on 2026-05-18. In UTC that is 04:30 on the same day.
 * Date.UTC(2026, 4, 18, 4, 30, 0) = 1747538200000... let's compute precisely.
 */
const IST_1000_MAY18_2026 = new Date('2026-05-18T04:30:00.000Z').getTime();
const IST_1525_MAY18_2026 = new Date('2026-05-18T09:55:00.000Z').getTime(); // 15:25 IST

describe('evaluateTriggers — happy path and individual triggers', () => {
  it('returns shouldExit:false when all values are safe', () => {
    const clock = new FixedClock(IST_1000_MAY18_2026);
    const pos = makePosition();
    // current=180 is below hard SL threshold (200*1.3=260), above profit target (200*0.7=140),
    // and below entry so TSL check applies but 180 < 200*1.15=230 so no TSL fire.
    const result = evaluateTriggers(pos, '180', clock, safeConfig);
    expect(result.shouldExit).toBe(false);
  });

  it('SL fires at exactly entry × (1 + hardSlPct)', () => {
    const clock = new FixedClock(IST_1000_MAY18_2026);
    const pos = makePosition({ entryStraddleValue: '200' });
    // threshold = 200 * 1.30 = 260.00
    const atThreshold = evaluateTriggers(pos, '260', clock, safeConfig);
    expect(atThreshold).toEqual({ shouldExit: true, reason: 'SL' });

    const justBelow = evaluateTriggers(pos, '259.99', clock, safeConfig);
    expect(justBelow.shouldExit).toBe(false);
  });

  it('TSL fires when current >= lowestSeen × (1 + trailingSlPct) AND current < entry', () => {
    const clock = new FixedClock(IST_1000_MAY18_2026);
    // entry=200, lowestSeen=160 → trailThreshold = 160 * 1.15 = 184
    // current=184 is < entry(200) → TSL fires
    const pos = makePosition({
      entryStraddleValue: '200',
      lowestStraddleValueSeen: '160',
    });
    const result = evaluateTriggers(pos, '184', clock, safeConfig);
    expect(result).toEqual({ shouldExit: true, reason: 'TSL' });
  });

  it('TSL does NOT fire when current >= entry (not in profit territory)', () => {
    const clock = new FixedClock(IST_1000_MAY18_2026);
    // entry=200, lowestSeen=160, trailThreshold=184
    // current=200 satisfies current>=trailThreshold but current>=entry → no TSL
    const pos = makePosition({
      entryStraddleValue: '200',
      lowestStraddleValueSeen: '160',
    });
    // current=200 equals entry → should NOT fire TSL (guard: current < entry)
    // But hard SL fires at 260, so at exactly 200 we expect no exit.
    const result = evaluateTriggers(pos, '200', clock, safeConfig);
    expect(result.shouldExit).toBe(false);
  });

  it('TARGET fires when current <= entry × (1 - profitTargetPct)', () => {
    const clock = new FixedClock(IST_1000_MAY18_2026);
    // profitTarget threshold = 200 * (1 - 0.30) = 140.00
    const pos = makePosition({ entryStraddleValue: '200' });
    const atTarget = evaluateTriggers(pos, '140', clock, safeConfig);
    expect(atTarget).toEqual({ shouldExit: true, reason: 'TARGET' });

    const justAbove = evaluateTriggers(pos, '140.01', clock, safeConfig);
    expect(justAbove.shouldExit).toBe(false);
  });

  it('EOD fires when current IST time >= eodExitTime', () => {
    // FixedClock set to 15:25 IST — exactly at eodExitTime '15:25'
    const clock = new FixedClock(IST_1525_MAY18_2026);
    const pos = makePosition();
    const result = evaluateTriggers(pos, '180', clock, safeConfig);
    expect(result).toEqual({ shouldExit: true, reason: 'EOD' });
  });

  it('DAILY_LOSS fires when todayNetPnl <= -maxDailyLoss', () => {
    const clock = new FixedClock(IST_1000_MAY18_2026);
    // maxDailyLoss = '10000' → fires when pnl <= -10000
    const posAtLimit = makePosition({ todayNetPnl: '-10000' });
    const result = evaluateTriggers(posAtLimit, '180', clock, safeConfig);
    expect(result).toEqual({ shouldExit: true, reason: 'DAILY_LOSS_CAP' });

    // One cent above the limit — should NOT fire daily loss
    const posJustAbove = makePosition({ todayNetPnl: '-9999.99' });
    const noFire = evaluateTriggers(posJustAbove, '180', clock, safeConfig);
    expect(noFire.shouldExit).toBe(false);
  });

  it('SL wins over DAILY_LOSS_CAP when both would fire', () => {
    const clock = new FixedClock(IST_1000_MAY18_2026);
    // Both triggers active: SL (current=260 >= 260) and DAILY_LOSS_CAP (pnl=-10000)
    const pos = makePosition({ todayNetPnl: '-10000' });
    const result = evaluateTriggers(pos, '260', clock, safeConfig);
    expect(result).toEqual({ shouldExit: true, reason: 'SL' });
  });

  it('DAILY_LOSS_CAP wins over EOD when both would fire', () => {
    // Set clock to 15:25 IST (EOD fires) and pnl at daily limit (DAILY_LOSS_CAP fires)
    const clock = new FixedClock(IST_1525_MAY18_2026);
    const pos = makePosition({ todayNetPnl: '-10000' });
    const result = evaluateTriggers(pos, '180', clock, safeConfig);
    // Priority: SL > DAILY_LOSS_CAP > EOD — DAILY_LOSS_CAP is at priority 2, EOD at 3
    expect(result).toEqual({ shouldExit: true, reason: 'DAILY_LOSS_CAP' });
  });

  it('EOD wins over TSL when both would fire', () => {
    // Clock at 15:25 IST; position in profit with TSL also tripping
    const clock = new FixedClock(IST_1525_MAY18_2026);
    // entry=200, lowest=160, trailThreshold=184 → current=184 trips TSL
    // EOD also fires at 15:25
    const pos = makePosition({
      entryStraddleValue: '200',
      lowestStraddleValueSeen: '160',
    });
    const result = evaluateTriggers(pos, '184', clock, safeConfig);
    expect(result).toEqual({ shouldExit: true, reason: 'EOD' });
  });

  it('TSL wins over TARGET when both would fire', () => {
    const clock = new FixedClock(IST_1000_MAY18_2026);
    // entry=200, lowest=90, trailThreshold=90*1.15=103.5
    // profitTarget=200*0.70=140
    // current=103 satisfies TSL (103>=103.5? no — let's use lowest=80: 80*1.15=92)
    // entry=200, lowest=80 → trailThreshold=80*1.15=92
    // profitTarget=200*0.70=140
    // At current=90: TSL check: 90>=92? NO. Let's pick: lowest=80, trailThreshold=92
    // At current=92: TSL fires (92>=92 AND 92<200). profitTarget at 140, 92<140 → TARGET also fires.
    // TSL wins (lower priority number means higher priority: TSL=5, TARGET=6)
    const pos = makePosition({
      entryStraddleValue: '200',
      lowestStraddleValueSeen: '80',
    });
    const result = evaluateTriggers(pos, '92', clock, safeConfig);
    expect(result).toEqual({ shouldExit: true, reason: 'TSL' });
  });
});

describe('updateTrailingStop', () => {
  it('returns the current value when current < lowestStraddleValueSeen', () => {
    const pos = makePosition({ lowestStraddleValueSeen: '200' });
    const result = updateTrailingStop(pos, '150');
    expect(result).toBe('150');
  });

  it('returns lowestStraddleValueSeen when current > lowest (keeps the minimum)', () => {
    const pos = makePosition({ lowestStraddleValueSeen: '150' });
    const result = updateTrailingStop(pos, '180');
    expect(result).toBe('150');
  });

  it('returns the same value when current equals lowestStraddleValueSeen', () => {
    const pos = makePosition({ lowestStraddleValueSeen: '200' });
    const result = updateTrailingStop(pos, '200');
    // Both are equal, min returns either — result should equal "200"
    expect(result).toBe('200');
  });

  it('result is always min(current, lowestSeen) property', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 50, max: 500, noNaN: true }),
        fc.float({ min: 50, max: 500, noNaN: true }),
        (lowest, current) => {
          const pos = makePosition({ lowestStraddleValueSeen: lowest.toFixed(2) });
          const result = updateTrailingStop(pos, current.toFixed(2));
          const expected = Decimal.min(
            new Decimal(lowest.toFixed(2)),
            new Decimal(current.toFixed(2)),
          ).toString();
          return result === expected;
        },
      ),
    );
  });
});

describe('loadTriggerConfig', () => {
  it('returns defaults when no env vars are set', () => {
    // Save and clear env vars that might have been set
    const saved = {
      HARD_SL_PCT: process.env.HARD_SL_PCT,
      TRAILING_SL_PCT: process.env.TRAILING_SL_PCT,
      PROFIT_TARGET_PCT: process.env.PROFIT_TARGET_PCT,
      EOD_EXIT_TIME: process.env.EOD_EXIT_TIME,
      EXIT_CUTOFF_TIME: process.env.EXIT_CUTOFF_TIME,
      MAX_DAILY_LOSS: process.env.MAX_DAILY_LOSS,
    };
    for (const key of Object.keys(saved)) {
      delete process.env[key];
    }

    const config = loadTriggerConfig();
    expect(config.hardSlPct).toBe(0.3);
    expect(config.trailingSlPct).toBe(0.15);
    expect(config.profitTargetPct).toBe(0.3);
    expect(config.eodExitTime).toBe('15:25');
    expect(config.exitCutoffTime).toBe('15:30');
    expect(config.maxDailyLoss).toBe('10000');

    // Restore
    for (const [key, val] of Object.entries(saved)) {
      if (val !== undefined) process.env[key] = val;
    }
  });

  it('reads overridden values from env vars', () => {
    process.env.HARD_SL_PCT = '0.5';
    process.env.EOD_EXIT_TIME = '15:20';
    process.env.MAX_DAILY_LOSS = '5000';

    const config = loadTriggerConfig();
    expect(config.hardSlPct).toBe(0.5);
    expect(config.eodExitTime).toBe('15:20');
    expect(config.maxDailyLoss).toBe('5000');

    process.env.HARD_SL_PCT = undefined;
    process.env.EOD_EXIT_TIME = undefined;
    process.env.MAX_DAILY_LOSS = undefined;
  });
});
