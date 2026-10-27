import { describe, expect, it } from 'vitest';

import type { KiteStatus } from '../../components/KiteCard';
import type { MomentumLiveRules, MomentumWeekView } from '../../types/momentum';
import type { RotationOverview, RotationSummary } from '../../types/rotation';
import type { RotationLiveResponse } from '../../types/rotationLive';
import type { TradeBookDaysResponse, TradeBookSummary } from '../../types/tradeBook';
import type { AngelStatus } from '../angelOne';
import {
  angelLine,
  brokerLoginLine,
  dataLines,
  entryLine,
  failureReason,
  fyersLine,
  jobsOverview,
  kiteLine,
  latestPaperDay,
  liveForDay,
  momentumHeadline,
  readoutProgress,
  rulesLine,
  tradeBookOverview,
} from '../overviewView';
import type { SchedulerJob, SchedulerRun } from '../scheduler';

const NOW = Date.parse('2026-10-28T03:10:00+05:30');

const overview = {
  health: {
    state: 'warn',
    as_of: '2026-10-28T02:49:36+05:30',
    checks: [
      { id: 'session', label: 'Latest session', value: 'Tue 27 Oct', state: 'ok', detail: '' },
      { id: 'entry', label: "Today's entry", value: 'due 09:16', state: 'info', detail: '' },
      {
        id: 'vix',
        label: 'VIX open',
        value: '17.16 from angelone',
        state: 'warn',
        detail: 'read from the fallback source',
      },
    ],
  },
} as unknown as RotationOverview;

const summary = {
  n_days: 10,
  readout_days: 60,
  first_day: '2026-10-12',
  last_day: '2026-10-27',
  lists: { C: { total: 27250 } },
  days: [
    { day: '2026-10-26', base: 0, base_total: 0, C: 1706.25, C_total: 5118.75 },
    { day: '2026-10-27', base: 0, base_total: 0, C: -2793.9, C_total: -8381.75 },
  ],
} as unknown as RotationSummary;

const live = {
  from: '2026-10-21',
  to: '2026-10-27',
  captured_days: ['2026-10-26', '2026-10-27'],
  days: [
    {
      day: '2026-10-27',
      captured: true,
      failed_sections: [],
      groups: [
        { platform: 'quantiply', broker: 'angelone', book: 'core', live: -6428.5, paper: -8381.75 },
        { platform: 'quantiply', broker: 'finvasia', book: 't1', live: -7894.25, paper: -8534.5 },
      ],
    },
    { day: '2026-10-26', captured: false, failed_sections: [], groups: [] },
  ],
} as unknown as RotationLiveResponse;

describe('Rotation today', () => {
  it("reads today's entry from the health checks", () => {
    expect(entryLine(overview)).toEqual({
      label: "Today's entry",
      text: 'due 09:16',
      tone: 'info',
      detail: undefined,
    });
    expect(entryLine(null)).toBeNull();
  });

  it("takes the newest scored day's paper total for Adaptive Classic", () => {
    expect(latestPaperDay(summary)).toEqual({ day: '2026-10-27', value: -8381.75 });
    expect(latestPaperDay({ ...summary, days: [] })).toBeNull();
  });

  it('sums the core book live with its paper twin, and names a missing capture', () => {
    expect(liveForDay(live, '2026-10-27')).toEqual({
      value: -6428.5,
      paper: -8381.75,
      accounts: 1,
      reason: null,
    });
    expect(liveForDay(live, '2026-10-26')).toMatchObject({
      value: null,
      reason: 'live not captured',
    });
    expect(liveForDay(live, '2026-10-20').value).toBeNull();
    expect(liveForDay(null, '2026-10-27').reason).toBe('live results unavailable');
    const day = live.days[0];
    const noCore = {
      ...live,
      days: [{ ...day, groups: [day?.groups[1]] }],
    } as unknown as RotationLiveResponse;
    expect(liveForDay(noCore, '2026-10-27')).toMatchObject({
      value: null,
      reason: 'no live trades',
    });
  });

  it('says when an account was not read, with or without a figure', () => {
    const failed = [{ platform: 'algotest', broker: 'finvasia', error: 'login' }];
    const partial = {
      ...live,
      days: [{ ...live.days[0], failed_sections: failed }],
    } as unknown as RotationLiveResponse;
    expect(liveForDay(partial, '2026-10-27')).toMatchObject({
      value: -6428.5,
      reason: 'an account was not read',
    });
    const none = {
      ...live,
      days: [{ ...live.days[0], failed_sections: failed, groups: [] }],
    } as unknown as RotationLiveResponse;
    expect(liveForDay(none, '2026-10-27')).toMatchObject({
      value: null,
      reason: 'capture failed for an account',
    });
  });

  it('counts the read-out days and the total since the first day', () => {
    expect(readoutProgress(summary)).toEqual({
      day: 10,
      of: 60,
      sinceFirst: 27250,
      firstDay: '2026-10-12',
    });
    expect(readoutProgress(null)).toBeNull();
  });

  it('lists the health checks but the entry on the Data card', () => {
    expect(dataLines(overview)?.map((line) => [line.label, line.tone])).toEqual([
      ['Latest session', 'ok'],
      ['VIX open', 'warn'],
    ]);
    expect(dataLines(null)).toBeNull();
  });
});

