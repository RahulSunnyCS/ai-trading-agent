import { describe, expect, it } from 'vitest';

import type {
  RotationShadowResponse,
  ShadowDayRow,
  ShadowListSummary,
  ShadowSeriesPoint,
  ShadowTriggerRow,
} from '../../types/rotationShadow';
import {
  THIN_DAYS,
  bannerText,
  chartModel,
  chartTooltip,
  dayCells,
  detailLabel,
  emptyState,
  nearestPoint,
  niceTicks,
  overrideEmpty,
  researchCells,
  researchRows,
  statusSummary,
  triggerCells,
} from '../rotationShadowView';

const RESEARCH_OVERRIDE = [
  ['explore', 'A', 19981, 30383, 14562, false],
  ['explore', 'B', 79389, 45514, 9604, true],
  ['explore', 'C', 21494, 39352, 19822, false],
  ['explore', 'REF', 54556, 27457, 23301, true],
  ['confirm', 'A', -10473, 18416, 7124, false],
  ['confirm', 'B', -26749, 14340, 10848, false],
  ['confirm', 'C', -9972, 20366, 9425, false],
  ['confirm', 'REF', 16268, 43828, 15424, false],
] as const;

function listSummary(key: ShadowListSummary['list'], over: Partial<ShadowListSummary> = {}) {
  return {
    list: key,
    candidate: key === 'B' || key === 'REF',
    description: '',
    forward_days: 0,
    event_days: 0,
    scored: 0,
    pending: 0,
    not_applied: 0,
    late_entry: 0,
    no_entry: 0,
    total_basket: null,
    mean_lot: null,
    beat_share: null,
    control_days: 0,
    control_total_basket: null,
    series: [],
    ...over,
  } satisfies ShadowListSummary;
}

function triggerRow(over: Partial<ShadowTriggerRow> = {}): ShadowTriggerRow {
  return {
    trigger: 'T1',
    template: 'dir',
    label: 'Pivot cross with trend',
    template_label: 'Dir',
    candidate: true,
    events_seen: 0,
    days_seen: 0,
    events: 0,
    days: 0,
    event_avg: null,
    placebo_avg: null,
    diff: null,
    t: null,
    thin: true,
    unscored_events: 0,
    research: { explore: 754, explore_t: 3.5, confirm: -20, confirm_t: -0.1 },
    ...over,
  };
}

function response(over: Partial<RotationShadowResponse> = {}): RotationShadowResponse {
  return {
    forward_from: '2026-10-12',
    research_end: '2026-10-08',
    window: { from: '2026-10-12', to: null },
    banner: {
      sessions: 0,
      with_event: 0,
      judged_at: 60,
      remaining: 60,
      first_day: null,
      last_day: null,
    },
    files: { events: false, sims: false, scored_days: false, journal: false },
    journal: {
      exists: false,
      entries: 0,
      forward: 0,
      late: 0,
      chain_intact: null,
      error: null,
    },
    triggers: [],
    trigger_info: [],
    override: {
      rule: {
        triggers: ['T1', 'T4'],
        template: 'dir',
        candidate_lists: ['B', 'REF'],
        min_lead_minutes: 15,
        min_widesl: 2,
        lots_per_strategy: 2,
        basis: 'gross',
      },
      lists: (['A', 'B', 'C', 'REF'] as const).map((k) => listSummary(k)),
      days: [],
      controls: {
        random_time: { status: 'not_recorded', reason: 'not recorded' },
        placebo: { status: 'recorded', reason: 'placebo', min_days: 10 },
      },
    },
    research: {
      periods: { explore: '2024-10-09 to 2026-10-08', confirm: 'NIFTY 2022-01-03 to 2024-10-08' },
      override: RESEARCH_OVERRIDE.map(([period, list, gain, rt, rd, above]) => ({
        period,
        list,
        plain: 0,
        override: 0,
        gain,
        dd: 0,
        dd_plain: 0,
        random_time_p90: rt,
        random_day_p90: rd,
        above_controls: above,
      })),
      applied: '',
      note: '',
    },
    candidates: [],
    ...over,
  };
}

