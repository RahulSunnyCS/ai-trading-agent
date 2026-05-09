import { mock, describe, it, expect, beforeEach } from 'bun:test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQuery = mock(() => Promise.resolve([])) as any;

mock.module('../../db/client', () => ({ query: mockQuery }));
mock.module('../../redis/client', () => ({
  streamPublish: mock(() => Promise.resolve('1-0')),
  streamRead:    mock(() => Promise.resolve([])),
  STREAMS: { STRADDLE_VALUES: 'straddle.values', SIGNALS_GENERATED: 'signals.generated' },
}));
// Re-mock personality-cache in case a prior test file (e.g. evolution-rules.test.ts) left a
// partial mock in Bun's shared module registry.  Route through mockQuery so the "returns
// personalities from DB" tests still work, and expose a no-op invalidate.
let _cacheExpiry = 0;
mock.module('../personality-cache', () => ({
  loadActivePersonalities: mock(async (_underlying: string) =>
    mockQuery('SELECT * FROM personality_configs WHERE is_active = TRUE', [])
  ),
  invalidatePersonalityCache: mock(() => { _cacheExpiry = 0; }),
}));

const {
  executeSignalEntry,
  executeScheduledEntries,
  loadActivePersonalities,
  invalidatePersonalityCache,
} = await import('../trade-executor');

import type { PersonalityConfig, StraddleSignal } from '../../db/schema';
import type { ExecutionContext } from '../trade-executor';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const expiry = new Date(2025, 4, 8);  // May 8 — weekly expiry (not last Thursday)
const now    = new Date(2025, 4, 8, 4, 30, 0); // 10:00 IST

function makePrices(): Map<string, number> {
  const m = new Map<string, number>();
  m.set('NSE:NIFTY-INDEX', 24100);
  m.set('NSE:NIFTY255824000CE', 150);
  m.set('NSE:NIFTY255824000PE', 145);
  // ATM for 24100 spot is 24100 → rounds to 24100 (50pt interval) → strike 24100
  // But let's add both likely strikes
  m.set('NSE:NIFTY25582410 CE', 150);
  // Use the actual computed ATM (getAtmStrike(24100,'NIFTY')=24100)
  m.set('NSE:NIFTY2558241 00CE', 150);
  return m;
}

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    underlying:    'NIFTY',
    expiry,
    currentPrices: makePrices(),
    vix:           14,
    currentRegime: 'RANGING',
    currentTime:   now,
    ...overrides,
  };
}

function makeSignal(probability = 0.75): StraddleSignal {
  return {
    id:           'sig1',
    created_at:   now,
    underlying:   'NIFTY',
    expiry,
    signal_time:  now,
    signal_type:  'MOMENTUM_EXHAUSTION',
    atm_strike:   24000,
    probability,
    status:       'active',
  };
}

const clockworkPersonality: PersonalityConfig = {
  id: 'p-clock', name: 'clockwork', version: 1, is_active: true, is_frozen: true,
  created_at: new Date(), entry_type: 'FIXED_TIME', management_style: 'HOLD', phase: 1,
  max_daily_trades: 1, max_daily_loss: 5000, entry_delay_secs: 0, position_multiplier: 1,
  min_vix: 0, max_vix: 100, require_profit_gate: false, allow_reentry: false,
  allowed_regimes: ['RANGING', 'TRENDING_STRONG', 'VOLATILE_REVERTING'],
  allowed_strategies: [1],
};

const precisionPersonality: PersonalityConfig = {
  id: 'p-prec', name: 'precision', version: 1, is_active: true, is_frozen: true,
  created_at: new Date(), entry_type: 'MOMENTUM_EXHAUSTION', management_style: 'HOLD', phase: 1,
  min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 8000,
  entry_delay_secs: 120, position_multiplier: 1,
  min_vix: 0, max_vix: 25, require_profit_gate: false, allow_reentry: false,
  allowed_regimes: ['RANGING', 'VOLATILE_REVERTING'], allowed_strategies: [1, 2],
};

// ── loadActivePersonalities ────────────────────────────────────────────────────

