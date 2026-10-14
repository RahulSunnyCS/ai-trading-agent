import { describe, expect, it } from 'vitest';

import type { Leg, LegwiseStrategy } from '../../types/legwise';
import { newLeg, newStrategy } from '../legwiseBuilder';
import {
  OFF,
  amountText,
  applyToLegs,
  autoName,
  pairedWith,
  parseAmount,
  parseReentry,
  parseStrike,
  parseTrail,
  readBack,
  reentryText,
  slugId,
  strikeText,
  trailText,
} from '../legwiseGrid';

const leg = (over: Partial<Leg> = {}): Leg => ({
  id: 'ce',
  lots: 1,
  position: 'sell',
  option_type: 'CE',
  expiry: 'weekly',
  strike: { strike_type: 'OTM1' },
  stop_loss: { percent: 115 },
  ...over,
});

// The three live shapes, written out so these tests do not depend on the builder's templates.
const strangle = (): LegwiseStrategy => ({
  ...newStrategy('NIFTY'),
  entry_time: '09:17',
  exit_time: '15:28',
  legs: [
    leg({ id: 'ce', option_type: 'CE', trail_sl: { percent: [15, 10] } }),
    leg({ id: 'pe', option_type: 'PE', trail_sl: { percent: [15, 10] } }),
  ],
  overall: { stop_loss_inr: 2500 },
});
const breakout = (): LegwiseStrategy => {
  const buy = (id: string, type: Leg['option_type']): Leg =>
    leg({
      id,
      option_type: type,
      position: 'buy',
      strike: { closest_premium: 50 },
      stop_loss: { percent: 25 },
      range_breakout: { until: '09:45', side: 'high', source: 'instrument' },
    });
  return {
    ...newStrategy('NIFTY'),
    entry_time: '09:35',
    exit_time: '15:14',
    legs: [buy('ce', 'CE'), buy('pe', 'PE')],
    overall: { stop_loss_inr: 2000 },
  };
};
const premiumStrangle = (): LegwiseStrategy => ({
  ...strangle(),
  legs: strangle().legs.map((l) => ({ ...l, strike: { closest_premium: 65 } })),
});

describe('strike cells', () => {
  it('writes a strike type or a premium', () => {
    expect(strikeText({ strike_type: 'OTM1' })).toBe('OTM1');
    expect(strikeText({})).toBe('ATM');
    expect(strikeText({ closest_premium: 65 })).toBe('₹65');
    expect(strikeText({ closest_premium: 62.5 })).toBe('₹62.5');
  });

  it('reads what a person types', () => {
    expect(parseStrike('atm')).toEqual({ ok: true, value: { strike_type: 'ATM' } });
    expect(parseStrike(' otm 3 ')).toEqual({ ok: true, value: { strike_type: 'OTM3' } });
    expect(parseStrike('ITM10')).toEqual({ ok: true, value: { strike_type: 'ITM10' } });
    for (const t of ['₹65', '65', '65p', 'premium 65', 'Rs.65'])
      expect(parseStrike(t), t).toEqual({ ok: true, value: { closest_premium: 65 } });
  });

  it('refuses what is not a strike', () => {
    for (const t of ['', 'OTM0', 'OTM11', 'ITM', 'abc', '0', '-5'])
      expect(parseStrike(t).ok, t).toBe(false);
  });

  it('round-trips every strike it can write', () => {
    for (const strike of [
      { strike_type: 'ITM2' },
      { strike_type: 'ATM' },
      { closest_premium: 80 },
    ]) {
      expect(parseStrike(strikeText(strike))).toEqual({ ok: true, value: strike });
    }
  });
});

