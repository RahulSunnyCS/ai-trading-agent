import { describe, expect, it } from 'vitest';

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
import { day, response, row, summary } from './rotationLotPlansFixture';

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

  it('says there are no entries yet, not that tracking starts, once 19 Oct has passed', () => {
    const r = response({
      today: '2026-10-21',
      message: "No forward entries yet in this book's journal.",
    });
    expect(emptyState(r)).toEqual({
      title: 'No forward entries yet',
      description: "No forward entries yet in this book's journal.",
    });
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
    const malformed = row({
      note: 'the entry does not hold three core picks with a Widesl',
      plans: { as_picked: day({ lots: [] }), dir_boost: day(), duo: day() },
    });
    expect(legsText(malformed, 'as_picked')).toBe(
      'Not known: the entry does not hold three core picks with a Widesl',
    );
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
      after_readout: {
        days: 3,
        from: '2027-01-14',
        to: '2027-01-18',
        diff_per_day: { dir_boost: 50, duo: -20 },
      },
    });
    expect(lines).toEqual([
      'Read-out on the first 60 scored days, 19 Oct 2026 to 13 Jan 2027:',
      'Dir Boost minus As picked: +₹240 a day, 90% interval +₹30 to +₹450; drawdown per lot -₹2,000 vs -₹2,100: beats As picked.',
      'Duo minus As picked: -₹120 a day, 90% interval -₹400 to +₹150; drawdown per lot -₹3,000 vs -₹2,100: inconclusive.',
      'After the read-out, 3 more days (14 Jan 2027 to 18 Jan 2027), descriptive only: Dir Boost +₹50 a day against As picked, Duo -₹20 a day against As picked.',
    ]);
  });

  it('gives the dates of the scored days before it is read', () => {
    expect(
      readoutLines({ status: 'n/a', days: 2, needed: 60, from: '2026-10-19', to: '2026-10-21' }),
    ).toEqual(['Read-out at 60 forward scored days: 2 so far (19 Oct 2026 to 21 Oct 2026).']);
  });
});
