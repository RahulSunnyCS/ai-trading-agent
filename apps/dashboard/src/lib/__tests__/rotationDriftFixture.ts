import type {
  DriftDimension,
  DriftMeasure,
  DriftSpan,
  RotationDriftResponse,
} from '../../types/rotationDrift';

const span = (n: number, over: Partial<DriftSpan> = {}): DriftSpan => ({
  from: '2025-12-03',
  to: '2026-10-08',
  n_days: n,
  recorded: 0,
  reconstructed: n,
  ...over,
});

export function indexDimension(over: Partial<DriftDimension> = {}): DriftDimension {
  return {
    key: 'index',
    label: 'Index',
    categories: [
      { key: 'NIFTY', label: 'NIFTY' },
      { key: 'SENSEX', label: 'SENSEX' },
    ],
    counts: { history: [380, 226], last63: [110, 79], last21: [0, 63] },
    shares: { history: [0.63, 0.37], last63: [0.58, 0.42], last21: [0, 1] },
    band: [
      { p10: 0.49, p90: 0.76 },
      { p10: 0.24, p90: 0.51 },
    ],
    flags: [
      { category: 'NIFTY', label: 'NIFTY', direction: 'below', share: 0, p10: 0.49, p90: 0.76 },
      { category: 'SENSEX', label: 'SENSEX', direction: 'above', share: 1, p10: 0.24, p90: 0.51 },
    ],
    ...over,
  };
}

export function kindDimension(): DriftDimension {
  return {
    key: 'kind',
    label: 'Family',
    categories: [
      { key: 'wide', label: 'Widesl' },
      { key: 'dir', label: 'Dir' },
    ],
    counts: { history: [430, 176], last63: [140, 49], last21: [43, 20] },
    shares: { history: [0.71, 0.29], last63: [0.74, 0.26], last21: [0.68, 0.32] },
    band: [
      { p10: 0.67, p90: 0.78 },
      { p10: 0.22, p90: 0.33 },
    ],
    flags: [],
  };
}

export function measure(over: Partial<DriftMeasure> = {}): DriftMeasure {
  return {
    key: 'distinct',
    label: 'Distinct variants picked',
    note: 'How many different variants were picked at all.',
    last21: 49,
    name: null,
    band: { p10: 36, p90: 44 },
    flag: 'above',
    ...over,
  };
}

export function response(over: Partial<RotationDriftResponse> = {}): RotationDriftResponse {
  return {
    list: 'A',
    windows: { history: span(202), last63: span(63), last21: span(21, { to: '2026-10-09' }) },
    rolling_windows: 182,
    short: 21,
    long: 63,
    enough: true,
    band_percentiles: [10, 90],
    dimensions: [kindDimension(), indexDimension()],
    concentration: [
      measure(),
      measure({
        key: 'most_picked',
        label: 'Most-picked variant',
        last21: 3,
        name: 'N_p100_1217',
        band: { p10: 4, p90: 8 },
        flag: 'below',
      }),
      measure({
        key: 'buy',
        label: 'Days a Buy qualified',
        last21: 4,
        band: { p10: 0, p90: 6 },
        flag: null,
      }),
    ],
    flags: 4,
    basis: 'picks',
    in_sample: true,
    history_label: 'P1 · Dec 2025 to Oct 2026',
    ...over,
  };
}
