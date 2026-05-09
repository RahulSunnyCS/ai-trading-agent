import { mock, describe, it, expect, beforeEach } from 'bun:test';

mock.module('../../db/client', () => ({
  query: mock(() => Promise.resolve([{ id: 'test-signal-id' }])),
}));

mock.module('../../redis/client', () => ({
  streamRead:    mock(() => Promise.resolve([])),
  streamPublish: mock(() => Promise.resolve('1-0')),
  STREAMS: {
    STRADDLE_VALUES:   'straddle.values',
    SIGNALS_GENERATED: 'signals.generated',
  },
}));

// Import AFTER mocks are set up
const { checkExhaustionConditions, calcSignalProbability, resetSignalState } =
  await import('../signal-detector');

// ── helpers ────────────────────────────────────────────────────────────────────

type WinEntry = { straddleValue: number; roc: number | null; acceleration: number | null; vix: number | null };

function makeWindow(entries: WinEntry[], openStraddle: number, firedToday = false) {
  return {
    openStraddle,
    firedToday,
    entries: entries.map((e) => ({ time: new Date(), ...e })),
  };
}

// A window that satisfies ALL conditions by default
function passingWindow() {
  return makeWindow([
    { straddleValue: 290, roc: 0.05, acceleration: null, vix: 14 },
    { straddleValue: 310, roc: 0.04, acceleration: null, vix: 14 },
    { straddleValue: 330, roc: 0.03, acceleration: -0.8,  vix: 14 },
  ], 300);  // open=300, latest=330 → expansion 10%
}

// ── checkExhaustionConditions ──────────────────────────────────────────────────

describe('checkExhaustionConditions', () => {
  beforeEach(() => resetSignalState());

  it('all conditions met → triggered', () => {
    const result = checkExhaustionConditions(passingWindow());
    expect(result.triggered).toBe(true);
  });

  it('firedToday = true → not triggered (no double signal)', () => {
    const win = { ...passingWindow(), firedToday: true };
    expect(checkExhaustionConditions(win).triggered).toBe(false);
  });

  it('expansion below 10% → not triggered', () => {
    // open=300, latest=308 → 2.7%
    const win = makeWindow([
      { straddleValue: 300, roc: 0.04, acceleration: null, vix: 14 },
      { straddleValue: 304, roc: 0.03, acceleration: null, vix: 14 },
      { straddleValue: 308, roc: 0.02, acceleration: -0.8,  vix: 14 },
    ], 300);
    const result = checkExhaustionConditions(win);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('expansion_below_threshold');
  });

  it('acceleration not negative enough → not triggered', () => {
    const win = makeWindow([
      { straddleValue: 290, roc: 0.05, acceleration: null, vix: 14 },
      { straddleValue: 310, roc: 0.04, acceleration: null, vix: 14 },
      { straddleValue: 330, roc: 0.03, acceleration: -0.3,  vix: 14 }, // -0.3 > -0.5 threshold
    ], 300);
    expect(checkExhaustionConditions(win).triggered).toBe(false);
  });

  it('ROC not consistently declining → not triggered', () => {
    const win = makeWindow([
      { straddleValue: 290, roc: 0.02, acceleration: null, vix: 14 },
      { straddleValue: 310, roc: 0.05, acceleration: null, vix: 14 }, // ROC went UP
      { straddleValue: 330, roc: 0.03, acceleration: -0.8,  vix: 14 },
    ], 300);
    expect(checkExhaustionConditions(win).triggered).toBe(false);
  });

  it('insufficient data (fewer entries than rocDeclineWindow+1) → not triggered', () => {
    const win = makeWindow([
      { straddleValue: 330, roc: 0.03, acceleration: -0.8, vix: 14 },
    ], 300);
    expect(checkExhaustionConditions(win).triggered).toBe(false);
  });

  it('expansionPct is calculated and returned', () => {
    // open=200, latest=240 → 20%
    const win = makeWindow([
      { straddleValue: 230, roc: 0.05, acceleration: null, vix: 14 },
      { straddleValue: 235, roc: 0.04, acceleration: null, vix: 14 },
      { straddleValue: 240, roc: 0.02, acceleration: -0.8,  vix: 14 },
    ], 200);
    const result = checkExhaustionConditions(win);
    expect(result.triggered).toBe(true);
    expect(result.expansionPct).toBeCloseTo(20);
  });

  it('custom config overrides defaults', () => {
    // Use lower minExpansionPct so a small expansion triggers
    const win = makeWindow([
      { straddleValue: 290, roc: 0.05, acceleration: null, vix: 14 },
      { straddleValue: 295, roc: 0.04, acceleration: null, vix: 14 },
      { straddleValue: 303, roc: 0.03, acceleration: -0.8,  vix: 14 },
    ], 300);  // expansion only 1% — below default 10%
    expect(checkExhaustionConditions(win, { minExpansionPct: 0.5, accelerationThreshold: -0.5, rocDeclineWindow: 2, windowSize: 8 }).triggered).toBe(true);
  });
});

// ── calcSignalProbability ──────────────────────────────────────────────────────

describe('calcSignalProbability', () => {
  // Wed May 7 2025 09:30 IST = 04:00 UTC
  const sweetSpotTime = new Date(2025, 4, 7, 4, 0, 0, 0); // 09:30 IST
  // Wed May 7 2025 11:00 IST = 05:30 UTC
  const midMorning    = new Date(2025, 4, 7, 5, 30, 0, 0);
  // Mon May 5 2025 11:00 IST
  const monday        = new Date(2025, 4, 5, 5, 30, 0, 0);
  // Fri May 9 2025 11:00 IST
  const friday        = new Date(2025, 4, 9, 5, 30, 0, 0);

  it('high VIX (>20) reduces probability vs normal VIX', () => {
    const pNormal = calcSignalProbability(12, 14, midMorning);
    const pHighVix = calcSignalProbability(12, 25, midMorning);
    expect(pHighVix).toBeLessThan(pNormal);
  });

  it('low VIX (<12) increases probability', () => {
    const pNormal = calcSignalProbability(12, 14, midMorning);
    const pLowVix  = calcSignalProbability(12, 11, midMorning);
    expect(pLowVix).toBeGreaterThan(pNormal);
  });

  it('9:20-9:45 IST sweet spot has higher probability', () => {
    const pSweet = calcSignalProbability(12, 14, sweetSpotTime);
    const pMid   = calcSignalProbability(12, 14, midMorning);
    expect(pSweet).toBeGreaterThan(pMid);
  });

  it('Monday reduces probability', () => {
    const pWed = calcSignalProbability(12, 14, midMorning);
    const pMon = calcSignalProbability(12, 14, monday);
    expect(pMon).toBeLessThan(pWed);
  });

  it('Friday reduces probability', () => {
    const pWed = calcSignalProbability(12, 14, midMorning);
    const pFri = calcSignalProbability(12, 14, friday);
    expect(pFri).toBeLessThan(pWed);
  });

  it('result is always clamped between 0 and 1', () => {
    // Extremely adverse conditions
    const p = calcSignalProbability(5, 30, friday);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it('null VIX does not throw', () => {
    expect(() => calcSignalProbability(12, null as unknown as number, midMorning)).not.toThrow();
  });
});
