/**
 * Cloudflare Access sign-in for the dashboard host (docs/remote-dashboard.md).
 *
 * When the dashboard hostname sits behind a Cloudflare Access application, Access signs the
 * person in (Google, one-time PIN, ...) and forwards each request with a signed JWT in
 * `Cf-Access-Jwt-Assertion`. This file checks that token instead of trusting the header: the
 * RS256 signature against the team's published keys, the application's AUD tag, the issuer
 * and the expiry. A request that skipped Access has no valid token and is refused.
 *
 * Runs in the edge middleware runtime: Web Crypto and fetch only, no node:crypto.
 */

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_COOKIE = 'CF_Authorization';

export interface AccessConfig {
  /** e.g. `my-team.cloudflareaccess.com`: where Access publishes its keys and issues tokens. */
  teamDomain: string;
  /** The Access application's AUD tag (Zero Trust > Access > Applications > Overview). */
  aud: string;
}

type Jwk = JsonWebKey & { kid?: string };
export type FetchKeys = (teamDomain: string) => Promise<Jwk[]>;

const TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;
const LEEWAY_SECONDS = 60;
const KEYS_TTL_MS = 60 * 60_000;
/** A token naming an unknown key id may be a rotation, but must not make us hammer Cloudflare. */
const KEYS_MIN_REFETCH_MS = 60_000;

/** Normalises `https://x.cloudflareaccess.com/` to the bare host; null if it is not one. */
export function parseTeamDomain(value: string): string | null {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '');
  return TEAM_DOMAIN.test(host) ? host : null;
}

export async function fetchAccessKeys(teamDomain: string): Promise<Jwk[]> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access keys request failed: ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  return Array.isArray(body.keys) ? body.keys : [];
}

interface KeyCache {
  keys: Jwk[];
  /** Imported verification keys by kid, so a request does not re-import the same RSA key. */
  imported: Map<string, CryptoKey>;
  fetchedAt: number;
  /** Last time a refresh was started, successful or not: failures are retried at most this often. */
  attemptedAt: number;
  /** The refresh in flight, shared by concurrent requests. */
  pending: Promise<void> | null;
}
const caches = new Map<string, KeyCache>();

/** Forgets cached keys; tests use it, nothing else needs to. */
export function resetAccessKeyCache(): void {
  caches.clear();
}

function refresh(
  cache: KeyCache,
  teamDomain: string,
  now: number,
  fetchKeys: FetchKeys,
): Promise<void> {
  cache.attemptedAt = now;
  cache.pending ??= fetchKeys(teamDomain)
    .then((keys) => {
      cache.keys = keys;
      cache.imported.clear();
      cache.fetchedAt = now;
    })
    // A failed refresh keeps the keys we already have; the next try is rate limited above.
    .catch(() => {})
    .finally(() => {
      cache.pending = null;
    });
  return cache.pending;
}

async function keyFor(
  teamDomain: string,
  kid: string,
  now: number,
  fetchKeys: FetchKeys,
): Promise<CryptoKey | null> {
  let cache = caches.get(teamDomain);
  if (!cache) {
    cache = {
      keys: [],
      imported: new Map(),
      fetchedAt: Number.NEGATIVE_INFINITY,
      attemptedAt: Number.NEGATIVE_INFINITY,
      pending: null,
    };
    caches.set(teamDomain, cache);
  }
  const hit = cache.keys.some((key) => key.kid === kid);
  const stale = now - cache.fetchedAt >= KEYS_TTL_MS;
  // Refresh when the keys are old, or when a token names a key we do not have (a rotation),
  // but never more than once a minute.
  if ((stale || !hit) && now - cache.attemptedAt >= KEYS_MIN_REFETCH_MS) {
    await refresh(cache, teamDomain, now, fetchKeys);
  } else if (cache.pending) {
    await cache.pending;
  }
  const cached = cache.imported.get(kid);
  if (cached) return cached;
  const jwk = cache.keys.find((key) => key.kid === kid);
  if (!jwk || jwk.kty !== 'RSA') return null;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    cache.imported.set(kid, key);
    return key;
  } catch {
    return null;
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(part);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True only for a token Access signed for this application and that has not expired. */
export async function verifyAccessJwt(
  token: string | null | undefined,
  config: AccessConfig,
  now: number,
  fetchKeys: FetchKeys = fetchAccessKeys,
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  const signature = base64UrlToBytes(signaturePart);
  if (!header || !payload || !signature) return false;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;

  const key = await keyFor(config.teamDomain, header.kid, now, fetchKeys);
  if (!key) return false;
  try {
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed))) return false;
  } catch {
    return false;
  }

  const seconds = Math.floor(now / 1000);
  const { aud, iss, exp, nbf } = payload;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(config.aud)) return false;
  if (iss !== `https://${config.teamDomain}`) return false;
  if (typeof exp !== 'number' || exp + LEEWAY_SECONDS < seconds) return false;
  if (typeof nbf === 'number' && nbf - LEEWAY_SECONDS > seconds) return false;
  return true;
}
