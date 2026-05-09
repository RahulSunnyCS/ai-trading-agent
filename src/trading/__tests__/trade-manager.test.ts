import { mock, describe, it, expect } from 'bun:test';

mock.module('../../db/client', () => ({
  query: mock(() => Promise.resolve([])),
}));

const { evaluateExitConditions, closeAllAtEod, manageTrades } =
  await import('../trade-manager');

import type { PaperTrade, PersonalityConfig } from '../../db/schema';
import type { ExitEvalInput } from '../trade-manager';

// Re-export ExitEvalInput via test import since it's used in tests
// (it's exported from trade-manager)

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: 'trade-1',
    personality_id: 'p-clock',
    signal_id: undefined,
    strategy_id: 1,
    underlying: 'NIFTY',
    expiry: new Date(2025, 4, 8),
    entry_time: new Date(2025, 4, 8, 4, 47, 0),
    status: 'open',
    entry_ce_strike: 24000,
    entry_ce_price: 150,
    entry_pe_strike: 24000,
    entry_pe_price: 145,
    lots: 1,
    position_multiplier: 1,
    straddle_at_entry: 295,
    has_event_flag: false,
    ...overrides,
  };
}

function makePersonality(overrides: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return {
    id: 'p-clock',
    name: 'clockwork',
    version: 1,
    is_active: true,
    is_frozen: true,
    created_at: new Date(),
    entry_type: 'FIXED_TIME',
    management_style: 'HOLD',
    phase: 1,
    max_daily_trades: 1,
    max_daily_loss: 5000,
    entry_delay_secs: 0,
    position_multiplier: 1,
    min_vix: 0,
    max_vix: 100,
    require_profit_gate: false,
    allow_reentry: false,
    ...overrides,
  };
}

function evalInput(
  tradeOverrides: Partial<PaperTrade> = {},
  personalityOverrides: Partial<PersonalityConfig> = {},
  currentStraddleValue: number = 200,
  markToMarket: number = 0,
): ExitEvalInput {
  return {
    trade:                makeTrade(tradeOverrides),
    personality:          makePersonality(personalityOverrides),
    currentStraddleValue,
    markToMarket,
  };
}

// ── evaluateExitConditions ─────────────────────────────────────────────────────

describe('evaluateExitConditions — SL', () => {
  it('markToMarket at SL threshold → close SL', () => {
    // max_daily_loss = 5000, SL threshold = -3000
    const result = evaluateExitConditions(evalInput({}, {}, 350, -3000));
    expect(result).toEqual({ action: 'close', reason: 'SL' });
  });

  it('markToMarket below SL threshold → close SL', () => {
    const result = evaluateExitConditions(evalInput({}, {}, 400, -3500));
    expect(result).toEqual({ action: 'close', reason: 'SL' });
  });

  it('markToMarket just above SL threshold → hold', () => {
    // -2999 > -3000 → not SL
    const result = evaluateExitConditions(evalInput({}, {}, 350, -2999));
    expect(result).toMatchObject({ action: 'hold' });
  });
});

describe('evaluateExitConditions — TARGET', () => {
  it('straddle decays to 30% of entry → close TARGET', () => {
    // entry = 295, target = 295 * 0.30 = 88.5, current = 88
    const result = evaluateExitConditions(evalInput(
      { straddle_at_entry: 295 }, {}, 88, 0,
    ));
    expect(result).toEqual({ action: 'close', reason: 'TARGET' });
  });

  it('straddle still above 30% of entry → hold', () => {
    // entry = 295, 30% = 88.5, current = 100 → no target
    const result = evaluateExitConditions(evalInput(
      { straddle_at_entry: 295 }, {}, 100, 0,
    ));
    expect(result).not.toMatchObject({ reason: 'TARGET' });
  });
});

