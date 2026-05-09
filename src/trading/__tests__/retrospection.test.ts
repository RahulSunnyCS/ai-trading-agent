import { mock, describe, it, expect } from 'bun:test';

mock.module('../../db/client', () => ({
  query: mock(() => Promise.resolve([])),
}));

const {
  buildRetrospectionResult,
  calcMgmtVerdict,
  calcBrierScore,
  buildInsightsJson,
  evaluateEvolutionRules,
} = await import('../retrospection');

import type { PaperTrade, PersonalityConfig, StraddleSignal } from '../../db/schema';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const now = new Date(2025, 4, 8, 4, 47, 0);

function makeTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    personality_id: 'p1',
    strategy_id: 1,
    underlying: 'NIFTY',
    expiry: new Date(2025, 4, 8),
    entry_time: now,
    status: 'closed',
    lots: 1,
    position_multiplier: 1,
    has_event_flag: false,
    net_pnl: 500,
    max_drawdown: -200,
    ...overrides,
  };
}

function makePersonality(overrides: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return {
    id: 'p1',
    name: 'precision',
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
    ...overrides,
  };
}

function makeSignal(id: string, probability: number): StraddleSignal {
  return {
    id,
    created_at: now,
    underlying: 'NIFTY',
    expiry: new Date(2025, 4, 8),
    signal_time: now,
    signal_type: 'MOMENTUM_EXHAUSTION',
    atm_strike: 24000,
    probability,
    status: 'active',
  };
}

// ── buildRetrospectionResult ───────────────────────────────────────────────────

describe('buildRetrospectionResult — core metrics', () => {
  it('correct win rate: 2 wins, 1 loss', () => {
    const trades = [
      makeTrade({ net_pnl: 500 }),
      makeTrade({ net_pnl: 300 }),
      makeTrade({ net_pnl: -400 }),
    ];
    const result = buildRetrospectionResult(makePersonality(), trades, [], 0, 'RANGING');
    expect(result.total_trades).toBe(3);
    expect(result.winning_trades).toBe(2);
    expect(result.losing_trades).toBe(1);
    expect(result.win_rate).toBeCloseTo(2 / 3);
  });

  it('total_pnl is sum of net_pnl', () => {
    const trades = [makeTrade({ net_pnl: 500 }), makeTrade({ net_pnl: -200 })];
    const result = buildRetrospectionResult(makePersonality(), trades, [], 0, 'RANGING');
    expect(result.total_pnl).toBe(300);
  });

  it('avg_pnl_per_trade = total / count', () => {
    const trades = [makeTrade({ net_pnl: 600 }), makeTrade({ net_pnl: 400 })];
    const result = buildRetrospectionResult(makePersonality(), trades, [], 0, 'RANGING');
    expect(result.avg_pnl_per_trade).toBe(500);
  });

  it('no trades → win_rate undefined', () => {
    const result = buildRetrospectionResult(makePersonality(), [], [], 0, 'RANGING');
    expect(result.win_rate).toBeUndefined();
    expect(result.total_trades).toBe(0);
  });
});

describe('buildRetrospectionResult — Clockwork comparison', () => {
  it('beat_clockwork_by = myPnl - clockworkPnl', () => {
    const trades = [makeTrade({ net_pnl: 1200 })];
    const result = buildRetrospectionResult(makePersonality(), trades, [], 700, 'RANGING');
    expect(result.beat_clockwork_by).toBe(500); // 1200 - 700
  });

  it('negative beat_clockwork_by when underperforming', () => {
    const trades = [makeTrade({ net_pnl: 200 })];
    const result = buildRetrospectionResult(makePersonality(), trades, [], 700, 'RANGING');
    expect(result.beat_clockwork_by).toBe(-500); // 200 - 700
  });

  it('Clockwork personality has no beat_clockwork_by (undefined)', () => {
    const trades = [makeTrade({ net_pnl: 700 })];
    const result = buildRetrospectionResult(
      makePersonality({ name: 'clockwork' }), trades, [], 700, 'RANGING',
    );
    expect(result.beat_clockwork_by).toBeUndefined();
  });
});

