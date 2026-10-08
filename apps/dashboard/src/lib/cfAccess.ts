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
  fetchedAt: number;
}
const caches = new Map<string, KeyCache>();

/** Forgets cached keys; tests use it, nothing else needs to. */
export function resetAccessKeyCache(): void {
  caches.clear();
}

async function keyFor(
  teamDomain: string,
  kid: string,
  now: number,
  fetchKeys: FetchKeys,
): Promise<Jwk | null> {
  const cached = caches.get(teamDomain);
  const hit = cached?.keys.find((key) => key.kid === kid);
  if (hit && cached && now - cached.fetchedAt < KEYS_TTL_MS) return hit;
  if (cached && now - cached.fetchedAt < KEYS_MIN_REFETCH_MS) return null;
  const keys = await fetchKeys(teamDomain);
  caches.set(teamDomain, { keys, fetchedAt: now });
  return keys.find((key) => key.kid === kid) ?? null;
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

  let jwk: Jwk | null;
  try {
    jwk = await keyFor(config.teamDomain, header.kid, now, fetchKeys);
  } catch {
    return false;
  }
  if (!jwk || jwk.kty !== 'RSA') return false;

  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
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
