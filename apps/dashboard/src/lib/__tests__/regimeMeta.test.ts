import { describe, expect, it } from 'vitest';

import {
  REGIME_KEYS,
  REGIME_META,
  SEGMENT_REGIMES,
  TRADING_REGIMES,
  isKnownRegime,
  normaliseRegimeKey,
  regimeBadge,
  regimeMeta,
} from '../regimeMeta';

const TONES = ['positive', 'negative', 'warning', 'info', 'accent', 'neutral', 'primary'];

describe('REGIME_META', () => {
  it('covers every key used by Options Lab, the live tagger and the YAML backtest buckets', () => {
    for (const key of [
      'QUIET',
      'CHOP',
      'TREND_UP',
      'TREND_DOWN',
      'UNKNOWN',
      'RANGING',
      'TRENDING_STRONG',
      'VOLATILE_REVERTING',
      'EVENT_DAY',
      'UNCLASSIFIED',
    ]) {
      expect(isKnownRegime(key), key).toBe(true);
    }
    expect([...SEGMENT_REGIMES, ...TRADING_REGIMES].every((k) => REGIME_KEYS.includes(k))).toBe(
      true,
    );
  });

  it('gives every entry a label, a valid badge tone, a one-character glyph and a definition', () => {
    for (const key of REGIME_KEYS) {
      const meta = REGIME_META[key];
      expect(meta.key).toBe(key);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(TONES).toContain(meta.tone);
      expect([...meta.glyph]).toHaveLength(1);
      expect(meta.definition.length).toBeGreaterThan(20);
    }
  });

  it('keeps green and red for direction only', () => {
    const coloured = REGIME_KEYS.filter((k) =>
      ['positive', 'negative'].includes(REGIME_META[k].tone),
    );
    expect(coloured.sort()).toEqual(['TREND_DOWN', 'TREND_UP']);
  });

  it('tells the two directions apart without colour', () => {
    expect(REGIME_META.TREND_UP.glyph).not.toBe(REGIME_META.TREND_DOWN.glyph);
    expect(REGIME_META.TREND_UP.label).not.toBe(REGIME_META.TREND_DOWN.label);
  });

  it('has unique labels, so two keys never render the same badge text', () => {
    const labels = REGIME_KEYS.map((k) => REGIME_META[k].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('regimeMeta', () => {
  it('accepts any casing and separator', () => {
    expect(normaliseRegimeKey(' trending-strong ')).toBe('TRENDING_STRONG');
    expect(regimeMeta('trend_up')).toBe(REGIME_META.TREND_UP);
    expect(regimeMeta('Volatile Reverting')).toBe(REGIME_META.VOLATILE_REVERTING);
  });

  it('renders an unknown key as a neutral, humanised badge instead of throwing', () => {
    const meta = regimeMeta('SQUEEZE_DAY');
    expect(meta).toMatchObject({
      key: 'SQUEEZE_DAY',
      label: 'Squeeze day',
      tone: 'neutral',
    });
    expect(isKnownRegime('SQUEEZE_DAY')).toBe(false);
  });

  it('does not treat inherited object keys as regimes', () => {
    expect(isKnownRegime('constructor')).toBe(false);
    expect(regimeMeta('toString').tone).toBe('neutral');
  });

  it('reads a missing key as "Not tagged"', () => {
    expect(regimeMeta(null).label).toBe('Not tagged');
    expect(regimeMeta(undefined).label).toBe('Not tagged');
    expect(regimeMeta('  ').label).toBe('Not tagged');
  });
});

describe('regimeBadge', () => {
  it('returns the tone, the glyph-prefixed text and the definition as the title', () => {
    expect(regimeBadge('TREND_DOWN')).toEqual({
      tone: 'negative',
      label: 'Trend down',
      glyph: '↓',
      text: '↓ Trend down',
      title: REGIME_META.TREND_DOWN.definition,
    });
  });

  it('is the same for the same key however it is spelled', () => {
    expect(regimeBadge('event_day')).toEqual(regimeBadge('EVENT_DAY'));
  });
});