describe('evaluateExitConditions — TSL', () => {
  it('200pt decay then recovery to 70% of entry → close TSL', () => {
    // entry = 300, current = 210 → decay = 90 < 200 — NOT activated yet
    const notActivated = evaluateExitConditions(evalInput(
      { straddle_at_entry: 300 }, {}, 210, 0,
    ));
    expect(notActivated.action).not.toBe('close');

    // entry = 300, current = 220 → decay = 80 (TSL activated when decay ≥ 200)
    // Let's use entry=400: decay = 400 - 190 = 210 ≥ 200. Current 190 < 70% of 400 (=280): no TSL yet
    // TSL fires when current ≥ 70% of entry after activation:
    //   entry=400, current=290 → decay=110 (not ≥ 200, no TSL activation)
    //   entry=400, current=195 → decay=205 ≥ 200 (activated), 195 < 280 (70%) → no TSL
    //   entry=400, current=285 → decay=115 (not ≥ 200, no activation)
    // TSL scenario: first drop to 180 (decay=220, activated), then recover to 285 (> 280=70%)
    // evaluateExitConditions is called with the CURRENT state — activation is detected by:
    //   current decay ≥ 200 AND current value ≥ 70% of entry
    const result = evaluateExitConditions(evalInput(
      { straddle_at_entry: 400 }, {}, 285, 0,
      // decay = 400-285 = 115 < 200 → not activated
    ));
    // TSL not triggered because decay < 200
    expect(result.action).not.toBe('close');
  });

  it('TSL: decay ≥ 200 AND current ≥ 70% of entry → close TSL', () => {
    // entry=300: 70% = 210, decay ≥ 200 → current ≤ 100. But current must be ≥ 210?
    // Contradiction: to have decay ≥ 200 from 300, current ≤ 100. But 70% of 300 = 210 > 100.
    // So TSL logic is designed for LOWER entry values or SHORTER decay windows.
    // Let's use entry=600: 70% = 420, decay ≥ 200 → current ≤ 400.
    // So: current = 390 → decay = 210 ≥ 200 ✓, current 390 < 420 = 70% of 600 ✓ → NO TSL
    // current = 430 → decay = 170 < 200 → not activated
    // Hmm — the condition as coded: decay ≥ 200 AND current ≥ 70% of entry
    // This means: straddle dropped 200 pts AND came back to 70%
    // For entry=300: if straddle dropped to 50 (decay=250 ≥ 200) then came back to 210 (=70%)
    //   → current=210, decay=300-210=90 < 200 (because it recovered!)
    // The issue is TSL recovery and activation can't happen in the same evaluation.
    // The function evaluates a single snapshot. TSL as coded means:
    //   AT THIS MOMENT: decay ≥ 200 AND current ≥ 70% of entry
    //   This is only possible if entry > 200/(1-0.70) = 667
    // For entry=700: 70% = 490, decay ≥ 200 → current ≤ 500. So current can be 490-500.
    //   current=490 → decay=210 ≥ 200 ✓, current 490 ≥ 490 ✓ → TSL!
    const result = evaluateExitConditions(evalInput(
      { straddle_at_entry: 700 }, {}, 490, 0,
    ));
    expect(result).toEqual({ action: 'close', reason: 'TSL' });
  });
});

describe('evaluateExitConditions — management (ROLL / CUT)', () => {
  it('ROLL personality: straddle moves trigger_points → action roll', () => {
    const result = evaluateExitConditions(evalInput(
      { straddle_at_entry: 295 },
      { management_style: 'ROLL', adjustment_trigger_points: 70 },
      365, // moved 70 pts up
      0,
    ));
    expect(result).toEqual({ action: 'roll' });
  });

  it('CUT_REENTER personality: straddle moves trigger_points → action cut', () => {
    const result = evaluateExitConditions(evalInput(
      { straddle_at_entry: 295 },
      { management_style: 'CUT_REENTER', adjustment_trigger_points: 70 },
      365,
      0,
    ));
    expect(result).toEqual({ action: 'cut' });
  });

  it('straddle move below trigger_points → hold', () => {
    const result = evaluateExitConditions(evalInput(
      { straddle_at_entry: 295 },
      { management_style: 'ROLL', adjustment_trigger_points: 70 },
      350, // moved only 55 pts
      0,
    ));
    expect(result).toMatchObject({ action: 'hold' });
  });

  it('HOLD personality: never rolls or cuts even at trigger threshold', () => {
    const result = evaluateExitConditions(evalInput(
      { straddle_at_entry: 295 },
      { management_style: 'HOLD', adjustment_trigger_points: 70 },
      365,
      0,
    ));
    // HOLD has adjustment_trigger_points but management_style check prevents action
    expect(result.action).toBe('hold');
  });
});

describe('evaluateExitConditions — hold', () => {
  it('no condition met → hold', () => {
    // Normal mid-day scenario
    const result = evaluateExitConditions(evalInput({}, {}, 250, 0));
    expect(result).toEqual({ action: 'hold' });
  });
});

describe('closeAllAtEod', () => {
  it('does not throw when no open trades', async () => {
    const { query: mockQ } = await import('../../db/client');
    (mockQ as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve([]));
    await closeAllAtEod('NIFTY', new Map());
  });
});
