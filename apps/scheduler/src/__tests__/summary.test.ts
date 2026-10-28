import { describe, expect, it } from 'bun:test';
import { localLoginCheck } from '../summary.js';

describe('the Mac login in the morning summary (BL-172)', () => {
  it('answers from the Mac when it ran, and leaves a GitHub fallback to GitHub', () => {
    expect(localLoginCheck(null)).toBeNull();
    expect(localLoginCheck({ ok: true })).toEqual({
      ok: true,
      label: 'Broker login',
      detail: 'logged in on the Mac',
    });
    expect(localLoginCheck({ ok: false, fallback: { parts: ['x'], url: 'u' } })).toBeNull();
    const refused = localLoginCheck({
      ok: false,
      fallback: null,
      result: {
        algotest: null,
        quantiply: null,
        quantiplyShoonya: { name: 'Quantiply · Shoonya', status: 'FAIL', detail: 'Wrong Password' },
        fatal: null,
      },
    });
    expect(refused?.ok).toBe(false);
    expect(refused?.detail).toContain('Quantiply · Shoonya: Wrong Password');
  });
});
