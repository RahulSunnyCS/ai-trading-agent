import { describe, it, expect } from 'bun:test';
import { checkPersonalityFilters } from '../personality-engine';
import type { PersonalityConfig, StraddleSignal } from '../../db/schema';
import type { TradeContext } from '../personality-engine';

// ── Fixtures ───────────────────────────────────────────────────────────────────

// 10:00 IST = 04:30 UTC (well within trading hours)
const midMorning = new Date(2025, 4, 8, 4, 30, 0, 0);

// 15:01 IST = 09:31 UTC (after 15:00 cutoff)
const afterCutoff = new Date(2025, 4, 8, 9, 31, 0, 0);

function basePersonality(overrides: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return {
    id: 'p1',
    name: 'test',
    version: 1,
    is_active: true,
    is_frozen: false,
    created_at: new Date(),
    entry_type: 'MOMENTUM_EXHAUSTION',
    management_style: 'HOLD',
    phase: 1,
    min_probability: 0.70,
    max_daily_trades: 2,
    max_daily_loss: 8000,
    entry_delay_secs: 0,
    position_multiplier: 1,
    min_vix: 0,
    max_vix: 30,
    require_profit_gate: false,
    allow_reentry: false,
    allowed_regimes: ['RANGING', 'VOLATILE_REVERTING'],
    allowed_strategies: [1, 2],
    ...overrides,
  };
}

function baseContext(overrides: Partial<TradeContext> = {}): TradeContext {
  return {
    signal: null,
    currentTime: midMorning,
    dailyTradeCount: 0,
    dailyPnl: 0,
    consecutiveLosses: 0,
    currentVix: 15,
    currentRegime: 'RANGING',
    recentPnl5Days: 0,
    ...overrides,
  };
}

function makeSignal(probability: number, signalType = 'MOMENTUM_EXHAUSTION'): StraddleSignal {
  return {
    id: 'sig1',
    created_at: new Date(),
    underlying: 'NIFTY',
    expiry: new Date(2025, 4, 8),
    signal_time: midMorning,
    signal_type: signalType as StraddleSignal['signal_type'],
    atm_strike: 24000,
    probability,
    status: 'active',
  };
}

// ── Stage 1: Hard filters ──────────────────────────────────────────────────────

describe('Stage 1 — hard filters', () => {
  it('all defaults → pass', () => {
    expect(checkPersonalityFilters(basePersonality(), baseContext())).toEqual({ pass: true });
  });

  it('after 15:00 IST cutoff → fail stage 1', () => {
    const result = checkPersonalityFilters(
      basePersonality(),
      baseContext({ currentTime: afterCutoff }),
    );
    expect(result).toMatchObject({ pass: false, stage: 1 });
  });

  it('signal type not in allowed_strategies → fail stage 1', () => {
    const result = checkPersonalityFilters(
      basePersonality({ allowed_strategies: [1] }),
      baseContext({ signal: makeSignal(0.75, 'MOMENTUM_EXHAUSTION') }), // maps to strategy 2
    );
    expect(result).toMatchObject({ pass: false, stage: 1 });
  });

  it('signal type matches allowed_strategies → pass stage 1', () => {
    const result = checkPersonalityFilters(
      basePersonality({ allowed_strategies: [1, 2] }),
      baseContext({ signal: makeSignal(0.75, 'MOMENTUM_EXHAUSTION') }),
    );
    expect(result.pass).toBe(true);
  });
});

// ── Stage 2: Daily state ───────────────────────────────────────────────────────

describe('Stage 2 — daily state', () => {
  it('dailyTradeCount = max_daily_trades → fail stage 2', () => {
    const result = checkPersonalityFilters(
      basePersonality({ max_daily_trades: 2 }),
      baseContext({ dailyTradeCount: 2 }),
    );
    expect(result).toMatchObject({ pass: false, stage: 2, reason: 'daily_trade_limit_reached' });
  });

  it('dailyPnl = -max_daily_loss → fail stage 2', () => {
    const result = checkPersonalityFilters(
      basePersonality({ max_daily_loss: 8000 }),
      baseContext({ dailyPnl: -8000 }),
    );
    expect(result).toMatchObject({ pass: false, stage: 2, reason: 'daily_loss_limit_reached' });
  });

  it('dailyPnl just below max_daily_loss → fail stage 2', () => {
    const result = checkPersonalityFilters(
      basePersonality({ max_daily_loss: 8000 }),
      baseContext({ dailyPnl: -8001 }),
    );
    expect(result).toMatchObject({ pass: false, stage: 2 });
  });

  it('consecutiveLosses = 3 → fail stage 2', () => {
    const result = checkPersonalityFilters(
      basePersonality(),
      baseContext({ consecutiveLosses: 3 }),
    );
    expect(result).toMatchObject({ pass: false, stage: 2, reason: 'consecutive_loss_limit_reached' });
  });
});

