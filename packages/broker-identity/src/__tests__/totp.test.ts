import { describe, expect, it } from 'vitest';
import { generateTotp } from '../totp.js';

/**
 * RFC 6238 Appendix B test vectors (SHA-1, 30s step, 8-char base32 secret
 * repeated to the SHA-1 key length used by the spec's reference vectors).
 * These pin the algorithm itself — if this suite ever fails, the bug is in
 * the HMAC/counter/truncation math, not in a broker-specific detail.
 */
describe('generateTotp — RFC 6238 vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('t=59', () => {
    expect(generateTotp(secret, 59_000)).toBe('287082');
  });

  it('t=1111111109', () => {
    expect(generateTotp(secret, 1_111_111_109_000)).toBe('081804');
  });

  it('t=2000000000', () => {
    expect(generateTotp(secret, 2_000_000_000_000)).toBe('279037');
  });
});

describe('generateTotp — input handling', () => {
  it('accepts lowercase and hyphenated secrets the same as canonical base32', () => {
    const canonical = generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000);
    const messy = generateTotp('gezd-gnbv-gy3t-qojq-gezd-gnbv-gy3t-qojq', 59_000);
    expect(messy).toBe(canonical);
  });

  it('throws on an invalid base32 character rather than silently truncating', () => {
    expect(() => generateTotp('not-valid-base32-!!!', 59_000)).toThrow(/Invalid base32 character/);
  });

  it('produces a stable code within the same 30s window and a different one across it', () => {
    const a = generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000);
    const b = generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 60_000); // next window
    expect(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 30_000)).toBe(a); // same window as 59s
    expect(a).not.toBe(b);
  });
});
