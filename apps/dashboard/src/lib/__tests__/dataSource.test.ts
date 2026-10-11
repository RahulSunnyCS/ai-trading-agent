import { describe, expect, it } from 'vitest';

import { type SourceStatus, attentionDays, bannerHeadline } from '../dataSource';

const status: SourceStatus = {
  days: [
    { day: '2026-10-08', source: 'fyers', lines: [], kept_existing: 0 },
    {
      day: '2026-10-09',
      source: 'angelone',
      lines: ['NIFTY: index minutes 15:15-15:28 missing (14)'],
      kept_existing: 0,
    },
    { day: '2026-10-07', source: 'angelone', lines: [], kept_existing: 0 },
  ],
  attention: ['2026-10-09', '2026-10-07'],
};

describe('attentionDays', () => {
  it('returns only the Angel One days, oldest first', () => {
    expect(attentionDays(status).map((d) => d.day)).toEqual(['2026-10-07', '2026-10-09']);
  });
  it('is empty while the status is unknown or clean', () => {
    expect(attentionDays(null)).toEqual([]);
    expect(attentionDays({ days: [], attention: [] })).toEqual([]);
  });
});

describe('bannerHeadline', () => {
  it('names a single day', () => {
    expect(bannerHeadline(status.days.filter((d) => d.day === '2026-10-09'))).toBe(
      'Options data for Fri, 9 Oct came from Angel One, not Fyers',
    );
  });
  it('gives the span for several days', () => {
    expect(bannerHeadline(attentionDays(status))).toContain('2 days (Wed, 7 Oct to Fri, 9 Oct)');
  });
  it('says nothing when there are no days', () => {
    expect(bannerHeadline([])).toBe('');
  });
});