describe('bannerText', () => {
  it('is the sentence the owner specified', () => {
    expect(
      bannerText({
        sessions: 12,
        with_event: 5,
        judged_at: 60,
        remaining: 48,
        first_day: null,
        last_day: null,
      }),
    ).toBe(
      '12 forward sessions, 5 with a trigger event, judged at 60 sessions, nothing here changes a list',
    );
  });

  it('says session in the singular', () => {
    const text = bannerText({
      sessions: 1,
      with_event: 0,
      judged_at: 60,
      remaining: 59,
      first_day: null,
      last_day: null,
    });
    expect(text.startsWith('1 forward session, 0 with a trigger event')).toBe(true);
  });
});

describe('emptyState', () => {
  it('says what will appear and when before the first forward session', () => {
    const e = emptyState(response());
    expect(e?.title).toBe('No forward session has been scored yet');
    expect(e?.description).toContain('19:45 update');
    expect(e?.description).toContain('12 Oct 2026');
    expect(e?.description).toContain('journal entry');
  });

  it('says no trigger has fired once sessions exist without an event', () => {
    const r = response({
      banner: {
        sessions: 3,
        with_event: 0,
        judged_at: 60,
        remaining: 57,
        first_day: null,
        last_day: null,
      },
    });
    expect(emptyState(r)?.title).toBe('No trigger has fired in 3 forward sessions');
  });

  it('is null once a session had an event', () => {
    const r = response({
      banner: {
        sessions: 3,
        with_event: 1,
        judged_at: 60,
        remaining: 57,
        first_day: null,
        last_day: null,
      },
    });
    expect(emptyState(r)).toBeNull();
  });

  it('separates "no event day" from "events waiting for results" in the override panel', () => {
    expect(overrideEmpty(0, 0, 0).description).toContain('no forward entry');
    expect(overrideEmpty(4, 0, 4).description).toContain('pivot-cross (T1) or RSI-exhaustion (T4)');
    expect(overrideEmpty(4, 2, 4).title).toBe('No day has a result yet');
    expect(overrideEmpty(4, 2, 4).description).toContain('not zero');
  });
});

describe('triggerCells', () => {
  it('shows no t and flags the row below five event days', () => {
    expect(THIN_DAYS).toBe(5);
    const c = triggerCells(
      triggerRow({
        days: 4,
        events: 4,
        event_avg: 900,
        placebo_avg: 300,
        diff: 600,
        t: 2.2,
        thin: true,
      }),
    );
    expect(c.t).toBe('—');
    expect(c.flag).toBe('n < 5');
    expect(c.diff).toBe('+₹600');
    expect(c.diffTone).toBe('positive');
  });

  it('shows t from five event days, with no flag', () => {
    const c = triggerCells(
      triggerRow({
        days: 5,
        events: 6,
        event_avg: 900,
        placebo_avg: 300,
        diff: 600,
        t: 2.234,
        thin: false,
      }),
    );
    expect(c.t).toBe('2.23');
    expect(c.flag).toBeNull();
    expect(c.candidate).toBe(true);
  });

  it('separates a trigger that never fired from events that are not scored yet', () => {
    expect(triggerCells(triggerRow()).flag).toBe('no events');
    expect(triggerCells(triggerRow({ events_seen: 2, unscored_events: 2 })).flag).toBe(
      'not scored',
    );
    expect(triggerCells(triggerRow()).diff).toBe('—');
    expect(triggerCells(triggerRow()).diffTone).toBe('muted');
  });

  it('quotes the research cells, and T3 by its bound', () => {
    expect(researchCells({ explore: 754, explore_t: 3.5, confirm: -20, confirm_t: -0.1 })).toEqual({
      explore: '+₹754 (t 3.5)',
      confirm: '-₹20 (t -0.1)',
    });
    expect(researchCells({ explore_t_bound: 0.6, confirm_t_bound: 1.4 })).toEqual({
      explore: '|t| ≤ 0.6',
      confirm: '|t| ≤ 1.4',
    });
    expect(researchCells(null)).toEqual({ explore: '—', confirm: '—' });
  });
});