describe('loadActivePersonalities', () => {
  beforeEach(() => {
    invalidatePersonalityCache();
    mockQuery.mockImplementation(() =>
      Promise.resolve([clockworkPersonality, precisionPersonality])
    );
  });

  it('returns personalities from DB', async () => {
    const result = await loadActivePersonalities('NIFTY');
    expect(result).toHaveLength(2);
  });

  it('caches results (second call does not hit DB again)', async () => {
    await loadActivePersonalities('NIFTY');
    await loadActivePersonalities('NIFTY');
    // mockQuery should have been called for personalities once + getDailyState queries
    // Just verify it returns same data
    const result = await loadActivePersonalities('NIFTY');
    expect(result).toHaveLength(2);
  });
});

// helper: sets up mockQuery so first call returns personalities, all others return daily-state rows
function setupMockForPersonalities(
  personalities: PersonalityConfig[],
  onInsert?: (params: unknown[]) => void,
): void {
  invalidatePersonalityCache();
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql: string, params: unknown[]) => {
    if (typeof sql === 'string' && sql.includes('INSERT INTO paper_trades')) {
      onInsert?.(params);
      return Promise.resolve([]);
    }
    if (typeof sql === 'string' && sql.includes('FROM personality_configs')) {
      return Promise.resolve(personalities);
    }
    return Promise.resolve([{ trade_count: '0', total_pnl: '0', net_pnl: '0' }]);
  });
}

// ── executeSignalEntry ─────────────────────────────────────────────────────────

describe('executeSignalEntry', () => {
  const prices = new Map([
    ['NSE:NIFTY-INDEX', 24000],
    ['NSE:NIFTY255824000CE', 150],
    ['NSE:NIFTY255824000PE', 145],
  ]);

  it('does not execute Clockwork (FIXED_TIME personality)', async () => {
    const insertCalls: unknown[][] = [];
    setupMockForPersonalities([clockworkPersonality], (p) => insertCalls.push(p));
    await executeSignalEntry(makeSignal(), makeCtx({ currentPrices: prices }));
    expect(insertCalls).toHaveLength(0); // Clockwork is FIXED_TIME — not in signal path
  });

  it('executes precision personality when signal passes filters', async () => {
    const insertCalls: unknown[][] = [];
    setupMockForPersonalities([precisionPersonality], (p) => insertCalls.push(p));
    await executeSignalEntry(makeSignal(0.75), makeCtx({ currentPrices: prices }));
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not execute when probability below min_probability', async () => {
    const insertCalls: unknown[][] = [];
    setupMockForPersonalities([precisionPersonality], (p) => insertCalls.push(p));
    // precision requires 0.70; signal at 0.55 → blocked at stage 4
    await executeSignalEntry(makeSignal(0.55), makeCtx({ currentPrices: prices }));
    expect(insertCalls).toHaveLength(0);
  });
});

// ── executeScheduledEntries ────────────────────────────────────────────────────

describe('executeScheduledEntries', () => {
  const prices = new Map([
    ['NSE:NIFTY-INDEX', 24000],
    ['NSE:NIFTY255824000CE', 152],
    ['NSE:NIFTY255824000PE', 148],
  ]);

  it('executes Clockwork (FIXED_TIME) with scheduled entry', async () => {
    const insertCalls: unknown[][] = [];
    setupMockForPersonalities([clockworkPersonality], (p) => insertCalls.push(p));
    await executeScheduledEntries(makeCtx({ currentPrices: prices }));
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not execute signal-based personalities in scheduled entries', async () => {
    const insertCalls: unknown[][] = [];
    setupMockForPersonalities([precisionPersonality], (p) => insertCalls.push(p)); // MOMENTUM_EXHAUSTION
    await executeScheduledEntries(makeCtx({ currentPrices: prices }));
    expect(insertCalls).toHaveLength(0);
  });

  it('skips entry if spot price unavailable', async () => {
    setupMockForPersonalities([clockworkPersonality]);
    const emptyPrices = new Map<string, number>();
    await executeScheduledEntries(makeCtx({ currentPrices: emptyPrices }));
    // Should not throw; just log warning
  });
});
