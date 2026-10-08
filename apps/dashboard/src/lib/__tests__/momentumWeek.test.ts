import { describe, expect, it } from 'vitest';

import type {
  MomentumJournalCheck,
  MomentumWeekRow,
  MomentumWeeklyStatus,
} from '../../types/momentum';
import {
  countdown,
  groupRows,
  istDay,
  needsAttention,
  rankDelta,
  roomToExit,
  selectedCard,
  sleeveLabel,
  timeline,
} from '../momentumWeek';

function status(patch: Partial<MomentumWeeklyStatus> = {}): MomentumWeeklyStatus {
  const step = (
    run: MomentumWeeklyStatus['schedule'][number]['run'],
    when: string,
    ran: string | null,
    late: number | null = null,
  ) => ({
    run,
    when,
    last_ran_at: ran,
    last_line: null,
    ran_late_by_minutes: late,
  });
  return {
    today: '2026-12-04',
    target_week: '2026-12-04',
    datasets: [
      {
        key: 'etf',
        label: 'Index & ETF prices',
        through: '2026-12-04',
        ready: true,
        note: '',
        error: null,
      },
      {
        key: 'stock',
        label: 'NSE bhavcopy stock data',
        through: '2026-11-27',
        ready: false,
        note: '',
        error: null,
      },
    ],
    signals: [],
    schedule: [
      step('preview', 'Fri 14:40 IST', '2026-12-04T14:41:00+05:30'),
      step('final', 'Fri 16:45 IST', '2026-12-04T17:30:00+05:30', 45),
      step('stock-ingest', 'Fri 19:30 IST', '2026-11-27T19:38:00+05:30'),
      step('journal-check', 'Fri 21:00 IST', null),
      step('live-rules', 'Fri 21:30 IST', null),
    ],
    ...patch,
  };
}

// 17:10 IST on Friday 4 Dec 2026.
const FRIDAY_AFTERNOON = new Date('2026-12-04T11:40:00Z');

describe('the Friday timeline', () => {
  it('marks each step done, late, waiting with a countdown, or missed', () => {
    const steps = timeline(status(), FRIDAY_AFTERNOON);
    expect(steps.map((s) => [s.run, s.state])).toEqual([
      ['preview', 'done'],
      ['final', 'late'],
      ['stock-ingest', 'waiting'],
      ['journal-check', 'waiting'],
      ['live-rules', 'waiting'],
    ]);
    expect(steps[2]?.minutesToGo).toBe(140);
    expect(steps[1]?.lateBy).toBe(45);
    expect(steps[2]?.label).toBe('Stock data + final');
  });

  it('calls a step missed once its time has passed on the Friday, or on any later day', () => {
    const late = timeline(status(), new Date('2026-12-04T14:30:00Z')); // 20:00 IST
    expect(late.find((s) => s.run === 'stock-ingest')?.state).toBe('missed');
    const due = timeline(status(), new Date('2026-12-04T14:05:00Z')); // 19:35 IST
    expect(due.find((s) => s.run === 'stock-ingest')?.state).toBe('due');
    const saturday = timeline(status(), new Date('2026-12-05T05:00:00Z'));
    expect(saturday.find((s) => s.run === 'journal-check')?.state).toBe('missed');
  });

  it('formats countdowns and IST days', () => {
    expect(countdown(140)).toBe('2 h 20 min');
    expect(countdown(45)).toBe('45 min');
    expect(countdown(120)).toBe('2 h');
    expect(istDay('2026-12-04T20:00:00Z')).toBe('2026-12-05');
  });
});

describe('needs attention', () => {
  it('lists splits always, data only once its run is due, journal gaps only after the check', () => {
    const before = timeline(status(), FRIDAY_AFTERNOON);
    const splits = {
      manual_review_after: '2026-10-01',
      pending_count: 1,
      counts: {},
      items: [{ symbol: 'KAYNES', ex_date: '2026-12-02', previous_close: 10478, close: 5384.5 }],
    } as never;
    const journal: MomentumJournalCheck = {
      week: '2026-12-04',
      expected: 2,
      recorded: 1,
      items: [
        {
          config_id: 'a',
          name: 'A',
          dataset: 'broad',
          run_kind: 'final',
          status: 'missing',
          entry_id: null,
          week: null,
          recorded_at: null,
          corrections: 0,
        },
        {
          config_id: 'b',
          name: 'B',
          dataset: 'etf',
          run_kind: 'final',
          status: 'recorded',
          entry_id: 1,
          week: '2026-12-04',
          recorded_at: null,
          corrections: 0,
        },
      ],
      chain: { entries: 1, head: null, problems: [] },
      warnings: [],
      ok: false,
    };
    const early = needsAttention({
      steps: before,
      status: status(),
      stockActions: splits,
      journal,
    });
    expect(early.map((i) => i.key)).toEqual(['split-KAYNES-2026-12-02']);
    expect(early[0]?.title).toBe('KAYNES fell 48.6% on 2026-12-02');

    const night = timeline(status(), new Date('2026-12-04T16:30:00Z')); // 22:00 IST
    const later = needsAttention({ steps: night, status: status(), stockActions: null, journal });
    expect(later.map((i) => i.key)).toEqual(['data-stock', 'journal-missing']);
    expect(later[1]?.detail).toBe('A (final)');
  });
});

describe('a favourite’s rows', () => {
  const row = (
    asset: string,
    action: string,
    rank: number | null,
    rank_prev: number | null = null,
  ): MomentumWeekRow => ({
    asset,
    action,
    rank,
    rank_prev,
    held: action !== 'BUY',
  });

  it('groups Sell / Buy / Hold by rank and leaves empty sections out', () => {
    const groups = groupRows([
      row('C', 'HOLD', 3),
      row('A', 'SELL', 30),
      row('B', 'TRIM', 5),
      row('D', 'HOLD', 1),
    ]);
    expect(groups.map((g) => [g.section, g.rows.map((r) => r.asset)])).toEqual([
      ['sell', ['B', 'A']],
      ['hold', ['D', 'C']],
    ]);
  });

  it('measures rank change and room to exit', () => {
    expect(rankDelta(row('A', 'HOLD', 4, 9))).toBe(5);
    expect(rankDelta(row('A', 'HOLD', 4))).toBeNull();
    expect(roomToExit(row('A', 'HOLD', 17), 20)).toBe(3);
    expect(roomToExit(row('A', 'HOLD', 17), null)).toBeNull();
  });

  it('picks the asked-for card, else the headline, and shortens sleeve names', () => {
    const cards = [
      { id: 'x', headline: false },
      { id: 'h', headline: true },
    ] as never[];
    expect(selectedCard(cards, null)).toMatchObject({ id: 'h' });
    expect(selectedCard(cards, 'x')).toMatchObject({ id: 'x' });
    expect(selectedCard(cards, 'gone')).toMatchObject({ id: 'h' });
    expect(sleeveLabel('Phase 6 ensemble 08c4307d (4w, ph1)', 'Phase 6 ensemble')).toBe(
      '08c4307d (4w, ph1)',
    );
    expect(sleeveLabel('Other', 'Phase 6 ensemble')).toBe('Other');
  });
});
