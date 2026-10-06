import { describe, expect, it } from 'vitest';

import { fyersTokenExpiry } from '../fyers-token.js';

describe('fyersTokenExpiry', () => {
  it('expires an afternoon login at 06:00 IST the next morning, not 24h later', () => {
    const login = new Date('2026-10-06T09:30:00Z'); // 15:00 IST
    expect(fyersTokenExpiry(login, 86_400).toISOString()).toBe('2026-10-07T00:30:00.000Z');
  });

  it('uses the same morning reset for a login before 06:00 IST', () => {
    expect(fyersTokenExpiry(new Date('2026-10-05T23:30:00Z')).toISOString()).toBe(
      '2026-10-06T00:30:00.000Z',
    );
  });

  it('treats exactly 06:00 IST as already reset', () => {
    expect(fyersTokenExpiry(new Date('2026-10-06T00:30:00Z')).toISOString()).toBe(
      '2026-10-07T00:30:00.000Z',
    );
  });

  it('lets a shorter expires_in win', () => {
    const login = new Date('2026-10-06T09:30:00Z');
    expect(fyersTokenExpiry(login, 3_600).toISOString()).toBe('2026-10-06T10:30:00.000Z');
  });
});
