import type {
  DrawdownEpisode,
  DrawdownPoint,
  RotationDrawdownsResponse,
} from '../../types/rotationDrawdowns';

export function point(
  day: string,
  underwater: number,
  over: Partial<DrawdownPoint> = {},
): DrawdownPoint {
  return {
    day,
    source: 'reconstructed',
    per_lot: 0,
    cum: 0,
    underwater,
    base_per_lot: 0,
    base_underwater: 0,
    ...over,
  };
}

export function episode(over: Partial<DrawdownEpisode> = {}): DrawdownEpisode {
  return {
    n: 1,
    peak_day: '2026-03-02',
    trough_day: '2026-03-05',
    end_day: '2026-03-09',
    open: false,
    depth: -1500,
    depth_basket: -9000,
    sessions_down: 3,
    sessions_back: 2,
    base_change: -400,
    base_missing: 0,
    stops: 4,
    drivers: [
      { kind: 'wide', band: 'A', label: 'Widesl · 09:17–10:02', total: -1800, pick_days: 9 },
      { kind: 'dir', band: 'B', label: 'Dir · 10:17–12:02', total: 300, pick_days: 6 },
    ],
    ...over,
  };
}

export function response(over: Partial<RotationDrawdownsResponse> = {}): RotationDrawdownsResponse {
  const series = [
    point('2026-03-02', 0),
    point('2026-03-03', -600, { base_underwater: -200 }),
    point('2026-03-04', -1100, { base_underwater: null, base_per_lot: null }),
    point('2026-03-05', -1500, { base_underwater: -400 }),
    point('2026-03-06', -700, { base_underwater: -100 }),
    point('2026-03-09', 0),
  ];
  return {
    list: 'A',
    window: { id: 'P1', label: 'P1 · Dec 2025 to Oct 2026', from: '2026-03-02', to: '2026-03-09' },
    min_depth: 500,
    n_days: 6,
    recorded_days: 0,
    reconstructed_days: 6,
    left_out: { late: 0, waiting: 0, no_entry: 0 },
    lots: [6, 8],
    base_lots: 6,
    series,
    episodes: [episode()],
    all_episodes: 3,
    max_dd: -1500,
    base_max_dd: -3000,
    base_days: 5,
    current: null,
    basis: 'gross',
    unit: 'per_lot',
    in_sample: true,
    ...over,
  };
}
