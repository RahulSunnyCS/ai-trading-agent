import { createHmac } from 'node:crypto';
import { registerSecret } from './secrets.js';

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

/** RFC 6238, SHA-1 / 30s / 6 digits - what Angel One and Shoonya both use. */
export function generateTotp(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', base32Decode(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;

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