function dayRow(over: Partial<ShadowDayRow> = {}): ShadowDayRow {
  return {
    day: '2026-10-12',
    list: 'B',
    candidate: true,
    trigger: 'T1',
    underlying: 'NIFTY',
    entry: '11:38',
    detail: 'S1_down',
    status: 'scored',
    reason: '',
    displaced: 'N_wide_1202',
    displaced_start: '12:02',
    displaced_gross: 800,
    dir_net: 1500,
    diff_lot: 700,
    diff_basket: 1400,
    placebo_dir: 300,
    placebo_days: 12,
    control_diff_basket: -1000,
    ...over,
  };
}

describe('dayCells', () => {
  it('reads a scored day as the Dir minus the displaced pick', () => {
    const c = dayCells(dayRow());
    expect(c.event).toBe('T1 NIFTY 11:38 (S1 down)');
    expect(c.displaced).toBe('N_wide_1202 (12:02)');
    expect(c.dirNet).toBe('+₹1,500');
    expect(c.displacedGross).toBe('+₹800');
    expect(c.diffLot).toBe('+₹700');
    expect(c.diffBasket).toBe('+₹1,400');
    expect(c.control).toBe('-₹1,000');
    expect(c.status).toBe('Scored');
    expect(c.diffTone).toBe('positive');
  });

  it('never shows zero for a day that is not scored', () => {
    const c = dayCells(
      dayRow({
        status: 'pending',
        reason: 'N_wide_1202 has no stored result for 2026-10-12 yet',
        displaced_gross: null,
        dir_net: 1500,
        diff_lot: null,
        diff_basket: null,
        control_diff_basket: null,
      }),
    );
    expect(c.diffLot).toBe('—');
    expect(c.diffBasket).toBe('—');
    expect(c.displacedGross).toBe('—');
    expect(c.control).toBe('—');
    expect(c.status).toBe('Pending');
    expect(c.reason).toContain('no stored result');
    expect(c.diffTone).toBe('muted');
  });

  it('labels a late entry and an event with no pending pick', () => {
    expect(
      dayCells(dayRow({ status: 'late_entry', diff_lot: null, diff_basket: null })).status,
    ).toBe('Late entry');
    const na = dayCells(
      dayRow({ status: 'not_applied', displaced: null, displaced_start: null, diff_lot: null }),
    );
    expect(na.displaced).toBe('—');
    expect(na.status).toBe('Not applied');
  });

  it('words the trigger detail', () => {
    expect(detailLabel('from_over70')).toBe('back below 70');
    expect(detailLabel('from_under30')).toBe('back above 30');
    expect(detailLabel('R1_up')).toBe('R1 up');
    expect(detailLabel(null)).toBeNull();
  });

  it('summarises states in words', () => {
    expect(
      statusSummary({ scored: 3, pending: 1, not_applied: 2, late_entry: 0, no_entry: 0 }),
    ).toBe('3 scored, 1 pending, 2 not applied');
    expect(
      statusSummary({ scored: 0, pending: 0, not_applied: 0, late_entry: 0, no_entry: 0 }),
    ).toBe('no event days');
  });
});

const SERIES: ShadowSeriesPoint[] = [
  {
    day: '2026-10-12',
    diff_basket: 1400,
    cum_basket: 1400,
    control_diff_basket: -1000,
    cum_control: -1000,
  },
  {
    day: '2026-10-13',
    diff_basket: -700,
    cum_basket: 700,
    control_diff_basket: 200,
    cum_control: -800,
  },
  { day: '2026-10-14', diff_basket: 300, cum_basket: 1000 },
];