// ── Stage 3: Context checks ────────────────────────────────────────────────────

describe('Stage 3 — context checks', () => {
  it('VIX above max_vix → fail stage 3', () => {
    const result = checkPersonalityFilters(
      basePersonality({ max_vix: 30 }),
      baseContext({ currentVix: 35 }),
    );
    expect(result).toMatchObject({ pass: false, stage: 3 });
  });

  it('VIX below min_vix → fail stage 3', () => {
    const result = checkPersonalityFilters(
      basePersonality({ min_vix: 10 }),
      baseContext({ currentVix: 8 }),
    );
    expect(result).toMatchObject({ pass: false, stage: 3 });
  });

  it('null VIX passes stage 3 (VIX unavailable is non-blocking)', () => {
    const result = checkPersonalityFilters(
      basePersonality({ max_vix: 20 }),
      baseContext({ currentVix: null }),
    );
    expect(result.pass).toBe(true);
  });

  it('regime not in allowed_regimes → fail stage 3', () => {
    const result = checkPersonalityFilters(
      basePersonality({ allowed_regimes: ['RANGING'] }),
      baseContext({ currentRegime: 'TRENDING_STRONG' }),
    );
    expect(result).toMatchObject({ pass: false, stage: 3 });
  });

  it('null regime passes (regime unknown is non-blocking)', () => {
    const result = checkPersonalityFilters(
      basePersonality({ allowed_regimes: ['RANGING'] }),
      baseContext({ currentRegime: null }),
    );
    expect(result.pass).toBe(true);
  });
});

// ── Stage 4: Signal quality ────────────────────────────────────────────────────

describe('Stage 4 — signal quality', () => {
  it('signal probability below min_probability → fail stage 4', () => {
    const result = checkPersonalityFilters(
      basePersonality({ min_probability: 0.70 }),
      baseContext({ signal: makeSignal(0.60) }),
    );
    expect(result).toMatchObject({ pass: false, stage: 4 });
  });

  it('signal probability equals min_probability → pass', () => {
    const result = checkPersonalityFilters(
      basePersonality({ min_probability: 0.70 }),
      baseContext({ signal: makeSignal(0.70) }),
    );
    expect(result.pass).toBe(true);
  });

  it('null signal (scheduled entry) skips stage 4', () => {
    const result = checkPersonalityFilters(
      basePersonality({ min_probability: 0.80 }),
      baseContext({ signal: null }),
    );
    expect(result.pass).toBe(true);
  });

  it('is_frozen Clockwork passes all stages (frozen blocks evolution, not trading)', () => {
    const clockwork = basePersonality({ is_frozen: true, min_probability: undefined });
    const result = checkPersonalityFilters(clockwork, baseContext({ signal: null }));
    expect(result.pass).toBe(true);
  });
});

// ── Stage 5: Profit gate ───────────────────────────────────────────────────────

describe('Stage 5 — profit gate', () => {
  it('profit gate not met → fail stage 5', () => {
    const result = checkPersonalityFilters(
      basePersonality({ require_profit_gate: true, profit_gate_amount: 5000 }),
      baseContext({ recentPnl5Days: 3000 }),
    );
    expect(result).toMatchObject({ pass: false, stage: 5 });
  });

  it('profit gate met → pass', () => {
    const result = checkPersonalityFilters(
      basePersonality({ require_profit_gate: true, profit_gate_amount: 5000 }),
      baseContext({ recentPnl5Days: 6000 }),
    );
    expect(result.pass).toBe(true);
  });

  it('require_profit_gate = false → stage 5 skipped', () => {
    const result = checkPersonalityFilters(
      basePersonality({ require_profit_gate: false, profit_gate_amount: 5000 }),
      baseContext({ recentPnl5Days: -1000 }),
    );
    expect(result.pass).toBe(true);
  });
});