describe('Momentum this week', () => {
  const week = {
    favourites: [
      { name: 'Other', headline: false, edge: null },
      {
        name: 'Four Sectors Monthly, No Tilt · all Fridays',
        headline: true,
        edge: {
          sleeve: 'Four Sectors Monthly, No Tilt · all Fridays · Friday 3 of 4',
          on: '2026-10-30',
          weakest_held: [],
          strongest_not_held: [],
        },
      },
    ],
  } as unknown as MomentumWeekView;

  it('names the headline and the sleeve that trades next', () => {
    expect(momentumHeadline(week)).toEqual({
      name: 'Four Sectors Monthly, No Tilt · all Fridays',
      nextTrade: 'Friday 3 of 4 trades on Fri 30 Oct',
    });
    expect(momentumHeadline({ ...week, favourites: [] })).toBeNull();
  });

  const report = (patch: object): MomentumLiveRules =>
    ({
      job: null,
      report: {
        title: 'Live rules check: no rule breached',
        breached: false,
        stale: null,
        numbers: { drawdown: -0.0748, cut_half_at: 0.2 },
        findings: [],
        ...patch,
      },
    }) as unknown as MomentumLiveRules;

  it("states the rules' state with the drawdown against the cut line", () => {
    expect(rulesLine(report({}))).toMatchObject({
      text: 'all clear · drawdown -7.5% of -20%',
      tone: 'ok',
    });
    expect(rulesLine(report({ breached: true })).tone).toBe('bad');
    expect(rulesLine(report({ findings: [{ needs_you: true }] })).tone).toBe('warn');
    expect(rulesLine({ report: null, job: null })).toMatchObject({ text: 'not checked yet' });
  });

  it('says whether Kite is logged in, and warns only before the Friday orders', () => {
    const kite = (patch: Partial<KiteStatus>): KiteStatus => ({
      configured: true,
      connected: false,
      expiresAt: null,
      userId: null,
      holdingsSource: 'kite',
      lastSnapshot: null,
      ...patch,
    });
    const fridayMorning = Date.parse('2026-10-30T09:00:00+05:30');
    const fridayEvening = Date.parse('2026-10-30T15:00:00+05:30');
    // NOW is a Wednesday: the login is not needed until Friday.
    expect(kiteLine(kite({}), NOW).tone).toBe('neutral');
    expect(kiteLine(kite({}), fridayMorning).tone).toBe('warn');
    expect(kiteLine(kite({}), fridayEvening).tone).toBe('neutral');
    expect(kiteLine(kite({ holdingsSource: 'paper' }), fridayMorning).tone).toBe('neutral');
    expect(
      kiteLine(kite({ connected: true, expiresAt: '2026-10-29T06:00:00+05:30' }), NOW),
    ).toEqual({
      label: 'Kite',
      text: 'logged in until 06:00',
      tone: 'ok',
    });
    expect(kiteLine(null, NOW).text).toBe('status unavailable');
  });
});

describe('Trade book', () => {
  const tb = {
    summary: { sessions: 142, net: 93843.72, profit_pct: 7.82 },
    last_note_day: '2026-10-27',
  } as unknown as TradeBookSummary;
  const days = {
    problems: [],
    days: [
      { day: '2026-09-30', profit: 1000 },
      { day: '2026-10-26', profit: 2000 },
      { day: '2026-10-27', profit: -7928.72 },
      { day: '2026-10-28', profit: null },
    ],
  } as unknown as TradeBookDaysResponse;

  it('reads the latest day with a note, this month and the year so far', () => {
    expect(tradeBookOverview(tb, days, '2026-10-28')).toEqual({
      lastNoteDay: '2026-10-27',
      latest: { day: '2026-10-27', net: -7928.72 },
      monthToDate: { month: '2026-10', net: 2000 - 7928.72, sessions: 2 },
      fyNet: 93843.72,
      fyPct: 7.82,
    });
  });

  it('leaves a month with no note, or a year with no session, empty rather than zero', () => {
    const view = tradeBookOverview(tb, days, '2026-11-02');
    expect(view?.monthToDate).toBeNull();
    const empty = tradeBookOverview(
      { ...tb, summary: { ...tb.summary, sessions: 0, net: 0 } } as TradeBookSummary,
      { days: [], problems: [] },
      '2026-11-02',
    );
    expect(empty?.fyNet).toBeNull();
    expect(empty?.latest).toBeNull();
    expect(tradeBookOverview(null, days, '2026-10-28')).toBeNull();
  });
});

