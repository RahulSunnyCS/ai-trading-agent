// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RotationShadowResponse,
  ShadowDayRow,
  ShadowListKey,
  ShadowListSummary,
  ShadowTriggerRow,
} from '../../../types/rotationShadow';

const hook = vi.hoisted(() => ({
  state: { data: null, loading: false, error: null, refetch: () => undefined } as {
    data: unknown;
    loading: boolean;
    error: string | null;
    refetch: () => void;
  },
}));

vi.mock('../../../hooks/useRotationShadow', () => ({
  useRotationShadow: () => hook.state,
}));

import { RotationShadowScoreboard } from '../RotationShadowScoreboard';

function list(key: ShadowListKey, over: Partial<ShadowListSummary> = {}): ShadowListSummary {
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
  };
}

function trig(
  trigger: ShadowTriggerRow['trigger'],
  template: ShadowTriggerRow['template'],
  over: Partial<ShadowTriggerRow> = {},
): ShadowTriggerRow {
  return {
    trigger,
    template,
    label: trigger === 'T1' ? 'Pivot cross with trend' : 'RSI exhaustion',
    template_label: template === 'dir' ? 'Dir' : template === 'wide' ? 'Widesl' : 'Buy',
    candidate: template === 'dir' && (trigger === 'T1' || trigger === 'T4'),
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
    research: null,
    ...over,
  };
}

function base(over: Partial<RotationShadowResponse> = {}): RotationShadowResponse {
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
    journal: { exists: false, entries: 0, forward: 0, late: 0, chain_intact: null, error: null },
    triggers: [trig('T1', 'dir'), trig('T4', 'dir'), trig('T1', 'wide')],
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
      lists: (['A', 'B', 'C', 'REF'] as const).map((k) => list(k)),
      days: [],
      controls: {
        random_time: { status: 'not_recorded', reason: 'The random-time control is not recorded.' },
        placebo: { status: 'recorded', reason: 'The time-matched placebo.', min_days: 10 },
      },
    },
    research: {
      periods: { explore: '2024-10-09 to 2026-10-08', confirm: 'NIFTY 2022-01-03 to 2024-10-08' },
      override: [
        ['explore', 'B', 79389, true],
        ['explore', 'REF', 54556, true],
        ['confirm', 'B', -26749, false],
        ['confirm', 'REF', 16268, false],
      ].map(([period, l, gain, above]) => ({
        period: period as 'explore' | 'confirm',
        list: l as ShadowListKey,
        plain: 0,
        override: 0,
        gain: gain as number,
        dd: 0,
        dd_plain: 0,
        random_time_p90: 1000,
        random_day_p90: 500,
        above_controls: above as boolean,
      })),
      applied: 'applied text',
      note: 'note text',
    },
    candidates: [
      {
        id: 'a',
        list: 'A',
        title: 'List A: VIX since open, drop only',
        definition: 'A pending pick is dropped.',
        research: { explore: '+18k', confirm: '-9.7k' },
        status: 'not_scored',
        reason: 'No nightly scoring exists for this candidate.',
      },
      {
        id: 'c',
        list: 'C',
        title: 'List C: VIX x live Widesl, free swap, 50% blend',
        definition: 'A pending pick is swapped.',
        research: { explore: '+10k', confirm: '-9.8k' },
        status: 'not_scored',
        reason: 'No nightly scoring exists for this candidate.',
      },
    ],
    ...over,
  };
}

