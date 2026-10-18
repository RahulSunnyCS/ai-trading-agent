import { describe, expect, it } from 'vitest';

import type {
  LotPlanDay,
  LotPlanRow,
  LotPlanSummary,
  RotationLotPlansResponse,
} from '../../types/rotationLotPlans';
import {
  PLAN_ORDER,
  chartLines,
  countsText,
  dayNetText,
  emptyState,
  expiryTag,
  legsText,
  lotsText,
  orderedPlans,
  perDayVsComparator,
  readoutLines,
} from '../rotationLotPlansView';

function summary(over: Partial<LotPlanSummary> & Pick<LotPlanSummary, 'plan'>): LotPlanSummary {
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

function response(over: Partial<RotationLotPlansResponse> = {}): RotationLotPlansResponse {
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

function day(over: Partial<LotPlanDay> = {}): LotPlanDay {
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

function row(over: Partial<LotPlanRow> = {}): LotPlanRow {
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

describe('before the first forward day', () => {
  it('says tracking starts on Monday and draws no chart', () => {
    const r = response();
    expect(emptyState(r)).toEqual({
      title: 'Tracking starts Mon 19 Oct',
      description:
        "The first forward entry is recorded at 09:16 on 19 Oct 2026; its figures appear once that evening's results are stored.",
    });
    expect(chartLines(r)).toEqual([]);
    expect(countsText(r)).toBe('No forward entry yet');
    expect(readoutLines(r.readout)).toEqual(['Read-out at 60 forward scored days: 0 so far.']);
  });

  it('says nothing is scored yet once entries exist but wait for results', () => {
    const r = response({
      rows: [row({ status: 'waiting' })],
      counts: { scored: 0, waiting: 1, late: 0, unverified: 0, entries: 1 },
      message: 'No forward day scored yet: 1 recorded, 1 waiting for results.',
    });
    expect(emptyState(r)?.title).toBe('No forward day scored yet');
    expect(countsText(r)).toBe('1 waiting');
  });
});

describe('plans', () => {
  it('orders the plans with the comparator first', () => {
    expect(orderedPlans(response()).map((p) => p.plan)).toEqual([...PLAN_ORDER]);
  });

  it('gives each plan its net per day against As picked, never for the comparator', () => {
    const r = response({
      plans: [
        summary({ plan: 'as_picked', net_per_day: 1000, days: 3 }),
        summary({ plan: 'dir_boost', net_per_day: 1250, days: 3 }),
        summary({ plan: 'duo', net_per_day: null }),
      ],
    });
    const [ref, boost, duo] = orderedPlans(r);
    expect(ref && perDayVsComparator(r, ref)).toBeNull();
    expect(boost && perDayVsComparator(r, boost)).toBe(250);
    expect(duo && perDayVsComparator(r, duo)).toBeNull();
  });

  it('draws one cumulative line per plan once a day is scored', () => {
    const r = response({
      counts: { scored: 2, waiting: 0, late: 0, unverified: 0, entries: 2 },
      cumulative: [
        { day: '2026-10-19', as_picked: 100, dir_boost: 150, duo: 90 },
        { day: '2026-10-20', as_picked: 300, dir_boost: 380, duo: 200 },
      ],
    });
    expect(emptyState(r)).toBeNull();
    const lines = chartLines(r);
    expect(lines.map((l) => l.id)).toEqual(['As picked', 'Dir Boost', 'Duo']);
    expect(lines[1]?.points).toEqual([
      { time: '2026-10-19', value: 150 },
      { time: '2026-10-20', value: 380 },
    ]);
  });
});

describe('daily rows', () => {
  it('names the expiring index', () => {
    expect(expiryTag(row())).toBeNull();
    expect(expiryTag(row({ expiry: true, dte: { NIFTY: '0', SENSEX: '3' } }))).toBe('NIFTY expiry');
    expect(expiryTag(row({ expiry: true, dte: { NIFTY: '2', SENSEX: '0' } }))).toBe(
      'SENSEX expiry',
    );
    expect(expiryTag(row({ expiry: true, dte: { NIFTY: '0', SENSEX: '0' } }))).toBe('Both expire');
  });

  it('never shows a missing figure as zero', () => {
    const r = row({
      status: 'waiting',
      plans: {
        as_picked: day({ status: 'waiting', net: null, gross: null, brokerage: null }),
        dir_boost: day({ status: 'unverified', net: null, total_lots: null }),
        duo: day({ net: 0 }),
      },
    });
    expect(dayNetText(r, 'as_picked')).toBe('waiting');
    expect(dayNetText(r, 'dir_boost')).toBe('—');
    expect(dayNetText(r, 'duo')).toBe('₹0');
    expect(lotsText(null)).toBe('—');
    expect(lotsText(1)).toBe('1 lot');
    expect(lotsText(4)).toBe('4 lots');
  });

  it('lists what a plan places, marking the added Dir', () => {
    const r = row({
      plans: {
        as_picked: day(),
        dir_boost: day(),
        duo: day({
          lots: [
            { name: 'N_wide_0917', lots: 2, gross: 500, n_trades: 2, runner_up: false },
            { name: 'S_dir_0917', lots: 2, gross: -200, n_trades: 1, runner_up: true },
          ],
        }),
      },
    });
    expect(legsText(r, 'duo')).toBe('N_wide_0917 ×2 · S_dir_0917 ×2 (best unpicked Dir)');
    expect(legsText(r, 'as_picked')).toBe('Not known: the best unpicked Dir could not be verified');
  });

  it('counts each status, leaving out zeros', () => {
    const r = response({ counts: { scored: 3, waiting: 1, late: 1, unverified: 0, entries: 5 } });
    expect(countsText(r)).toBe('3 scored · 1 waiting · 1 late');
  });
});

describe('the read-out', () => {
  it('words each plan against As picked once judged', () => {
    const lines = readoutLines({
      status: 'judged',
      days: 60,
      judged_days: 60,
      from: '2026-10-19',
      to: '2027-01-13',
      plans: {
        dir_boost: {
          name: 'Dir Boost',
          diff_per_day: 240,
          lo90: 30,
          hi90: 450,
          dd_per_lot: -2000,
          comparator_dd_per_lot: -2100,
          verdict: 'beats',
        },
        duo: {
          name: 'Duo',
          diff_per_day: -120,
          lo90: -400,
          hi90: 150,
          dd_per_lot: -3000,
          comparator_dd_per_lot: -2100,
          verdict: 'inconclusive',
        },
      },
    });
    expect(lines).toEqual([
      'Dir Boost minus As picked: +₹240 a day, 90% interval +₹30 to +₹450; drawdown per lot -₹2,000 vs -₹2,100: beats As picked.',
      'Duo minus As picked: -₹120 a day, 90% interval -₹400 to +₹150; drawdown per lot -₹3,000 vs -₹2,100: inconclusive.',
    ]);
  });
});
