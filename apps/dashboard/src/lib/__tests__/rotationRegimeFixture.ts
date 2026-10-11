import type {
  RegimeMix,
  RegimePeriod,
  RegimeRowKey,
  RotationRegimeResponse,
} from '../../types/rotationRegime';

const VIX = ['<10.5', '10.5-11.5', '11.5-13', '13-15', '15-18', '18+', 'unknown'];
const DTE = ['0', '1', '2', '3', '4+', 'unknown'];
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function mix(categories: string[], counts: number[]): RegimeMix {
  return { categories, counts, n: counts.reduce((s, c) => s + c, 0) };
}

export function period(
  id: RegimePeriod['id'],
  over: Partial<RegimePeriod> = {},
  m: Partial<Record<RegimeRowKey, number[]>> = {},
): RegimePeriod {
  return {
    id,
    label: id,
    status: 'ok',
    reason: null,
    from: '2025-12-03',
    to: '2026-10-08',
    n: 200,
    mix: {
      vix_band: mix(VIX, m.vix_band ?? [20, 28, 42, 44, 24, 42, 0]),
      dte_n: mix(DTE, m.dte_n ?? [42, 38, 0, 2, 118, 0]),
      dte_s: mix(DTE, m.dte_s ?? [42, 42, 40, 36, 40, 0]),
      weekday: mix(WD, m.weekday ?? [40, 40, 42, 38, 40]),
    },
    vix_open: { n: 200, p10: 10.6, p50: 13.3, p90: 19.7 },
    range: {
      NIFTY: { n: 200, p10: 0.47, p50: 0.84, p90: 1.63 },
      SENSEX: { n: 200, p10: 0.5, p50: 0.86, p90: 1.69 },
    },
    ...over,
  };
}

export function response(over: Partial<RotationRegimeResponse> = {}): RotationRegimeResponse {
  const p1 = period('P1');
  const p2 = period(
    'P2',
    { n: 157, from: '2025-01-10', to: '2025-08-29' },
    {
      vix_band: [0, 11, 36, 50, 41, 19, 0],
      dte_n: [33, 31, 33, 28, 32, 0],
      dte_s: [33, 31, 0, 1, 92, 0],
    },
  );
  const p3 = period('P3', {
    status: 'unavailable',
    reason: 'not in the rotation store',
    n: 0,
    mix: null,
    vix_open: null,
    range: null,
    from: '2022-04-05',
    to: '2024-10-08',
  });
  const fwd = period(
    'forward',
    { n: 18, from: '2026-10-12', to: '2026-11-05' },
    { vix_band: [0, 0, 3, 9, 5, 1, 0], dte_n: [4, 4, 0, 0, 10, 0], dte_s: [4, 4, 3, 3, 4, 0] },
  );
  return {
    periods: [p1, p2, p3, fwd],
    rows: [
      { key: 'vix_band', label: 'Opening VIX band', categories: VIX },
      { key: 'dte_n', label: 'NIFTY days to expiry', categories: DTE },
      { key: 'dte_s', label: 'SENSEX days to expiry', categories: DTE },
      { key: 'weekday', label: 'Weekday', categories: WD },
    ],
    distances: {
      rows: [
        { key: 'vix_band', label: 'Opening VIX band', to: { P1: 0.44, P2: 0.2 }, closer: 'P2' },
        { key: 'dte_n', label: 'NIFTY days to expiry', to: { P1: 0.04, P2: 0.39 }, closer: 'P1' },
        { key: 'dte_s', label: 'SENSEX days to expiry', to: { P1: 0.04, P2: 0.36 }, closer: 'P1' },
        { key: 'weekday', label: 'Weekday', to: { P1: 0.06, P2: 0.06 }, closer: 'neither' },
      ],
      overall: { P1: 0.145, P2: 0.25 },
      closer: 'P1',
      tie: 0.05,
    },
    forward_days: 18,
    thin_days: 20,
    thin: true,
    range_definition: '(high − low) ÷ open × 100 over the session’s 1-minute index bars',
    basis: 'sessions',
    ...over,
  };
}
