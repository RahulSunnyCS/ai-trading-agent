import { describe, it, expect } from 'bun:test';
import { tagRegime } from '../regime-tagger';
import type { RegimeInputs } from '../regime-tagger';

function inputs(overrides: Partial<RegimeInputs> = {}): RegimeInputs {
  return {
    indexMovePct:  0.2,
    vix:           14,
    intraSwingPct: 0.8,
    meanReverted:  false,
    isEventDay:    false,
    ...overrides,
  };
}

describe('tagRegime', () => {
  // ── EVENT_DAY (highest priority) ──────────────────────────────────────────

  it('event day flag → EVENT_DAY even if move is large', () => {
    expect(tagRegime(inputs({ isEventDay: true, indexMovePct: 2.5 }))).toBe('EVENT_DAY');
  });

  it('event day flag → EVENT_DAY even if small move', () => {
    expect(tagRegime(inputs({ isEventDay: true, indexMovePct: 0.1 }))).toBe('EVENT_DAY');
  });

  // ── TRENDING_STRONG ────────────────────────────────────────────────────────

  it('index move +1.0% → TRENDING_STRONG', () => {
    expect(tagRegime(inputs({ indexMovePct: 1.0 }))).toBe('TRENDING_STRONG');
  });

  it('index move -1.0% → TRENDING_STRONG', () => {
    expect(tagRegime(inputs({ indexMovePct: -1.0 }))).toBe('TRENDING_STRONG');
  });

  it('index move +1.5% → TRENDING_STRONG', () => {
    expect(tagRegime(inputs({ indexMovePct: 1.5 }))).toBe('TRENDING_STRONG');
  });

  it('big intraday swing NOT mean-reverted → TRENDING_STRONG (not VOLATILE_REVERTING)', () => {
    expect(tagRegime(inputs({ indexMovePct: 1.2, intraSwingPct: 2.0, meanReverted: false }))).toBe('TRENDING_STRONG');
  });

  it('index move 0.99% (just below threshold) → not TRENDING_STRONG', () => {
    const result = tagRegime(inputs({ indexMovePct: 0.99 }));
    expect(result).not.toBe('TRENDING_STRONG');
  });

  // ── VOLATILE_REVERTING ─────────────────────────────────────────────────────

  it('large swing ≥ 1.5% AND mean-reverted → VOLATILE_REVERTING', () => {
    expect(tagRegime(inputs({ intraSwingPct: 1.5, meanReverted: true }))).toBe('VOLATILE_REVERTING');
  });

  it('large swing 2.0% AND mean-reverted → VOLATILE_REVERTING', () => {
    expect(tagRegime(inputs({ intraSwingPct: 2.0, meanReverted: true }))).toBe('VOLATILE_REVERTING');
  });

  it('large swing ≥ 1.5% but NOT mean-reverted → RANGING (not VOLATILE_REVERTING)', () => {
    expect(tagRegime(inputs({ intraSwingPct: 1.5, meanReverted: false }))).toBe('RANGING');
  });

  it('swing 1.4% (below threshold) even if mean-reverted → RANGING', () => {
    expect(tagRegime(inputs({ intraSwingPct: 1.4, meanReverted: true }))).toBe('RANGING');
  });

  // ── RANGING (default) ──────────────────────────────────────────────────────

  it('small move, stable VIX → RANGING', () => {
    expect(tagRegime(inputs())).toBe('RANGING');
  });

  it('zero move → RANGING', () => {
    expect(tagRegime(inputs({ indexMovePct: 0 }))).toBe('RANGING');
  });

  it('move 0.5%, no event, small swing → RANGING', () => {
    expect(tagRegime(inputs({ indexMovePct: 0.5 }))).toBe('RANGING');
  });
});
