import { describe, expect, it } from 'vitest';

import type { MomentumSavedRun, MomentumWeeklyStatus } from '../../types/momentum';
import {
  actionTone,
  blockSeverity,
  canSend,
  effectiveSend,
  resultStrategies,
  runButtonLabel,
  sendConfirmationText,
  sendDisabledReason,
  signalActionRows,
  sortSignalRows,
  weeklyReadiness,
  weeksBehind,
} from '../momentumWeekly';

describe('run / send combinations', () => {
  it('allows sending a final run only', () => {
    expect(canSend('final')).toBe(true);
    expect(canSend('preview')).toBe(false);
    expect(sendDisabledReason('final')).toBeNull();
    expect(sendDisabledReason('preview')).toMatch(/preview/i);
  });

  it('never submits send for a preview, even if the flag is left on', () => {
    expect(effectiveSend('preview', true)).toBe(false);
    expect(effectiveSend('final', true)).toBe(true);
    expect(effectiveSend('final', false)).toBe(false);
  });

  it('labels the button with what will happen', () => {
    expect(runButtonLabel('preview', false)).toBe('Run preview');
    expect(runButtonLabel('preview', true)).toBe('Run preview');
    expect(runButtonLabel('final', false)).toBe('Run final without sending');
    expect(runButtonLabel('final', true)).toBe('Run final and send to Telegram');
  });

  it('says what the confirmation will send', () => {
    expect(sendConfirmationText(null, false)).toBe(
      "Sends the active strategy's final signal to Telegram.",
    );
    expect(sendConfirmationText('ETF Weekly Core', true)).toContain('(ETF Weekly Core)');
    expect(sendConfirmationText(null, true)).toMatch(/no active favourite/i);
  });
});

describe('signal rows', () => {
  it.each([
    ['BUY', 'positive'],
    ['ADD', 'positive'],
    ['SELL', 'negative'],
    ['TRIM 20%', 'negative'],
    ['HOLD', 'neutral'],
    ['WAIT', 'warning'],
    ['AT CAP', 'warning'],
    [' buy ', 'positive'],
    ['SOMETHING NEW', 'neutral'],
  ] as const)('%s is %s', (action, tone) => {
    expect(actionTone(action)).toBe(tone);
  });

  it('keeps only well-formed rows that carry an action', () => {
    const rows = signalActionRows({
      rows: [
        { asset: 'Gold', action: 'BUY', rank: 1 },
        { asset: 'IT', action: '', rank: 9 },
        { asset: 'Bank', action: 'HOLD', rank: null },
        { asset: 7, action: 'SELL' },
        null,
      ],
    });
    expect(rows).toEqual([
      { asset: 'Gold', action: 'BUY', rank: 1 },
      { asset: 'Bank', action: 'HOLD', rank: null },
    ]);
    expect(signalActionRows(null)).toEqual([]);
    expect(signalActionRows({ rows: 'nope' })).toEqual([]);
  });

  it('orders sells, buys, waiting, holds and is otherwise stable', () => {
    const rows = [
      { asset: 'A', action: 'HOLD', rank: 1 },
      { asset: 'B', action: 'BUY', rank: 2 },
      { asset: 'C', action: 'WAIT', rank: 3 },
      { asset: 'D', action: 'SELL', rank: 4 },
      { asset: 'E', action: 'BUY', rank: 5 },
    ];
    expect(sortSignalRows(rows).map((row) => row.asset)).toEqual(['D', 'B', 'E', 'C', 'A']);
  });
});

describe('blockSeverity', () => {
  const trade = { rows: [{ asset: 'Gold', action: 'BUY' }] };
  const quiet = { rows: [{ asset: 'Gold', action: 'HOLD' }] };

  it('blocked wins over everything', () => {
    expect(blockSeverity({ blocked: 'no data', active: true, signal: null }, 'info')).toBe(
      'blocked',
    );
  });

  it('the active block follows the run severity', () => {
    expect(blockSeverity({ blocked: null, active: true, signal: quiet }, 'action_required')).toBe(
      'warning',
    );
    expect(blockSeverity({ blocked: null, active: true, signal: quiet }, 'info')).toBe('info');
  });

  it('other blocks are a warning only when they indicate trades', () => {
    expect(blockSeverity({ blocked: null, active: false, signal: trade }, 'info')).toBe('warning');
    expect(blockSeverity({ blocked: null, active: false, signal: quiet }, 'warning')).toBe('info');
  });
});

describe('resultStrategies', () => {
  it('wraps a single-strategy payload as one active ETF block', () => {
    const blocks = resultStrategies({
      title: 'T',
      body: 'B',
      severity: 'info',
      sent_to_telegram: false,
      signal: { week: '2026-10-02' },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ dataset: 'etf', active: true, title: 'T', body: 'B' });
  });
});

describe('weeklyReadiness', () => {
  const status: MomentumWeeklyStatus = {
    today: '2026-10-05',
    target_week: '2026-10-02',
    datasets: [
      {
        key: 'etf',
        label: 'ETF prices',
        through: '2026-10-02',
        ready: true,
        note: '',
        error: null,
      },
      {
        key: 'stock',
        label: 'Bhavcopy',
        through: '2026-09-18',
        ready: false,
        note: 'behind',
        error: null,
      },
    ],
    signals: [
      { week: '2026-10-02', run: 'preview', label: 'P', generated_at: '2026-10-02T09:00:00Z' },
      { week: '2026-10-02', run: 'final', label: 'F', generated_at: '2026-10-02T12:00:00Z' },
    ],
    schedule: [],
  };
  const favourite = (name: string, dataset: string, active: boolean) =>
    ({
      id: name,
      name,
      active,
      favorite: true,
      config: { dataset },
    }) as unknown as MomentumSavedRun;

  it('counts whole weeks behind', () => {
    expect(weeksBehind('2026-09-18', '2026-10-02')).toBe(2);
  });

  it('is unknown before anything loads', () => {
    expect(weeklyReadiness(null, null)).toEqual({
      activeName: null,
      activeKnown: false,
      latestFinal: null,
      activeReady: null,
      blockedReasons: [],
    });
  });

  it('reports the active strategy as ready when its dataset is', () => {
    const r = weeklyReadiness(status, [favourite('ETF Core', 'etf', true)]);
    expect(r.activeName).toBe('ETF Core');
    expect(r.activeReady).toBe(true);
    expect(r.latestFinal?.label).toBe('F');
    // The stale bhavcopy data affects no favourite, so it is not a blocker.
    expect(r.blockedReasons).toEqual([]);
  });

  it('names the stale dataset that blocks the active strategy', () => {
    const r = weeklyReadiness(status, [favourite('Broad 20', 'broad', true)]);
    expect(r.activeReady).toBe(false);
    expect(r.blockedReasons).toEqual([
      'Bhavcopy: 2 week(s) behind the target week (blocks the active strategy, Broad 20).',
    ]);
  });

  it('flags favourites with no active one', () => {
    const r = weeklyReadiness(status, [favourite('ETF Core', 'etf', false)]);
    expect(r.activeName).toBeNull();
    expect(r.activeKnown).toBe(true);
    expect(r.blockedReasons[0]).toMatch(/No favourite is marked Telegram-active/);
  });
});
