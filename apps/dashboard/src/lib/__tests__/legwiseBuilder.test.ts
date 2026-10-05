import { describe, expect, it } from 'vitest';

import type { Leg, LegwiseStrategy } from '../../types/legwise';
import {
  STRATEGY_NAME_RE,
  TEMPLATES,
  UNDERLYINGS,
  backtestLabel,
  buildTemplate,
  fromSaved,
  isDirty,
  newLeg,
  newStrategy,
  nextLegId,
  parseIssue,
  placeIssues,
  plainMessage,
  runFailureKind,
  runTotals,
  shortRunId,
  sparkline,
  strategiesEqual,
  summarizeLeg,
  toPayload,
} from '../legwiseBuilder';

const leg = (over: Partial<Leg> = {}): Leg => ({ ...newLeg('leg1'), ...over });

describe('summarizeLeg', () => {
  it('reads as one line: side, size, index, expiry, strike, option, then the rules', () => {
    expect(summarizeLeg(leg({ reentry_on_sl: { mode: 'cost', count: 1 } }), 'NIFTY')).toBe(
      'SELL 1× NIFTY weekly ATM CE · SL 25% · re-entry at cost',
    );
  });

  it('covers premium strikes, points, trail, target re-entry and range breakout', () => {
    const text = summarizeLeg(
      leg({
        position: 'buy',
        lots: 2,
        option_type: 'PE',
        expiry: 'next_weekly',
        strike: { closest_premium: 50 },
        stop_loss: { points: 12.5 },
        target: { percent: 40 },
        trail_sl: { points: [15, 10] },
        reentry_on_sl: { mode: 'asap', count: 3 },
        reentry_on_target: { mode: 'cost', count: 1 },
        range_breakout: { until: '09:45', side: 'high', source: 'underlying' },
      }),
      'BANKNIFTY',
    );
    expect(text).toBe(
      'BUY 2× BANKNIFTY next weekly premium ≈ 50 PE · SL 12.5 pts · target 40% · trail 15/10 pts · re-entry ASAP ×3 · re-entry on target at cost · enters on index high break after 09:45',
    );
  });

  it('says nothing about rules that are off', () => {
    const bare = leg();
    bare.stop_loss = undefined;
    expect(summarizeLeg(bare, 'SENSEX')).toBe('SELL 1× SENSEX weekly ATM CE');
  });
});