describe('Jobs', () => {
  const run = (patch: Partial<SchedulerRun>): SchedulerRun => ({
    id: 1,
    job: 'x',
    trigger: 'schedule',
    scheduled_for: null,
    started_at: '2026-10-27T03:47:00.000Z',
    ended_at: '2026-10-27T03:47:25.000Z',
    exit_code: 0,
    attempts: 1,
    error: null,
    ...patch,
  });
  const job = (id: string, lastRun: SchedulerRun | null): SchedulerJob => ({
    id,
    description: '',
    schedule: '',
    nextRun: null,
    lastRun,
    needs: [],
    group: null,
  });

  it('lists the failures of the last 24 hours, newest first, and counts the rest', () => {
    const jobs = [
      job('algotest-deploy', run({ exit_code: 1, error: 'exit 1' })),
      job('algotest-deploy-check', run({ exit_code: 1, ended_at: '2026-10-27T10:08:32.000Z' })),
      job('old-failure', run({ exit_code: 1, ended_at: '2026-10-26T10:00:00.000Z' })),
      job('options-evening', run({ ended_at: '2026-10-27T10:28:28.000Z' })),
      job('running', run({ ended_at: null, exit_code: null })),
      job('never', null),
    ];
    const view = jobsOverview(jobs, NOW);
    expect(view.failed.map((j) => j.id)).toEqual(['algotest-deploy-check', 'algotest-deploy']);
    expect(view).toMatchObject({ succeeded: 1, running: 1, quiet: 1 });
    // Its latest run failed a day and a half ago: still broken, so still on the card.
    expect(view.failedEarlier.map((j) => j.id)).toEqual(['old-failure']);
  });

  it("gives a failure's reason from its error, else from its log", () => {
    const log = [
      '=== algotest-deploy · schedule · attempt 1',
      '$ node_modules/.bin/tsx src/strategy-deploy.ts --latest t1 --apply',
      "❌ locator.waitFor: Timeout 30000ms exceeded. Call log:   - waiting for getByText('Strategy Deployed')",
      '=== exit 1',
    ].join('\n');
    expect(failureReason(run({ error: 'exit 1' }), log)).toBe(
      "locator.waitFor: Timeout 30000ms exceeded. Call log: - waiting for getByText('Strategy Deployed')",
    );
    expect(failureReason(run({ error: 'missed: the scheduler was not running' }), log)).toBe(
      'missed: the scheduler was not running',
    );
    expect(failureReason(run({ error: 'exit 2' }), null)).toBe('exit 2');
    expect(failureReason(run({ error: 'exit 1' }), 'line one\nlast words\n=== exit 1')).toBe(
      'last words',
    );
    expect(failureReason(run({ error: 'x'.repeat(300) }), null)).toHaveLength(140);
  });

  it("reads the morning login's latest run", () => {
    expect(brokerLoginLine(job('broker-login', run({})), NOW).tone).toBe('ok');
    expect(
      brokerLoginLine(job('broker-login', run({ exit_code: -1, error: 'missed' })), NOW),
    ).toMatchObject({ tone: 'bad', detail: 'missed' });
    expect(brokerLoginLine(null, NOW).text).toBe('job not found');
  });
});

describe('Logins', () => {
  it('reads the Fyers token state', () => {
    const status = {
      configured: true,
      connected: true,
      degraded: false,
      needsReauth: false,
      expiresAt: '2026-10-28T06:00:00+05:30',
    };
    expect(fyersLine(status, 'valid', null)).toEqual({
      label: 'Fyers',
      text: 'valid until 06:00',
      tone: 'ok',
    });
    expect(fyersLine(status, 'expired', null).tone).toBe('bad');
    expect(fyersLine(null, 'missing', 'HTTP 502').text).toBe('status unavailable');
  });

  it("reads Angel One's last check", () => {
    const status = {
      configured: true,
      last_check: {
        checked_at: '2026-10-27T18:01:16+05:30',
        ok: true,
        reason: 'ok',
        message: 'Logged in.',
      },
    } as unknown as AngelStatus;
    expect(angelLine(status, NOW)).toMatchObject({ text: 'login works · 9 h ago', tone: 'ok' });
    const failed = {
      ...status,
      last_check: { ...status.last_check, ok: false, reason: 'rejected', message: 'bad PIN' },
    } as AngelStatus;
    expect(angelLine(failed, NOW)).toMatchObject({ tone: 'bad', detail: 'bad PIN' });
    expect(angelLine(null, NOW).text).toBe('status unavailable');
  });
});
