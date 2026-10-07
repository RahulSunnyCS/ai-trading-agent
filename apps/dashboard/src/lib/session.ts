/**
 * Signed session cookie for the dashboard login (see docs/remote-dashboard.md).
 *
 * Token: `v1.<issuedAt>.<expiresAt>.<signature>`: two Unix-second integers and a base64url
 * HMAC-SHA-256 over `v1.<issuedAt>.<expiresAt>`. It carries no secret and nothing about the
 * password; it only proves that whoever minted it knew the password at the time.
 *
 * The HMAC key is SHA-256(context string + DASHBOARD_PASSWORD), so there is no second secret to
 * configure and changing the password invalidates every session at once. The cost: someone
 * holding a valid cookie could test password guesses offline against its signature. Only a
 * person who already logged in has one (it is HttpOnly), and a long random password makes the
 * guessing pointless, but it is one more reason to keep the password long.
 *
 * Sessions are stateless: logging out clears the browser's cookie, it does not revoke a copy.
 *
 * Runs in the edge middleware runtime: Web Crypto only, no node:crypto.
 */

export const SESSION_COOKIE = 'ata_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const VERSION = 'v1';
const KEY_CONTEXT = 'ata-dashboard-session-key:v1:';
/** Tolerated clock skew for a token whose issue time is slightly in the future. */
const MAX_SKEW_SECONDS = 60;
const TOKEN_PATTERN = /^v1\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

const encoder = new TextEncoder();

async function deriveKey(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(KEY_CONTEXT + password));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** One password is configured at a time, so a single memo saves re-deriving on every request. */
let cachedKey: { password: string; key: Promise<CryptoKey> } | null = null;

function signingKey(password: string): Promise<CryptoKey> {
  if (cachedKey?.password !== password) {
    const key = deriveKey(password);
    cachedKey = { password, key };
    // A failed derivation is not cached: the next request tries again.
    key.catch(() => {
      if (cachedKey?.key === key) cachedKey = null;
    });
  }
  return cachedKey.key;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded =
      text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Mints a session token valid for `ttlSeconds` from `nowMs`. */
export async function signSession(
  password: string,
  nowMs: number,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = `${VERSION}.${issuedAt}.${issuedAt + ttlSeconds}`;
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(password),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * True only for an unexpired token signed with this password. Never throws: anything
 * malformed is simply not a session. The signature is checked (in constant time, by
 * `crypto.subtle.verify`) before the times are trusted.
 */
export async function verifySession(
  token: string | null | undefined,
  password: string,
  nowMs: number,
): Promise<boolean> {
  if (!token || token.length > 128) return false;
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return false;
  const [, issuedText, expiresText, signatureText] = match;
  if (!issuedText || !expiresText || !signatureText) return false;
  const signature = fromBase64Url(signatureText);
  if (!signature) return false;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await signingKey(password),
      signature,
      encoder.encode(`${VERSION}.${issuedText}.${expiresText}`),
    );
    if (!valid) return false;
  } catch {
    return false;
  }
  const issuedAt = Number(issuedText);
  const expiresAt = Number(expiresText);
  const now = Math.floor(nowMs / 1000);
  if (expiresAt <= now) return false;
  if (issuedAt > now + MAX_SKEW_SECONDS) return false;
  // A lifetime longer than we ever issue means the token was not minted by this code.
  return expiresAt > issuedAt && expiresAt - issuedAt <= SESSION_TTL_SECONDS;
}

/** The `Cookie` header without the named cookie; null when nothing else is left. */
export function withoutCookie(header: string, name: string): string | null {
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part.split('=')[0]?.trim() !== name);
  return kept.length > 0 ? kept.join('; ') : null;
}

function cookieAttributes(secure: boolean, maxAge: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** `Set-Cookie` value that stores a session token. */
export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttributes(secure, SESSION_TTL_SECONDS)}`;
}

/** `Set-Cookie` value that removes the session cookie (same attributes, Max-Age=0). */
export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(secure, 0)}`;
}
