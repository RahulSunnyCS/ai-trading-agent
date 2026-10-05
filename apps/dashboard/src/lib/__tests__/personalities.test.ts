import { describe, expect, it } from 'vitest';

import type { PaperTrade, PendingSuggestion, Personality } from '../../types/trading';
import {
  ariaSort,
  checkComparisonIntegrity,
  draftFromParam,
  editChangesParams,
  editedParams,
  formatParamValue,
  joinPerformance,
  nextSort,
  paramEntries,
  paramLabel,
  personalityState,
  serverErrorMessage,
  sortPersonalities,
  stopLossKey,
  suggestionChanges,
  suggestionEvidence,
  suggestionTradeDate,
  validateEdit,
  visiblePersonalities,
} from '../personalities';

function personality(over: Partial<Personality> & { id: string }): Personality {
  return {
    name: over.id,
    display_name: over.id,
    group_type: 'reference',
    entry_type: 'momentum_exhaustion',
    management_style: 'hold',
    is_frozen: false,
    is_active: true,
    phase: 1,
    params: {},
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

function trade(over: Partial<PaperTrade> & { id: string }): PaperTrade {
  return {
    entry_time: '2026-10-01T04:00:00Z',
    exit_time: '2026-10-01T06:00:00Z',
    status: 'closed',
    straddle_at_entry: null,
    entry_ce_price: null,
    entry_pe_price: null,
    gross_pnl: null,
    net_pnl: null,
    exit_reason: null,
    lots: 1,
    lot_size: 65,
    ...over,
  };
}

describe('status', () => {
  it('reads paused from is_active and lists inactive rows only on request', () => {
    const list = [
      personality({ id: 'a' }),
      personality({ id: 'b', is_active: false }),
      personality({ id: 'clock', is_frozen: true }),
    ];
    expect(personalityState(list[1] as Personality)).toBe('paused');
    expect(personalityState(list[2] as Personality)).toBe('active');
    expect(visiblePersonalities(list, false).map((p) => p.id)).toEqual(['a', 'clock']);
    expect(visiblePersonalities(list, true)).toHaveLength(3);
  });
});

describe('joinPerformance', () => {
  const list = [personality({ id: 'p1' }), personality({ id: 'p2' })];

  it('sums net P&L, wins and trades per personality', () => {
    const trades = [
      trade({ id: 't1', personality_id: 'p1', net_pnl: '900' }),
      trade({ id: 't2', personality_id: 'p1', net_pnl: '-400' }),
      trade({ id: 't3', personality_id: 'p1', status: 'open', exit_time: null }),
      trade({ id: 't4', personality_id: 'p2', net_pnl: '0' }),
    ];
    const { byId, unattributed } = joinPerformance(list, trades);
    expect(byId.get('p1')).toEqual({ trades: 3, closed: 2, wins: 1, netPnl: 500, winRate: 0.5 });
    expect(byId.get('p2')).toEqual({ trades: 1, closed: 1, wins: 0, netPnl: 0, winRate: 0 });
    expect(unattributed).toBe(0);
  });

  it('skips a missing net P&L instead of counting it as zero', () => {
    const { byId } = joinPerformance(list, [trade({ id: 't', personality_id: 'p1' })]);
    expect(byId.get('p1')).toMatchObject({ closed: 1, netPnl: null, winRate: 0 });
  });

  it('counts trades without a known personality as unattributed', () => {
    const { byId, unattributed } = joinPerformance(list, [
      trade({ id: 'x', net_pnl: '100' }),
      trade({ id: 'y', personality_id: 'gone', net_pnl: '100' }),
    ]);
    expect(unattributed).toBe(2);
    expect(byId.get('p1')).toEqual({
      trades: 0,
      closed: 0,
      wins: 0,
      netPnl: null,
      winRate: null,
    });
  });
});

describe('sorting', () => {
  const rows = [
    personality({ id: 'b', display_name: 'Beta' }),
    personality({ id: 'a', display_name: 'Alpha' }),
    personality({ id: 'c', display_name: 'Gamma' }),
  ];
  const perf = joinPerformance(rows, [
    trade({ id: '1', personality_id: 'b', net_pnl: '50' }),
    trade({ id: '2', personality_id: 'a', net_pnl: '-20' }),
  ]).byId;

  it('keeps the server order with no sort', () => {
    expect(sortPersonalities(rows, null, perf).map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by name and by net P&L with missing values last', () => {
    const byName = sortPersonalities(rows, { key: 'name', direction: 'asc' }, perf);
    expect(byName.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    const desc = sortPersonalities(rows, { key: 'netPnl', direction: 'desc' }, perf);
    expect(desc.map((p) => p.id)).toEqual(['b', 'a', 'c']);
    const asc = sortPersonalities(rows, { key: 'netPnl', direction: 'asc' }, perf);
    expect(asc.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('toggles direction and reports aria-sort', () => {
    expect(nextSort(null, 'netPnl')).toEqual({ key: 'netPnl', direction: 'desc' });
    expect(nextSort(null, 'name')).toEqual({ key: 'name', direction: 'asc' });
    expect(nextSort({ key: 'name', direction: 'asc' }, 'name').direction).toBe('desc');
    expect(ariaSort({ key: 'trades', direction: 'asc' }, 'trades')).toBe('ascending');
    expect(ariaSort({ key: 'trades', direction: 'asc' }, 'name')).toBe('none');
  });
});

describe('parameters', () => {
  it('humanises keys', () => {
    expect(paramLabel('min_probability')).toBe('Minimum probability');
    expect(paramLabel('some_new_knob')).toBe('Some new knob');
  });

  it('formats probabilities as %, money as ₹ and units by suffix', () => {
    expect(formatParamValue('min_probability', 0.7)).toBe('70%');
    expect(formatParamValue('sr_strength_threshold', 0.65)).toBe('65%');
    expect(formatParamValue('max_daily_loss', 8000)).toBe('₹8,000');
    expect(formatParamValue('sl_pct', 25)).toBe('25%');
    expect(formatParamValue('entry_delay_secs', 120)).toBe('120 s');
    expect(formatParamValue('cooldown_days', 1)).toBe('1 day');
    expect(formatParamValue('roll_trigger_points', 70)).toBe('70 pts');
    expect(formatParamValue('learning_speed', 'conservative')).toBe('Conservative');
    expect(formatParamValue('max_daily_trades', 2)).toBe('2');
    expect(formatParamValue('x', Number.NaN)).toBe('—');
  });

  it('lists every parameter with the important ones first', () => {
    const entries = paramEntries({ vix_max: 25, max_daily_trades: 2, min_probability: 0.7 });
    expect(entries.map((e) => e.key)).toEqual(['min_probability', 'max_daily_trades', 'vix_max']);
    expect(entries[0]).toEqual({
      key: 'min_probability',
      label: 'Minimum probability',
      value: '70%',
    });
  });
});

describe('suggestions', () => {
  it('recovers the stored IST date from the serialised timestamp', () => {
    expect(suggestionTradeDate('2026-05-28T18:30:00.000Z')).toBe('2026-05-29');
    expect(suggestionTradeDate('2026-05-29')).toBe('2026-05-29');
  });

  it('pairs each proposed key with the current value', () => {
    const changes = suggestionChanges(
      { min_probability: 0.66, vix_max: 22 },
      { min_probability: 0.7, vix_max: 25 },
    );
    expect(changes[0]).toMatchObject({
      label: 'Minimum probability',
      current: '70%',
      proposed: '66%',
      deltaUnit: 'pp',
      applied: true,
    });
    expect(changes[0]?.delta).toBeCloseTo(-4);
    expect(changes[1]).toMatchObject({ current: '25', proposed: '22', delta: -3, applied: false });
    expect(suggestionChanges({ min_probability: 0.6 }, null)[0]?.current).toBe('—');
    expect(suggestionChanges(null, {})).toEqual([]);
  });

  it('reads the evidence from string-encoded numerics', () => {
    const s: PendingSuggestion = {
      id: 'r',
      personality_id: 'p',
      trade_date: '2026-10-01T18:30:00.000Z',
      market_regime: 'RANGING',
      total_trades: '4',
      winning_trades: 3,
      total_pnl_pct: '1.25',
      beat_clockwork_delta: '-0.5',
      proposed_adjustments: {},
      adjustments_applied: false,
      created_at: '',
    };
    expect(suggestionEvidence(s)).toEqual({
      tradeDate: '2026-10-02',
      trades: 4,
      winRate: 0.75,
      pnlPct: 1.25,
      beatClockwork: -0.5,
    });
  });
});

describe('edit validation', () => {
  const required = { minProbability: true, stopLoss: true };

  it('accepts in-range values and converts the probability to a fraction', () => {
    const v = validateEdit({ minProbabilityPct: '66.5', stopLossPct: '25' }, required);
    expect(v).toEqual({
      values: { minProbability: 0.665, stopLossPct: 25 },
      errors: {},
      valid: true,
    });
  });

  it('rejects empty, non-numeric and out-of-range values', () => {
    expect(validateEdit({ minProbabilityPct: '', stopLossPct: 'abc' }, required).errors).toEqual({
      minProbability: 'Enter a value.',
      stopLoss: 'Enter a number.',
    });
    const range = validateEdit({ minProbabilityPct: '101', stopLossPct: '0' }, required);
    expect(range.valid).toBe(false);
    expect(range.errors.minProbability).toMatch(/0% and 100%/);
    expect(range.errors.stopLoss).toMatch(/more than 0%/);
    expect(validateEdit({ minProbabilityPct: '-1', stopLossPct: '100' }, required).errors).toEqual({
      minProbability: 'Must be between 0% and 100%.',
    });
    expect(validateEdit({ minProbabilityPct: 'NaN', stopLossPct: '5' }, required).valid).toBe(
      false,
    );
  });

  it('allows an empty field only for a parameter the personality never had', () => {
    const v = validateEdit(
      { minProbabilityPct: '', stopLossPct: '' },
      { minProbability: false, stopLoss: false },
    );
    expect(v).toEqual({ values: {}, errors: {}, valid: true });
  });

  it('starts drafts without float noise', () => {
    expect(draftFromParam(0.7, true)).toBe('70');
    expect(draftFromParam(0.665, true)).toBe('66.5');
    expect(draftFromParam(1250, false)).toBe('1250');
    expect(draftFromParam(undefined, true)).toBe('');
  });

  it('writes the stop-loss to the key the personality already uses', () => {
    expect(stopLossKey({ stop_loss_pct: 25 })).toBe('stop_loss_pct');
    expect(stopLossKey({})).toBe('sl_pct');
    const params = { min_probability: 0.7, stop_loss_pct: 25, vix_max: 25 };
    expect(editedParams(params, { minProbability: 0.66, stopLossPct: 30 })).toEqual({
      min_probability: 0.66,
      stop_loss_pct: 30,
      vix_max: 25,
    });
    expect(editChangesParams(params, { minProbability: 0.7, stopLossPct: 25 })).toBe(false);
    expect(editChangesParams(params, { minProbability: 0.71 })).toBe(true);
  });
});

describe('serverErrorMessage', () => {
  it('turns known codes into sentences and passes anything else through', () => {
    expect(serverErrorMessage('FROZEN_VIOLATION')).toMatch(/frozen/);
    expect(serverErrorMessage('no_pending_adjustment')).toMatch(/already applied/);
    expect(serverErrorMessage('HTTP 500 Internal Server Error')).toBe(
      'HTTP 500 Internal Server Error',
    );
  });
});

describe('checkComparisonIntegrity', () => {
  const list = [
    personality({ id: 'clock', entry_type: 'fixed_time', params: {}, is_frozen: true }),
    personality({ id: 'precision', display_name: 'Precision', params: { min_probability: 0.7 } }),
    personality({ id: 'adjuster', display_name: 'Adjuster', params: { min_probability: 0.7 } }),
    personality({
      id: 'reducer',
      display_name: 'Reducer',
      is_active: false,
      params: { min_probability: 0.5 },
    }),
  ];

  it('passes at exactly 8 pp and warns above it', () => {
    expect(checkComparisonIntegrity(list, 'precision', 0.78)).toMatchObject({
      spreadPp: 8,
      ok: true,
    });
    const wide = checkComparisonIntegrity(list, 'precision', 0.79);
    expect(wide?.ok).toBe(false);
    expect(wide?.spreadPp).toBeCloseTo(9);
    expect(wide?.members.map((m) => m.id)).toEqual(['precision', 'adjuster']);
  });

  it('ignores inactive personalities and other entry types', () => {
    expect(checkComparisonIntegrity(list, 'clock', 0.1)).toBeNull();
    expect(checkComparisonIntegrity(list, 'reducer', 0.1)).toBeNull();
    expect(checkComparisonIntegrity(list, 'precision', undefined)).toBeNull();
  });
});
