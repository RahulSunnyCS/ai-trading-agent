import { describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearedSessionCookie,
  sessionCookie,
  signSession,
  verifySession,
  withoutCookie,
} from '../session';

const NOW = Date.UTC(2026, 9, 5, 9, 0, 0);
const PASSWORD = 'correct horse battery staple';

/** Re-signs nothing: swaps one dot-separated part of a token. */
function withPart(token: string, index: number, value: string): string {
  const parts = token.split('.');
  parts[index] = value;
  return parts.join('.');
}

describe('signSession / verifySession', () => {
  it('accepts a fresh token until it expires', async () => {
    const token = await signSession(PASSWORD, NOW);
    expect(token).toMatch(/^v1\.\d+\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(await verifySession(token, PASSWORD, NOW)).toBe(true);
    expect(await verifySession(token, PASSWORD, NOW + (SESSION_TTL_SECONDS - 1) * 1000)).toBe(true);
  });

  it('holds nothing derived from the password but the signature', async () => {
    const token = await signSession(PASSWORD, NOW);
    const [version, issued, expires] = token.split('.');
    expect(version).toBe('v1');
    expect(Number(issued)).toBe(Math.floor(NOW / 1000));
    expect(Number(expires) - Number(issued)).toBe(SESSION_TTL_SECONDS);
    expect(token).not.toContain(PASSWORD);
    expect(token).not.toContain(btoa(PASSWORD).replace(/=+$/, ''));
  });

  it('rejects an expired token', async () => {
    const token = await signSession(PASSWORD, NOW);
    expect(await verifySession(token, PASSWORD, NOW + SESSION_TTL_SECONDS * 1000)).toBe(false);
    expect(await verifySession(token, PASSWORD, NOW + (SESSION_TTL_SECONDS + 1) * 1000)).toBe(
      false,
    );
  });

  it('rejects a tampered payload', async () => {
    const token = await signSession(PASSWORD, NOW);
    const [, issued, expires] = token.split('.');
    // Pushing the expiry out, or the issue time back, breaks the signature.
    expect(
      await verifySession(withPart(token, 2, String(Number(expires) + 1)), PASSWORD, NOW),
    ).toBe(false);
    expect(await verifySession(withPart(token, 1, String(Number(issued) - 1)), PASSWORD, NOW)).toBe(
      false,
    );
    expect(await verifySession(withPart(token, 0, 'v2'), PASSWORD, NOW)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const token = await signSession(PASSWORD, NOW);
    const signature = token.split('.')[3] ?? '';
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    expect(await verifySession(withPart(token, 3, flipped), PASSWORD, NOW)).toBe(false);
    expect(await verifySession(withPart(token, 3, 'A'.repeat(43)), PASSWORD, NOW)).toBe(false);
  });

  it('rejects a token signed with a different password', async () => {
    const token = await signSession('the old password', NOW);
    expect(await verifySession(token, PASSWORD, NOW)).toBe(false);
  });

  it('rejects a token issued in the future or with too long a life', async () => {
    const future = await signSession(PASSWORD, NOW + 10 * 60 * 1000);
    expect(await verifySession(future, PASSWORD, NOW)).toBe(false);
    const longLived = await signSession(PASSWORD, NOW, SESSION_TTL_SECONDS * 2);
    expect(await verifySession(longLived, PASSWORD, NOW)).toBe(false);
  });

  it.each([
    null,
    undefined,
    '',
    'garbage',
    'v1',
    'v1..',
    'v1.1.2',
    'v1.1.2.',
    'v1.1.2.!!!',
    'v1.a.b.c',
    'v1.-1.2.AAAA',
    `v1.1.2.${'A'.repeat(42)}`,
    `v1.1.2.${'A'.repeat(44)}`,
    `v1.1.99999999999999999999.${'A'.repeat(43)}`,
    `v1.1.2.${'A'.repeat(43)}.extra`,
    'x'.repeat(5000),
    '%00%00',
  ])('rejects the malformed token %j without throwing', async (token) => {
    await expect(verifySession(token, PASSWORD, NOW)).resolves.toBe(false);
  });
});

describe('cookie helpers', () => {
  it('removes one cookie from a header', () => {
    expect(withoutCookie(`a=1; ${SESSION_COOKIE}=x; b=2`, SESSION_COOKIE)).toBe('a=1; b=2');
    expect(withoutCookie(`${SESSION_COOKIE}=x`, SESSION_COOKIE)).toBeNull();
  });

  it('sets and clears with the same attributes', () => {
    expect(sessionCookie('tok', true)).toBe(
      `${SESSION_COOKIE}=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}; Secure`,
    );
    expect(sessionCookie('tok', false)).not.toContain('Secure');
    expect(clearedSessionCookie(true)).toBe(
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    );
  });
});
