import type {
  LiveDay,
  LiveGroup,
  LiveRunning,
  LiveShape,
  RotationLiveResponse,
} from '../../types/rotationLive';

export function group(over: Partial<LiveGroup> = {}): LiveGroup {
  return {
    platform: 'algotest',
    broker: 'finvasia',
    book: 't1',
    live: 900,
    paper: 1000,
    slippage: -100,
    slippage_pct: -0.4,
    variants: 3,
    ...over,
  };
}

export function day(over: Partial<LiveDay> = {}): LiveDay {
  return {
    day: '2026-10-21',
    captured: true,
    failed_sections: [],
    groups: [group()],
    compared: [],
    no_paper: [],
    off_slot: [],
    open_legs: [],
    not_traded: [],
    unrecognised: [],
    discretionary_count: 0,
    discretionary_total: 0,
    ...over,
  };
}

export function running(over: Partial<LiveRunning> = {}): LiveRunning {
  return {
    platform: 'algotest',
    broker: 'finvasia',
    book: 't1',
    live: 900,
    paper: 1000,
    slippage: -100,
    days: 1,
    points: [{ day: '2026-10-21', live: 900, paper: 1000, slippage: -100 }],
    ...over,
  };
}

export function shape(over: Partial<LiveShape> = {}): LiveShape {
  return {
    platform: 'algotest',
    position: 'sell',
    band: '09:30–12:00',
    variant_days: 2,
    slippage: -112,
    mean_slippage: -56,
    slippage_pct: -0.42,
    ...over,
  };
}

export function response(over: Partial<RotationLiveResponse> = {}): RotationLiveResponse {
  return {
    from: '2026-10-21',
    to: '2026-10-21',
    captured_days: ['2026-10-21'],
    days: [day()],
    running: [running()],
    shapes: [shape()],
    discretionary: { total: 0, points: [{ day: '2026-10-21', value: 0 }] },
    ...over,
  };
}