describe('stop, target, trail and re-entry cells', () => {
  it('writes and reads an amount', () => {
    expect(amountText({ percent: 115 })).toBe('115%');
    expect(amountText({ points: 20 })).toBe('20 pts');
    expect(amountText(undefined)).toBe(OFF);
    expect(parseAmount('25%')).toEqual({ ok: true, value: { percent: 25 } });
    expect(parseAmount('20')).toEqual({ ok: true, value: { points: 20 } });
    expect(parseAmount('12.5 pts')).toEqual({ ok: true, value: { points: 12.5 } });
    for (const off of ['', ' ', '—', 'off', 'None'])
      expect(parseAmount(off), off).toEqual({ ok: true, value: undefined });
    for (const bad of ['abc', '0', '0%', '-5', '25 percent'])
      expect(parseAmount(bad).ok, bad).toBe(false);
  });

  it('writes and reads a trail as X/Y, percent or points', () => {
    expect(trailText({ percent: [15, 10] })).toBe('15/10%');
    expect(trailText({ points: [1, 1] })).toBe('1/1 pts');
    expect(trailText(undefined)).toBe(OFF);
    expect(parseTrail('15/10%')).toEqual({ ok: true, value: { percent: [15, 10] } });
    expect(parseTrail('1/1')).toEqual({ ok: true, value: { points: [1, 1] } });
    expect(parseTrail('15 / 10 pts')).toEqual({ ok: true, value: { points: [15, 10] } });
    expect(parseTrail('')).toEqual({ ok: true, value: undefined });
    for (const bad of ['15', '15/', '0/5', '5/0', 'a/b'])
      expect(parseTrail(bad).ok, bad).toBe(false);
  });

  it('writes and reads a re-entry', () => {
    expect(reentryText({ mode: 'asap', count: 2 })).toBe('Now ×2');
    expect(reentryText({ mode: 'cost', count: 1 })).toBe('At cost ×1');
    expect(reentryText(undefined)).toBe(OFF);
    expect(parseReentry('now x2')).toEqual({ ok: true, value: { mode: 'asap', count: 2 } });
    expect(parseReentry('asap')).toEqual({ ok: true, value: { mode: 'asap', count: 1 } });
    expect(parseReentry('at cost ×3')).toEqual({ ok: true, value: { mode: 'cost', count: 3 } });
    expect(parseReentry('')).toEqual({ ok: true, value: undefined });
    for (const bad of ['sometimes', 'now x0', 'now x21'])
      expect(parseReentry(bad).ok, bad).toBe(false);
  });
});

describe('CE + PE pairs', () => {
  const ce = leg({ id: 'ce', option_type: 'CE' });
  const pe = leg({ id: 'pe', option_type: 'PE' });

  it('pairs two legs that match in everything but id and type', () => {
    expect(pairedWith([ce, pe], 0)).toBe(1);
    expect(pairedWith([ce, pe], 1)).toBe(0);
  });

  it('does not pair legs that differ, or that are the same type', () => {
    expect(
      pairedWith([ce, leg({ id: 'pe', option_type: 'PE', stop_loss: { percent: 50 } })], 0),
    ).toBeNull();
    expect(pairedWith([ce, leg({ id: 'ce2', option_type: 'CE' })], 0)).toBeNull();
    expect(pairedWith([ce], 0)).toBeNull();
    expect(pairedWith([ce, pe], 5)).toBeNull();
  });

  it('is not a pair when it would be ambiguous', () => {
    const pe2 = leg({ id: 'pe2', option_type: 'PE' });
    expect(pairedWith([ce, pe, pe2], 0)).toBeNull();
  });

  it('applies an edit to both legs when asked, and to one otherwise', () => {
    const both = applyToLegs([ce, pe], 0, { strike: { strike_type: 'ATM' } }, true);
    expect(both.map((l) => l.strike)).toEqual([{ strike_type: 'ATM' }, { strike_type: 'ATM' }]);
    const one = applyToLegs([ce, pe], 0, { strike: { strike_type: 'ATM' } }, false);
    expect(one.map((l) => l.strike.strike_type)).toEqual(['ATM', 'OTM1']);
    // Unpaired legs are left alone even with "together" on.
    const lone = applyToLegs(
      [ce, leg({ id: 'x', option_type: 'PE', lots: 2 })],
      0,
      { lots: 3 },
      true,
    );
    expect(lone.map((l) => l.lots)).toEqual([3, 2]);
  });

  it('does not mutate the legs it was given', () => {
    const legs = [ce, pe];
    applyToLegs(legs, 0, { lots: 5 }, true);
    expect(legs.map((l) => l.lots)).toEqual([1, 1]);
  });
});