function day(over: Partial<ShadowDayRow> = {}): ShadowDayRow {
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

beforeEach(() => {
  hook.state = { data: null, loading: true, error: null, refetch: vi.fn() };
});
afterEach(cleanup);

describe('RotationShadowScoreboard', () => {
  it('shows a placeholder while loading', () => {
    render(<RotationShadowScoreboard />);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });

  it('shows the error with a Retry that refetches', () => {
    const refetch = vi.fn();
    hook.state = { data: null, loading: false, error: 'proxy down', refetch };
    render(<RotationShadowScoreboard />);
    expect(screen.getByText('proxy down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('says what will appear and when before the first forward session, and still shows the research', () => {
    hook.state = { data: base(), loading: false, error: null, refetch: vi.fn() };
    render(<RotationShadowScoreboard />);
    expect(
      screen.getByText(
        '0 forward sessions, 0 with a trigger event, judged at 60 sessions, nothing here changes a list',
      ),
    ).toBeTruthy();
    expect(screen.getByText('No forward session has been scored yet')).toBeTruthy();
    expect(screen.getByText(/19:45 update/)).toBeTruthy();
    // the research comparison is there now: the two figures the owner named
    expect(screen.getByText('+₹79,389')).toBeTruthy();
    expect(screen.getByText('-₹26,749')).toBeTruthy();
    expect(screen.getByText('+₹54,556')).toBeTruthy();
    expect(screen.getByText('+₹16,268')).toBeTruthy();
    // the not-scored candidates, with no figure of their own
    expect(screen.getAllByText('Not scored')).toHaveLength(2);
    expect(screen.getAllByText('No nightly scoring exists for this candidate.')).toHaveLength(2);
    // the override panel explains its empty state
    expect(screen.getByText('No override day yet')).toBeTruthy();
  });

  it('flags a thin trigger row and highlights the candidates', () => {
    const data = base({
      banner: {
        sessions: 3,
        with_event: 2,
        judged_at: 60,
        remaining: 57,
        first_day: '2026-10-12',
        last_day: '2026-10-14',
      },
      triggers: [
        trig('T1', 'dir', {
          days: 2,
          events: 2,
          event_avg: 900,
          placebo_avg: 300,
          diff: 600,
          thin: true,
        }),
        trig('T4', 'dir', {
          days: 6,
          events: 7,
          event_avg: 500,
          placebo_avg: 300,
          diff: 200,
          t: 1.5,
          thin: false,
        }),
      ],
    });
    hook.state = { data, loading: false, error: null, refetch: vi.fn() };
    render(<RotationShadowScoreboard />);
    expect(screen.getByText('n < 10')).toBeTruthy();
    expect(screen.getByText('1.50')).toBeTruthy();
    expect(screen.getAllByText('Candidate').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('No forward session has been scored yet')).toBeNull();
  });

  it('shows a pending day as pending with no figure, and a scored day with its difference', () => {
    const rows = [
      day(),
      day({
        day: '2026-10-13',
        status: 'pending',
        reason: 'N_wide_1202 has no stored result for 2026-10-13 yet',
        displaced_gross: null,
        diff_lot: null,
        diff_basket: null,
        control_diff_basket: null,
      }),
    ];
    const data = base({
      banner: {
        sessions: 2,
        with_event: 2,
        judged_at: 60,
        remaining: 58,
        first_day: '2026-10-12',
        last_day: '2026-10-13',
      },
      override: {
        ...base().override,
        lists: [
          list('A'),
          list('B', {
            forward_days: 2,
            event_days: 2,
            scored: 1,
            pending: 1,
            total_basket: 1400,
            mean_lot: 700,
            beat_share: 1,
            control_days: 1,
            control_total_basket: -1000,
            series: [
              {
                day: '2026-10-12',
                diff_basket: 1400,
                cum_basket: 1400,
                control_diff_basket: -1000,
                cum_control: -1000,
              },
            ],
          }),
          list('C'),
          list('REF'),
        ],
        days: rows,
      },
    });
    hook.state = { data, loading: false, error: null, refetch: vi.fn() };
    render(<RotationShadowScoreboard />);
    // the chart for the chosen list (B by default) and its table
    expect(
      screen.getByLabelText(/Running total of the override minus the displaced pick/),
    ).toBeTruthy();
    const table = screen
      .getAllByRole('table')
      .find((t) => within(t).queryByText('Displaced pick'))!;
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(2);
    expect(within(bodyRows[0]!).getByText('Scored')).toBeTruthy();
    expect(within(bodyRows[0]!).getAllByText('+₹1,400').length).toBeGreaterThan(0);
    const pending = within(bodyRows[1]!);
    expect(pending.getByText('Pending')).toBeTruthy();
    expect(pending.getAllByText('—').length).toBeGreaterThanOrEqual(3); // pick, differences, control
    // never a zero for the unscored day
    expect(pending.queryByText('₹0')).toBeNull();
    expect(screen.getByText(/Random-time control/)).toBeTruthy();
  });

  it('switches lists', () => {
    hook.state = { data: base(), loading: false, error: null, refetch: vi.fn() };
    render(<RotationShadowScoreboard />);
    fireEvent.click(screen.getByRole('radio', { name: 'A' }));
    expect(screen.getByText('No override day yet')).toBeTruthy();
  });
});
