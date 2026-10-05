import { describe, expect, it } from 'vitest';

import {
  TOKEN_EXPIRING_THRESHOLD_MS,
  describeMarketSession,
  formatCountdown,
  marketSession,
  msUntil,
  tokenState,
} from '../market';

/** An instant from an IST wall-clock string, e.g. ist('2026-10-05T09:15:00'). */
function ist(local: string): Date {
  return new Date(`${local}+05:30`);
}

// 2026-10-05 is a Monday; 2026-10-09 a Friday; 2026-10-10 a Saturday.

describe('marketSession', () => {
  it('is closed before 09:00 on a weekday and changes at 09:00 that day', () => {
    const s = marketSession(ist('2026-10-05T08:59:59'));
    expect(s.state).toBe('closed');
    expect(s.label).toBe('Market closed');
    expect(s.nextChange.toISOString()).toBe(ist('2026-10-05T09:00:00').toISOString());
  });

  it('is pre-open from 09:00 until 09:15', () => {
    const start = marketSession(ist('2026-10-05T09:00:00'));
    expect(start.state).toBe('pre_open');
    expect(start.label).toBe('Pre-open');
    expect(start.nextChange.toISOString()).toBe(ist('2026-10-05T09:15:00').toISOString());
    expect(marketSession(ist('2026-10-05T09:14:59')).state).toBe('pre_open');
  });

  it('is open from 09:15 until 15:30', () => {
    const start = marketSession(ist('2026-10-05T09:15:00'));
    expect(start.state).toBe('open');
    expect(start.label).toBe('Market open');
    expect(start.nextChange.toISOString()).toBe(ist('2026-10-05T15:30:00').toISOString());
    expect(marketSession(ist('2026-10-05T15:29:59')).state).toBe('open');
  });

  it('is closed from 15:30 and reopens the next weekday at 09:00', () => {
    const s = marketSession(ist('2026-10-05T15:30:00'));
    expect(s.state).toBe('closed');
    expect(s.nextChange.toISOString()).toBe(ist('2026-10-06T09:00:00').toISOString());
  });

  it('skips the weekend after Friday close', () => {
    const s = marketSession(ist('2026-10-09T18:00:00'));
    expect(s.state).toBe('closed');
    expect(s.nextChange.toISOString()).toBe(ist('2026-10-12T09:00:00').toISOString());
  });

  it('is closed all weekend, even during session hours', () => {
    for (const at of ['2026-10-10T10:00:00', '2026-10-11T10:00:00']) {
      const s = marketSession(ist(at));
      expect(s.state).toBe('closed');
      expect(s.nextChange.toISOString()).toBe(ist('2026-10-12T09:00:00').toISOString());
    }
  });

  it('uses the IST day, not the UTC day', () => {
    // Sunday 20:00 UTC is already Monday 01:30 IST: closed, opening today.
    const mondayEarly = marketSession(new Date('2026-10-04T20:00:00Z'));
    expect(mondayEarly.nextChange.toISOString()).toBe(ist('2026-10-05T09:00:00').toISOString());
    // Friday 19:00 UTC is Saturday 00:30 IST.
    const saturdayEarly = marketSession(new Date('2026-10-09T19:00:00Z'));
    expect(saturdayEarly.nextChange.toISOString()).toBe(ist('2026-10-12T09:00:00').toISOString());
    // Monday 04:00 UTC is 09:30 IST: open.
    expect(marketSession(new Date('2026-10-05T04:00:00Z')).state).toBe('open');
  });
});

describe('describeMarketSession', () => {
  it('names the close while open', () => {
    expect(describeMarketSession(ist('2026-10-05T11:00:00'))).toBe('Market open · closes 15:30');
  });

  it('names the open during pre-open', () => {
    expect(describeMarketSession(ist('2026-10-05T09:05:00'))).toBe('Pre-open · opens 09:15');
  });

  it('omits the weekday when it opens later today', () => {
    expect(describeMarketSession(ist('2026-10-05T07:00:00'))).toBe('Market closed · opens 09:00');
  });

  it('names the weekday when it opens on another day', () => {
    expect(describeMarketSession(ist('2026-10-05T16:00:00'))).toBe(
      'Market closed · opens Tue 09:00',
    );
    expect(describeMarketSession(ist('2026-10-10T12:00:00'))).toBe(
      'Market closed · opens Mon 09:00',
    );
  });
});

describe('tokenState', () => {
  const now = new Date('2026-10-05T03:00:00Z');
  const inMs = (ms: number) => new Date(now.getTime() + ms).toISOString();

  it('is missing without a usable expiry', () => {
    expect(tokenState(null, now)).toBe('missing');
    expect(tokenState(undefined, now)).toBe('missing');
    expect(tokenState('', now)).toBe('missing');
    expect(tokenState('not a date', now)).toBe('missing');
  });

  it('is expired at or after the expiry instant', () => {
    expect(tokenState(inMs(0), now)).toBe('expired');
    expect(tokenState(inMs(-1000), now)).toBe('expired');
  });

  it('is expiring within the threshold and valid beyond it', () => {
    expect(tokenState(inMs(1000), now)).toBe('expiring');
    expect(tokenState(inMs(TOKEN_EXPIRING_THRESHOLD_MS), now)).toBe('expiring');
    expect(tokenState(inMs(TOKEN_EXPIRING_THRESHOLD_MS + 1000), now)).toBe('valid');
  });

  it('puts the threshold at two hours', () => {
    expect(TOKEN_EXPIRING_THRESHOLD_MS).toBe(7_200_000);
  });

  it('msUntil returns the signed gap or null', () => {
    expect(msUntil(inMs(90_000), now)).toBe(90_000);
    expect(msUntil(inMs(-90_000), now)).toBe(-90_000);
    expect(msUntil(null, now)).toBeNull();
  });
});

describe('formatCountdown', () => {
  const m = 60_000;
  const h = 60 * m;

  it('formats hours and minutes', () => {
    expect(formatCountdown(h + 42 * m)).toBe('1h 42m');
    expect(formatCountdown(h + 42 * m + 59_000)).toBe('1h 42m');
    expect(formatCountdown(2 * h)).toBe('2h');
    expect(formatCountdown(26 * h + 3 * m)).toBe('26h 3m');
  });

  it('formats minutes alone under an hour', () => {
    expect(formatCountdown(12 * m)).toBe('12m');
    expect(formatCountdown(m)).toBe('1m');
  });

  it('says "under a minute" below sixty seconds, and for zero or negative', () => {
    expect(formatCountdown(59_999)).toBe('under a minute');
    expect(formatCountdown(0)).toBe('under a minute');
    expect(formatCountdown(-5 * m)).toBe('under a minute');
  });
});