describe('nextLegId', () => {
  it('gives the next free legN', () => {
    expect(nextLegId([])).toBe('leg1');
    expect(nextLegId(['leg1', 'leg2'])).toBe('leg3');
    expect(nextLegId(['leg1', 'leg3'])).toBe('leg2');
  });

  it('keeps the stem of a copied leg and never repeats an id', () => {
    expect(nextLegId(['leg1', 'leg2'], 'leg1')).toBe('leg3');
    expect(nextLegId(['ce', 'pe'], 'ce')).toBe('ce2');
    expect(nextLegId(['ce', 'pe', 'ce2'], 'ce')).toBe('ce3');
    expect(nextLegId(['ce', 'pe', 'ce2'], 'ce2')).toBe('ce3');
    const ids = ['a'];
    for (let i = 0; i < 5; i++) ids.push(nextLegId(ids, ids[ids.length - 1]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('falls back to legN for an id that is only digits or empty', () => {
    expect(nextLegId(['1'], '1')).toBe('leg1');
    expect(nextLegId([''], '')).toBe('leg1');
  });
});

describe('isDirty / strategiesEqual', () => {
  const base = { name: 'my_strategy', strategy: newStrategy() };

  it('is clean for a fresh form and for the same content in another key order', () => {
    expect(isDirty({ name: 'my_strategy', strategy: newStrategy() }, base)).toBe(false);
    const reordered = JSON.parse(
      JSON.stringify(newStrategy(), Object.keys(newStrategy()).sort().reverse()),
    ) as LegwiseStrategy;
    // The replacer array drops nested keys, so rebuild the nested parts.
    const same: LegwiseStrategy = { ...newStrategy(), ...reordered, ...newStrategy() };
    expect(strategiesEqual(same, base.strategy)).toBe(true);
  });

  it('ignores unset optionals: undefined, missing and an empty time are the same', () => {
    const withUndefined: LegwiseStrategy = {
      ...newStrategy(),
      no_reentry_after: '',
      overall: { stop_loss_inr: undefined },
    };
    expect(strategiesEqual(withUndefined, newStrategy())).toBe(true);
  });

  it('treats a saved file without overall/execution as equal to the form holding it', () => {
    const { overall: _overall, execution: _execution, ...rest } = newStrategy();
    const file = rest as LegwiseStrategy;
    expect(strategiesEqual(file, fromSaved(file))).toBe(true);
  });

  it('is dirty after a nested edit, a renamed file, or a removed leg', () => {
    const edited = newStrategy();
    edited.legs[1] = { ...leg({ id: 'leg2', option_type: 'PE' }), stop_loss: { percent: 30 } };
    expect(isDirty({ name: 'my_strategy', strategy: edited }, base)).toBe(true);
    expect(isDirty({ name: 'other', strategy: newStrategy() }, base)).toBe(true);
    const fewer = { ...newStrategy(), legs: newStrategy().legs.slice(0, 1) };
    expect(isDirty({ name: 'my_strategy', strategy: fewer }, base)).toBe(true);
  });

  it('notices a changed trail tuple order', () => {
    const a = { ...newStrategy(), legs: [leg({ trail_sl: { points: [10, 5] } })] };
    const b = { ...newStrategy(), legs: [leg({ trail_sl: { points: [5, 10] } })] };
    expect(strategiesEqual(a, b)).toBe(false);
  });
});

describe('toPayload', () => {
  it('drops undefined keys and an empty no_reentry_after', () => {
    const payload = toPayload({
      ...newStrategy(),
      no_reentry_after: '',
      overall: { target_inr: undefined },
    });
    expect('no_reentry_after' in payload).toBe(false);
    expect(payload.overall).toEqual({});
  });
});

describe('templates', () => {
  it('builds each template for each index with unique leg ids and a valid file name', () => {
    for (const t of TEMPLATES) {
      for (const u of UNDERLYINGS) {
        const s = buildTemplate(t.id, u);
        expect(s.underlying).toBe(u);
        expect(STRATEGY_NAME_RE.test(s.id)).toBe(true);
        expect(new Set(s.legs.map((l) => l.id)).size).toBe(s.legs.length);
        // The schema refuses re-entry with complete square-off; templates must not combine them.
        if (s.square_off === 'complete')
          expect(s.legs.some((l) => l.reentry_on_sl || l.reentry_on_target)).toBe(false);
      }
    }
  });

  it('shapes the three structures', () => {
    expect(buildTemplate('short_straddle', 'NIFTY').legs.map((l) => l.strike.strike_type)).toEqual([
      'ATM',
      'ATM',
    ]);
    expect(buildTemplate('short_strangle', 'NIFTY').legs.map((l) => l.strike.strike_type)).toEqual([
      'OTM2',
      'OTM2',
    ]);
    const condor = buildTemplate('iron_condor', 'SENSEX');
    expect(
      condor.legs.map((l) => `${l.position} ${l.option_type} ${l.strike.strike_type}`),
    ).toEqual(['sell CE OTM2', 'sell PE OTM2', 'buy CE OTM5', 'buy PE OTM5']);
    expect(condor.id).toBe('sensex_iron_condor');
  });
});

describe('validation messages', () => {
  const strategy = {
    legs: [leg({ id: 'ce' }), leg({ id: 'pe' })],
  };

  it('rewrites pydantic phrases as plain sentences and keeps unknown ones', () => {
    expect(plainMessage('Input should be greater than 0')).toBe('Must be greater than 0');
    expect(plainMessage('Input should be greater than or equal to 1')).toBe('Must be 1 or more');
    expect(plainMessage('Input should be less than or equal to 20')).toBe('Must be 20 or less');
    expect(plainMessage("Value error, '09:00' is outside the 09:15-15:29 session")).toBe(
      'Time must be within the 09:15–15:29 session',
    );
    expect(plainMessage('Value error, something new the engine says')).toBe(
      'something new the engine says',
    );
  });

  it('places a nested leg path on that leg field', () => {
    expect(
      parseIssue('legs.1.stop_loss.percent: Input should be greater than 0', strategy),
    ).toEqual({
      path: 'legs.1.stop_loss.percent',
      slot: 'legs.1.stop_loss',
      legIndex: 1,
      message: 'Must be greater than 0',
      raw: 'Input should be greater than 0',
    });
    expect(
      parseIssue('legs.0.trail_sl.points.0: Input should be a valid number', strategy).slot,
    ).toBe('legs.0.trail_sl');
  });

  it('places a leg-level message on the field it names, else on the leg', () => {
    expect(
      parseIssue("legs.0: Value error, leg 'ce': trail_sl needs a stop_loss to trail", strategy),
    ).toMatchObject({ slot: 'legs.0.trail_sl', message: 'Trail SL needs a stop loss to trail' });
    expect(parseIssue('legs.1: Value error, something else', strategy).slot).toBe('legs.1');
  });

  it('places strategy-level messages by what they say', () => {
    expect(
      parseIssue('strategy: Value error, exit_time must be after entry_time', strategy),
    ).toMatchObject({ slot: 'exit_time', message: 'Exit must be after entry' });
    expect(
      parseIssue(
        "strategy: Value error, leg 'pe': range_breakout.until must be inside entry-exit",
        strategy,
      ),
    ).toMatchObject({ slot: 'legs.1.range_breakout', legIndex: 1 });
    expect(
      parseIssue(
        'strategy: Value error, re-entry with square_off: complete is not supported yet',
        strategy,
      ).slot,
    ).toBe('square_off');
    expect(
      parseIssue("strategy: Value error, leg ids must be unique, got ['a', 'a']", strategy),
    ).toMatchObject({ slot: null, message: 'Two legs share an id; give each leg its own id' });
  });

  it('places top-level and nested paths, and leaves unknown ones unplaced', () => {
    expect(parseIssue('overall.stop_loss_inr: Input should be greater than 0', strategy).slot).toBe(
      'overall.stop_loss_inr',
    );
    expect(
      parseIssue("entry_time: Value error, '09:00' is outside the 09:15-15:29 session", strategy)
        .slot,
    ).toBe('entry_time');
    expect(parseIssue('foo: Extra inputs are not permitted', strategy).slot).toBeNull();
    expect(parseIssue('no collected NIFTY days in that range', strategy)).toMatchObject({
      slot: null,
      message: 'no collected NIFTY days in that range',
    });
  });

  it('groups by slot, counts per leg and lists the rest', () => {
    const placed = placeIssues(
      [
        'legs.0.lots: Input should be greater than 0',
        'legs.0.stop_loss.percent: Input should be greater than 0',
        'execution.slippage_pct: Input should be greater than or equal to 0',
        'legs: List should have at least 1 item after validation, not 0',
        'foo: Extra inputs are not permitted',
      ],
      strategy,
    );
    expect(placed.count).toBe(5);
    expect(placed.byLeg).toEqual({ 0: 2 });
    expect(placed.bySlot['legs.0.lots']).toEqual(['Must be greater than 0']);
    expect(placed.bySlot['execution.slippage_pct']).toEqual(['Must be 0 or more']);
    expect(placed.unplaced.map((i) => i.message)).toEqual([
      'Add at least one leg',
      'This setting is not supported by the engine',
    ]);
  });
});

describe('run rail figures', () => {
  it('states the cost beside Backtest whenever billing is on', () => {
    expect(backtestLabel({ enabled: false, balance: null })).toBe('Backtest');
    expect(backtestLabel({ enabled: true, balance: 12 })).toBe('Backtest · 1 credit · 12 left');
    expect(backtestLabel({ enabled: true, balance: 0 })).toBe('Backtest · 1 credit · 0 left');
    expect(backtestLabel({ enabled: true, balance: null })).toBe('Backtest · 1 credit');
  });

  it('recognises a refused run', () => {
    expect(runFailureKind(402, 'insufficient_credits')).toBe('credits');
    expect(runFailureKind(403, 'access_denied')).toBe('access');
    expect(runFailureKind(404, 'no collected NIFTY days in that range')).toBe('other');
    expect(runFailureKind(undefined, 'Failed to fetch')).toBe('other');
  });

  it('sums gross, costs and net per lot', () => {
    const days = [
      { gross: 300, costs: 40, net: 260 },
      { gross: -100, costs: 40, net: -140 },
    ];
    expect(runTotals(days, 2)).toEqual({ days: 2, gross: 100, costs: 40, net: 60 });
    expect(runTotals(days, 0)).toEqual({ days: 2, gross: 200, costs: 80, net: 120 });
    expect(runTotals([], 1)).toEqual({ days: 0, gross: 0, costs: 0, net: 0 });
  });

  it('shortens a run id', () => {
    expect(shortRunId('0123456789abcdef')).toBe('01234567');
    expect(shortRunId('abc')).toBe('abc');
  });

  it('draws a sparkline that spans the box and includes zero', () => {
    expect(sparkline([], 100, 20)).toEqual({ path: '', zeroY: null });
    const up = sparkline([0, 50, 100], 100, 20);
    expect(up.path).toBe('M0,18 L50,10 L100,2');
    expect(up.zeroY).toBe(18);
    const mixed = sparkline([-100, 100], 100, 22);
    expect(mixed.path).toBe('M0,20 L100,2');
    expect(mixed.zeroY).toBe(11);
    expect(sparkline([5], 100, 20).path).toBe('M0,2 L100,2');
    // A flat zero series must not divide by zero.
    expect(sparkline([0, 0], 100, 20).path).not.toContain('NaN');
  });
});
