import { describe, expect, it } from 'vitest';

import type { MomentumAlert } from '../../types/momentum';
import {
  type AlertMemory,
  bellCount,
  dueToday,
  markShown,
  nextDay,
  pruneMemory,
  sortAlerts,
  topSeverity,
} from '../momentumAlerts';

function alert(id: string, severity: MomentumAlert['severity'], openedAt: string): MomentumAlert {
  return {
    id,
    kind: 'split',
    severity,
    title: id,
    detail: '',
    link: '/momentum/week',
    opened_at: openedAt,
    resolved_at: null,
  };
}

const SPLIT = alert('split:ABC:2026-10-07', 'warning', '2026-10-08T10:00:00+05:30');
const JOURNAL = alert('journal:missing:2026-10-09', 'error', '2026-10-09T21:05:00+05:30');
const RULES = alert('rules:money_gate:ready:2026-10-09', 'info', '2026-10-09T21:31:00+05:30');

describe('sortAlerts', () => {
  it('puts errors first, then warnings, then info, and the longest open first within one', () => {
    const older = alert('b', 'error', '2026-10-01T00:00:00+05:30');
    expect(sortAlerts([RULES, SPLIT, JOURNAL, older]).map((a) => a.id)).toEqual([
      'b',
      JOURNAL.id,
      SPLIT.id,
      RULES.id,
    ]);
  });

  it('does not change the list it is given', () => {
    const list = [RULES, JOURNAL];
    sortAlerts(list);
    expect(list.map((a) => a.id)).toEqual([RULES.id, JOURNAL.id]);
  });
});

describe('dueToday: an alert pops up at most once a day', () => {
  const today = '2026-10-09';

  it('is everything that has not been shown, most severe first', () => {
    expect(dueToday([SPLIT, JOURNAL, RULES], {}, today).map((a) => a.id)).toEqual([
      JOURNAL.id,
      SPLIT.id,
      RULES.id,
    ]);
  });

  it('skips an alert already shown today, however it was closed', () => {
    const memory: AlertMemory = { [JOURNAL.id]: today };
    expect(dueToday([SPLIT, JOURNAL], memory, today).map((a) => a.id)).toEqual([SPLIT.id]);
  });

  it('brings an alert back the next day while it is still open', () => {
    const memory = markShown({}, SPLIT.id, today);
    expect(dueToday([SPLIT], memory, today)).toEqual([]);
    expect(dueToday([SPLIT], memory, nextDay(today))).toEqual([SPLIT]);
  });

  it('is empty when nothing is open', () => {
    expect(dueToday([], {}, today)).toEqual([]);
  });
});

describe('markShown ("Remind me tomorrow")', () => {
  it('records the day without touching other alerts, and keeps the same object when unchanged', () => {
    const first = markShown({ a: '2026-10-01' }, 'b', '2026-10-09');
    expect(first).toEqual({ a: '2026-10-01', b: '2026-10-09' });
    expect(markShown(first, 'b', '2026-10-09')).toBe(first);
  });
});

describe('nextDay', () => {
  it('rolls over month and year ends', () => {
    expect(nextDay('2026-10-09')).toBe('2026-10-10');
    expect(nextDay('2026-10-31')).toBe('2026-11-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });
});

describe('pruneMemory', () => {
  it('drops alerts that are neither open nor shown today, and keeps the rest', () => {
    const memory: AlertMemory = {
      [SPLIT.id]: '2026-10-08',
      gone: '2026-10-08',
      clearedToday: '2026-10-09',
    };
    expect(pruneMemory(memory, [SPLIT], '2026-10-09')).toEqual({
      [SPLIT.id]: '2026-10-08',
      clearedToday: '2026-10-09',
    });
  });

  it('returns the same object when there is nothing to forget', () => {
    const memory: AlertMemory = { [SPLIT.id]: '2026-10-08' };
    expect(pruneMemory(memory, [SPLIT], '2026-10-09')).toBe(memory);
  });
});

describe('the bell', () => {
  it('is coloured by the worst open severity', () => {
    expect(topSeverity([RULES, SPLIT])).toBe('warning');
    expect(topSeverity([RULES, SPLIT, JOURNAL])).toBe('error');
    expect(topSeverity([])).toBeNull();
  });

  it('shows the count, and 9+ past nine', () => {
    expect(bellCount([SPLIT])).toBe('1');
    expect(bellCount(Array.from({ length: 9 }, (_, i) => alert(`a${i}`, 'info', '')))).toBe('9');
    expect(bellCount(Array.from({ length: 10 }, (_, i) => alert(`a${i}`, 'info', '')))).toBe('9+');
  });
});