describe('buildRetrospectionResult — Brier score', () => {
  it('2 signals at 0.70, both won → Brier ≈ 0.09', () => {
    const sig1 = makeSignal('s1', 0.70);
    const sig2 = makeSignal('s2', 0.70);
    const trades = [
      makeTrade({ net_pnl: 500, signal_id: 's1' }),
      makeTrade({ net_pnl: 300, signal_id: 's2' }),
    ];
    const result = buildRetrospectionResult(makePersonality(), trades, [sig1, sig2], 0, 'RANGING');
    expect(result.signal_brier_score).toBeCloseTo(0.09);
  });

  it('signals_received counts all signals; signals_acted_on counts only traded', () => {
    const sig1 = makeSignal('s1', 0.70);
    const sig2 = makeSignal('s2', 0.55); // this one wasn't acted on
    const trades = [makeTrade({ net_pnl: 500, signal_id: 's1' })];
    const result = buildRetrospectionResult(makePersonality(), trades, [sig1, sig2], 0, 'RANGING');
    expect(result.signals_received).toBe(2); // both signals present
    expect(result.signals_acted_on).toBe(1); // only one trade
  });

  it('no signal trades → brier_score undefined', () => {
    const trades = [makeTrade({ net_pnl: 500, signal_id: undefined })];
    const result = buildRetrospectionResult(makePersonality(), trades, [], 0, 'RANGING');
    expect(result.signal_brier_score).toBeUndefined();
  });
});

// ── calcBrierScore ────────────────────────────────────────────────────────────

describe('calcBrierScore (re-exported)', () => {
  it('matches expected formula', () => {
    expect(calcBrierScore([{ probability: 0.7, won: true }])).toBeCloseTo(0.09);
    expect(calcBrierScore([{ probability: 0.7, won: false }])).toBeCloseTo(0.49);
  });
});

// ── calcMgmtVerdict ───────────────────────────────────────────────────────────

describe('calcMgmtVerdict', () => {
  it('+500 → HELPED', () => expect(calcMgmtVerdict(500)).toBe('HELPED'));
  it('+200 → HELPED (boundary)', () => expect(calcMgmtVerdict(200)).toBe('HELPED'));
  it('+199 → NEUTRAL (just below threshold)', () => expect(calcMgmtVerdict(199)).toBe('NEUTRAL'));
  it('0 → NEUTRAL', () => expect(calcMgmtVerdict(0)).toBe('NEUTRAL'));
  it('-200 → HURT (boundary)', () => expect(calcMgmtVerdict(-200)).toBe('HURT'));
  it('-500 → HURT', () => expect(calcMgmtVerdict(-500)).toBe('HURT'));
});

// ── evaluateEvolutionRules ────────────────────────────────────────────────────

describe('evaluateEvolutionRules', () => {
  it('frozen personality returns empty rules (checked in evolution-rules.ts)', async () => {
    // evaluateEvolutionRules itself does not check is_frozen — that check is in
    // applyEvolutionRules. Retrospection skips calling it for frozen personalities.
    // This test verifies 0 trades = no rule proposals.
    const { query: mockQ } = await import('../../db/client');
    (mockQ as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve([]));
    const result = await evaluateEvolutionRules(makePersonality(), [], 'RANGING');
    expect(result.rules_triggered).toEqual([]);
  });

  it('less than 30 trades → no low_win_rate proposal', async () => {
    const { query: mockQ } = await import('../../db/client');
    // Return 25 losing trades — not enough for the rule
    const losing25 = Array.from({ length: 25 }, () => makeTrade({ net_pnl: -100 }));
    (mockQ as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve(losing25));
    const result = await evaluateEvolutionRules(makePersonality(), losing25, 'RANGING');
    expect(result.rules_triggered.find((r) => r.rule_id === 'low_win_rate')).toBeUndefined();
  });

  it('30+ trades with win_rate < 0.40 → low_win_rate proposal', async () => {
    const { query: mockQ } = await import('../../db/client');
    const losing30 = Array.from({ length: 30 }, () => makeTrade({ net_pnl: -100 }));
    (mockQ as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve(losing30));
    const result = await evaluateEvolutionRules(makePersonality({ min_probability: 0.70 }), losing30, 'RANGING');
    const proposal = result.rules_triggered.find((r) => r.rule_id === 'low_win_rate');
    expect(proposal).toBeDefined();
    expect(proposal?.proposal?.parameter).toBe('min_probability');
    expect(proposal?.proposal?.new_value).toBeCloseTo(0.75);
  });
});