describe('chartModel', () => {
  it('is null with no scored day', () => {
    expect(chartModel([], 600, 200)).toBeNull();
  });

  it('keeps zero inside the range and ends on the list total', () => {
    const m = chartModel(SERIES, 600, 200);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.domain[0]).toBeLessThan(-1000);
    expect(m.domain[1]).toBeGreaterThan(1400);
    expect(m.zeroY).toBeGreaterThan(0);
    expect(m.zeroY).toBeLessThan(200);
    // the last running total is the sum of the daily differences (the API's total)
    expect(m.points[m.points.length - 1]?.cum).toBe(SERIES.reduce((s, p) => s + p.diff_basket, 0));
    // y grows upward: a higher total is a smaller y
    expect(m.points[0]!.y).toBeLessThan(m.points[1]!.y);
  });

  it('draws the control only through the days that have it', () => {
    const m = chartModel(SERIES, 600, 200)!;
    expect(m.points[2]!.controlY).toBeNull();
    expect(m.controlPath.split('L').length).toBe(2); // M ... L ...: two points
    expect(m.eventPath.split('L').length).toBe(3);
  });

  it('has no control path when no day has a placebo', () => {
    const m = chartModel(
      SERIES.map(({ day, diff_basket, cum_basket }) => ({ day, diff_basket, cum_basket })),
      600,
      200,
    )!;
    expect(m.controlPath).toBe('');
  });

  it('centres a single point', () => {
    const m = chartModel([SERIES[0]!], 600, 200, { l: 60, r: 20, t: 10, b: 20 })!;
    expect(m.points[0]!.x).toBe(60 + (600 - 80) / 2);
  });

  it('finds the nearest point and words its tooltip', () => {
    const m = chartModel(SERIES, 600, 200)!;
    const p = nearestPoint(m, m.points[1]!.x + 3)!;
    expect(p.day).toBe('2026-10-13');
    const lines = chartTooltip(p);
    expect(lines[1]).toContain('Dir minus displaced pick: -₹700');
    expect(lines.join(' ')).toContain('Placebo Dir minus that pick: +₹200');
    expect(chartTooltip(m.points[2]!)).toHaveLength(3);
  });
});

describe('niceTicks', () => {
  it('returns round values inside the range', () => {
    const t = niceTicks(-1200, 1600, 4);
    expect(t).toEqual([-1000, 0, 1000]);
    expect(niceTicks(0, 300, 3)).toEqual([0, 100, 200, 300]);
    expect(niceTicks(5, 5)).toEqual([5]);
  });
});

describe('researchRows', () => {
  it('puts the research gain and controls beside the forward total', () => {
    const r = response({
      override: {
        ...response().override,
        lists: [
          listSummary('A'),
          listSummary('B', { scored: 2, total_basket: 1000, event_days: 3, pending: 1 }),
          listSummary('C', { pending: 2, event_days: 2 }),
          listSummary('REF'),
        ],
      },
    });
    const rows = researchRows(r);
    const b = rows.find((x) => x.list === 'B')!;
    expect(b.exploreGain).toBe('+₹79,389');
    expect(b.exploreTime).toBe('+₹45,514');
    expect(b.exploreDay).toBe('+₹9,604');
    expect(b.exploreAbove).toBe('Above both');
    expect(b.confirmGain).toBe('-₹26,749');
    expect(b.forward).toBe('+₹1,000 (2 days)');
    const ref = rows.find((x) => x.list === 'REF')!;
    expect(ref.exploreGain).toBe('+₹54,556');
    expect(ref.confirmGain).toBe('+₹16,268');
    expect(ref.forward).toBe('—');
    expect(rows.find((x) => x.list === 'A')!.exploreAbove).toBe('Not above both');
    expect(rows.find((x) => x.list === 'C')!.forward).toBe('pending (2 days)');
    expect(rows.filter((x) => x.candidate).map((x) => x.list)).toEqual(['B', 'REF']);
  });
});
