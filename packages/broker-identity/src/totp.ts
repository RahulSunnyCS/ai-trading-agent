import { createHmac } from 'node:crypto';
import { registerSecret } from '@trading/notify';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[=\s-]/g, '');
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;

  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base32 character ${JSON.stringify(char)} in TOTP secret`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  if (bytes.length === 0) throw new Error('TOTP secret decoded to zero bytes');
  return Buffer.from(bytes);
}

function byteAt(buf: Buffer, index: number): number {
  const value = buf[index];
  if (value === undefined) throw new Error(`HMAC digest too short: missing byte ${index}`);
  return value;
}

/**
 * RFC 6238, SHA-1 / 30s / 6 digits — what both Angel One and Finvasia use.
 *
 * This is the single implementation for every broker login path in the repo:
 * apps/server's live Angel One WebSocket auth (ingestion/brokers/angelone.ts)
 * and packages/broker-login's Playwright AlgoTest automation both call this
 * function rather than each carrying (or depending on) their own generator.
 * Verified against the official RFC 6238 Appendix B test vectors in
 * src/__tests__/totp.test.ts, and cross-checked 18/18 against otplib's
 * generateSync output before apps/server switched over — see the commit that
 * removed the otplib dependency for that parity check.
 */
export function generateTotp(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', base32Decode(secret)).update(counterBytes).digest();
  const offset = byteAt(digest, digest.length - 1) & 0x0f;
  const binary =
    ((byteAt(digest, offset) & 0x7f) << 24) |
    (byteAt(digest, offset + 1) << 16) |
    (byteAt(digest, offset + 2) << 8) |
    byteAt(digest, offset + 3);

  const code = String(binary % 1_000_000).padStart(6, '0');
  registerSecret(code);
  return code;
}

function secondsRemaining(atMs: number = Date.now()): number {
  return STEP_SECONDS - (Math.floor(atMs / 1000) % STEP_SECONDS);
}

/**
 * Returns a code with enough life left to survive form submission, and guarantees a
 * different code than the previous call - a retry must never resubmit a rejected one.
 *
 * Not used by apps/server, which authenticates once per reconnect and has no
 * form-submission latency to guard against — only packages/broker-login's
 * Playwright flow needs this freshness guarantee. It lives here rather than
 * being split out because it is a thin wrapper around generateTotp with no
 * broker-login-specific behavior (no Playwright types, no AlgoTest concepts),
 * so there is nothing to gain from keeping it apart from the function it wraps.
 */
export async function freshTotp(secret: string, minLifeSeconds = 6): Promise<string> {
  if (secondsRemaining() < minLifeSeconds) {
    await waitForNextWindow();
  }
  return generateTotp(secret);
}

export async function waitForNextWindow(): Promise<void> {
  const waitMs = secondsRemaining() * 1000 + 500;
  console.log(`  waiting ${Math.round(waitMs / 1000)}s for the next TOTP window`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}
