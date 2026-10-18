/** Fixtures for the Lot plans card's tests (BL-135): a response, a summary, a row, a day. */

import type {
  LotPlanDay,
  LotPlanRow,
  LotPlanSummary,
  RotationLotPlansResponse,
} from '../../types/rotationLotPlans';

export function summary(
  over: Partial<LotPlanSummary> & Pick<LotPlanSummary, 'plan'>,
): LotPlanSummary {
  return {
    name: over.plan,
    days: 0,
    lot_days: 0,
    mean_lots: null,
    gross: 0,
    brokerage: 0,
    net: 0,
    gross_per_day: null,
    brokerage_per_day: null,
    net_per_day: null,
    max_drawdown: null,
    worst_day: null,
    lots_today: null,
    ...over,
  };
}

export function response(over: Partial<RotationLotPlansResponse> = {}): RotationLotPlansResponse {
  return {
    book: 'core',
    list: 'C',
    forward_from: '2026-10-19',
    today: '2026-10-18',
    plans: [
      summary({ plan: 'duo' }),
      summary({ plan: 'as_picked' }),
      summary({ plan: 'dir_boost' }),
    ],
    comparator: 'as_picked',
    counts: { scored: 0, waiting: 0, late: 0, unverified: 0, entries: 0 },
    cumulative: [],
    rows: [],
    readout: { status: 'n/a', days: 0, needed: 60 },
    chain: { intact: true, problems: [] },
    message: 'Tracking starts Mon 19 Oct 2026: no forward day has been recorded yet.',
    ...over,
  };
}

export function day(over: Partial<LotPlanDay> = {}): LotPlanDay {
  return {
    lots: [],
    total_lots: 3,
    status: 'scored',
    gross: 1000,
    brokerage: 200,
    net: 800,
    ...over,
  };
}

export function row(over: Partial<LotPlanRow> = {}): LotPlanRow {
  return {
    day: '2026-10-22',
    book: 'core',
    weekday: 'Thu',
    expiry: false,
    dte: { NIFTY: '1', SENSEX: '2' },
    expiry_only: null,
    recorded_at: '2026-10-22T09:16:04+05:30',
    status: 'scored',
    note: null,
    picks: [],
    runner_up_dir: null,
    plans: { as_picked: day(), dir_boost: day({ total_lots: 4 }), duo: day({ total_lots: 4 }) },
    ...over,
  };
}