describe('readBack', () => {
  it('tells the short strangle template as one paired sentence and the overall rules', () => {
    const text = readBack(strangle());
    expect(text).toContain('Every trading day, enter at 09:17.');
    expect(text).toContain(
      'Sell 1 lot each of the NIFTY weekly call and put, one strike out of the money.',
    );
    expect(text).toContain('Each leg stops at 115%');
    expect(text).toContain('trails: for every 15% in your favour the stop moves 10%');
    expect(text).toContain('A leg that stops out exits on its own.');
    expect(text).toContain('Everything closes at a ₹2,500 loss, or at 15:28.');
  });

  it('says a range breakout buy and a premium strike in words', () => {
    const text = readBack(breakout());
    expect(text).toContain('Buy 1 lot each');
    expect(text).toContain('with the premium closest to ₹50');
    expect(text).toContain('enters only when the option breaks the high of its range until 09:45');
  });

  it('writes one sentence per leg when the legs are not a pair, and the complete square-off', () => {
    const s: LegwiseStrategy = {
      ...newStrategy('NIFTY'),
      square_off: 'complete',
      no_reentry_after: '13:00',
      legs: [
        leg({ id: 'a', option_type: 'CE', strike: { strike_type: 'OTM2' }, lots: 2 }),
        leg({
          id: 'b',
          position: 'buy',
          option_type: 'CE',
          strike: { strike_type: 'OTM5' },
          stop_loss: undefined,
        }),
      ],
      overall: { stop_loss_inr: 3000, target_inr: 5000 },
    };
    const text = readBack(s);
    expect(text).toContain('Sell 2 lots of the NIFTY weekly call, 2 strikes out of the money.');
    expect(text).toContain('Buy 1 lot of the NIFTY weekly call, 5 strikes out of the money.');
    expect(text).toContain('No new entry after 13:00.');
    expect(text).toContain('When one leg stops out, every leg exits.');
    expect(text).toContain('Everything closes at a ₹3,000 loss or a ₹5,000 profit, or at 15:15.');
  });

  it('says what happens at the exit time when there is no overall rule', () => {
    expect(readBack({ ...newStrategy('NIFTY'), overall: {} })).toContain(
      'Anything still open closes at 15:15.',
    );
  });
});

describe('names', () => {
  it('names a strategy from what it does', () => {
    expect(autoName(strangle())).toBe('Short strangle OTM1 · 09:17');
    expect(autoName(newStrategy('NIFTY'))).toBe('Short straddle · 09:20');
    expect(autoName(breakout())).toBe('Buy range breakout ₹50 · 09:35');
    expect(autoName(premiumStrangle())).toBe('Short strangle ₹65 · 09:17');
    expect(autoName({ ...newStrategy('NIFTY'), legs: [] })).toBe('Custom · 09:20');
    const mixed = {
      ...newStrategy('NIFTY'),
      legs: [newLeg('a', 'CE'), { ...newLeg('b', 'PE'), strike: { strike_type: 'OTM2' } }],
    };
    expect(autoName(mixed)).toBe('Custom · 09:20');
  });

  it('makes a file-safe id led by the index', () => {
    expect(slugId('Short strangle OTM1 · 09:17', 'NIFTY')).toBe('nifty_short_strangle_otm1_09_17');
    expect(slugId('nifty_widesl_917', 'NIFTY')).toBe('nifty_widesl_917');
    expect(slugId('Buy range ₹50', 'SENSEX')).toBe('sensex_buy_range_50');
    expect(slugId('', 'BANKNIFTY')).toBe('banknifty');
    const long = slugId('x'.repeat(100), 'NIFTY');
    expect(long.length).toBeLessThanOrEqual(64);
    expect(/^[a-z0-9_]{1,64}$/.test(long)).toBe(true);
  });
});
