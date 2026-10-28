import { describe, expect, it } from 'bun:test';
import { kiteLoginCheck, localLoginCheck } from '../summary.js';

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

describe("Kite's Friday and Monday login in the morning summary", () => {
  it('is a line only when it ran', () => {
    expect(kiteLoginCheck(null)).toBeNull();
    expect(kiteLoginCheck({ ok: true })).toBeNull();
    const skipped = { name: 'Kite', status: 'SKIPPED', detail: 'KITE_AUTO_LOGIN is not on' };
    expect(kiteLoginCheck({ ok: true, kite: skipped })).toBeNull();
    const failed = kiteLoginCheck({
      ok: true,
      kite: { name: 'Kite', status: 'FAIL', detail: 'held: refused before' },
    });
    expect(failed?.ok).toBe(false);
    expect(failed?.detail).toContain('Broker logins › Kite');
    expect(
      kiteLoginCheck({ ok: true, kite: { name: 'Kite', status: 'OK', detail: 'Kite connected.' } }),
    ).toEqual({ ok: true, label: 'Kite login', detail: 'Kite connected.' });
  });
});
