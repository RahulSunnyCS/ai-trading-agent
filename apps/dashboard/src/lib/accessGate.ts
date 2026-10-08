/**
 * Access gate for a remotely served dashboard (see docs/remote-dashboard.md).
 *
 * Two independent jobs, both read from env per request so tests can vary them:
 *  1. Password gate — DASHBOARD_PASSWORD, proven either by the session cookie
 *     the /login page issues (lib/session.ts) or by Basic auth (username
 *     ignored; what curl and scripts use). Fails closed: once the dashboard
 *     is reachable remotely (production build, or upstream service-token vars
 *     set) a missing password blocks every request instead of serving openly.
 *     Plain local `next dev` stays open, as it always was.
 *  2. Upstream headers — the Cloudflare Access service token that lets the
 *     Next server's rewrites through the tunnel to the laptop-served APIs.
 *     Any client-supplied copies are always stripped so a browser can never
 *     inject its own. Half a token (one var set, the other unset or blank) is
 *     a deployment mistake, not "no token": it also blocks every request, so
 *     the dashboard fails loudly instead of every API call failing upstream.
 *
 *  3. Cloudflare Access sign-in (optional) — ACCESS_TEAM_DOMAIN + ACCESS_AUD. When both are
 *     set the dashboard hostname is behind an Access application, a valid signed Access token
 *     (lib/cfAccess.ts) replaces the password gate, and DASHBOARD_PASSWORD is not used.
 *
 * This file holds the pure pieces (config, password check, redirect-target
 * validation, wrong-password backoff); middleware.ts wires them to requests.
 *
 * Runs in the edge middleware runtime: Web Crypto only, no node:crypto.
 */

import { ACCESS_COOKIE, ACCESS_JWT_HEADER, type AccessConfig, parseTeamDomain } from './cfAccess';
import { SESSION_COOKIE, withoutCookie } from './session';

export const PASSWORD_REALM = 'Trading Research';

/** What a browser is told when the deployment is broken. The reason goes to the server log only. */
export const UNAVAILABLE_MESSAGE = 'The dashboard is not available right now.';
export const PASSWORD_MISSING_REASON = 'DASHBOARD_PASSWORD not configured';

const UPSTREAM_ID_HEADER = 'cf-access-client-id';
const UPSTREAM_SECRET_HEADER = 'cf-access-client-secret';

type Env = Record<string, string | undefined>;

export interface GateConfig {
  /** The configured password, or null when unset/blank. */
  password: string | null;
  /** True when a missing password must block requests rather than allow them. */
  passwordRequired: boolean;
  upstream: { clientId: string; clientSecret: string } | null;
  /** Set when Cloudflare Access signs people in; then the password gate is not used. */
  access: AccessConfig | null;
  /** Why every request must be refused (a broken deployment), or null. */
  configError: string | null;
}

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function gateConfig(env: Env): GateConfig {
  const clientId = nonBlank(env.UPSTREAM_ACCESS_CLIENT_ID);
  const clientSecret = nonBlank(env.UPSTREAM_ACCESS_CLIENT_SECRET);
  const upstream = clientId && clientSecret ? { clientId, clientSecret } : null;
  const remote = env.NODE_ENV === 'production' || Boolean(clientId || clientSecret);
  const halfToken = Boolean(clientId) !== Boolean(clientSecret);

  const rawTeam = nonBlank(env.ACCESS_TEAM_DOMAIN);
  const aud = nonBlank(env.ACCESS_AUD);
  const teamDomain = rawTeam ? parseTeamDomain(rawTeam) : null;
  const access = teamDomain && aud ? { teamDomain, aud } : null;
  const accessError =
    Boolean(rawTeam) !== Boolean(aud)
      ? 'ACCESS_TEAM_DOMAIN and ACCESS_AUD must both be set (only one is)'
      : rawTeam && !teamDomain
        ? 'ACCESS_TEAM_DOMAIN must be a <team>.cloudflareaccess.com hostname'
        : null;

  return {
    // Not trimmed: a password is used exactly as configured.
    password: env.DASHBOARD_PASSWORD ? env.DASHBOARD_PASSWORD : null,
    passwordRequired: remote && !access,
    upstream,
    access,
    configError: halfToken
      ? 'UPSTREAM_ACCESS_CLIENT_ID and UPSTREAM_ACCESS_CLIENT_SECRET must both be set (only one is)'
      : accessError,
  };
}

/** Extracts the password from a `Basic base64(user:password)` header, or null. */
export function basicAuthPassword(header: string | null): string | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    const binary = atob(match[1]);
    decoded = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  return colon === -1 ? null : decoded.slice(colon + 1);
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time comparison; hashing first also hides the expected length. */
export async function passwordMatches(supplied: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(supplied), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export type GateDecision = { kind: 'allow' } | { kind: 'challenge' } | { kind: 'misconfigured' };

export async function checkPassword(
  authorization: string | null,
  config: GateConfig,
): Promise<GateDecision> {
  if (config.password === null) {
    return config.passwordRequired ? { kind: 'misconfigured' } : { kind: 'allow' };
  }
  const supplied = basicAuthPassword(authorization);
  if (supplied === null) return { kind: 'challenge' };
  return (await passwordMatches(supplied, config.password))
    ? { kind: 'allow' }
    : { kind: 'challenge' };
}

/**
 * Request headers to forward upstream: incoming headers minus any client-sent
 * Access credentials (and minus Authorization, the session cookie and the dashboard's own
 * Access token and cookie, which prove who is signed in to the dashboard and have no business
 * reaching the APIs), plus
 * the configured service token when set. Returns null when nothing needs changing.
 */
export function upstreamHeaders(incoming: Headers, config: GateConfig): Headers | null {
  const cookie = incoming.get('cookie');
  const hasSessionCookie = cookie?.includes(`${SESSION_COOKIE}=`) ?? false;
  const hasAccessCookie = cookie?.includes(`${ACCESS_COOKIE}=`) ?? false;
  const hasClientCopies =
    incoming.has(UPSTREAM_ID_HEADER) ||
    incoming.has(UPSTREAM_SECRET_HEADER) ||
    incoming.has('authorization') ||
    incoming.has(ACCESS_JWT_HEADER) ||
    hasSessionCookie ||
    hasAccessCookie;
  if (!hasClientCopies && !config.upstream) return null;
  const headers = new Headers(incoming);
  headers.delete(UPSTREAM_ID_HEADER);
  headers.delete(UPSTREAM_SECRET_HEADER);
  headers.delete('authorization');
  headers.delete(ACCESS_JWT_HEADER);
  if (cookie && (hasSessionCookie || hasAccessCookie)) {
    const rest = withoutCookie(withoutCookie(cookie, SESSION_COOKIE) ?? '', ACCESS_COOKIE);
    if (rest) headers.set('cookie', rest);
    else headers.delete('cookie');
  }
  if (config.upstream) {
    headers.set(UPSTREAM_ID_HEADER, config.upstream.clientId);
    headers.set(UPSTREAM_SECRET_HEADER, config.upstream.clientSecret);
  }
  return headers;
}

/** Paths Next rewrites to the APIs: these answer 401, never a redirect to an HTML page. */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith('/retrospection/');
}

/**
 * A state-changing API request another site's page started (CSRF): refused before anything
 * else, password or not. `Sec-Fetch-Site` decides when the browser sends it (only `cross-site`
 * is refused; same-site and `none` pass); otherwise an `Origin` whose host is not ours is
 * refused, `Origin: null` included. No header at all (curl, scripts) passes.
 */
export function isCrossSiteApiWrite(
  method: string,
  pathname: string,
  headers: Headers,
  requestHost: string,
): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (!isApiPath(pathname)) return false;
  const site = headers.get('sec-fetch-site');
  if (site !== null) return site.trim().toLowerCase() === 'cross-site';
  const origin = headers.get('origin');
  if (origin === null) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const ours = [headers.get('host'), headers.get('x-forwarded-host')?.split(',')[0], requestHost];
  return !ours.some((host) => host?.trim().toLowerCase() === originHost);
}

/** A browser navigating to a page: the only kind of request worth redirecting to /login. */
export function isPageRequest(method: string, pathname: string, accept: string | null): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (isApiPath(pathname)) return false;
  return accept?.toLowerCase().includes('text/html') ?? false;
}

/**
 * Where to go after login. Only a same-origin relative path survives: it must start with a
 * single `/`, hold no backslash (browsers read `/\host` as `//host`) or control character,
 * and still resolve to our own origin. Everything else, and the login/logout paths themselves,
 * becomes `/`.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || next.length > 2048) return '/';
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  for (let i = 0; i < next.length; i += 1) {
    const code = next.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return '/';
  }
  const base = 'http://dashboard.invalid';
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return '/';
  }
  if (url.origin !== base || !url.pathname.startsWith('/') || url.pathname.startsWith('//')) {
    return '/';
  }
  const first = url.pathname.split('/')[1];
  if (first === 'login' || first === 'logout') return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The bucket wrong passwords are counted under: the first `X-Forwarded-For` hop. */
export function clientIp(forwardedFor: string | null): string {
  const first = forwardedFor?.split(',')[0]?.trim();
  return first ? first.slice(0, 64) : 'unknown';
}

/**
 * Wrong-password backoff, per client IP.
 *
 * The store is a plain in-memory Map owned by the middleware module, so it is PER INSTANCE:
 * it resets on every restart or cold start, and edge/serverless instances do not share it. An
 * attacker spread over several instances, or one who can forge `X-Forwarded-For` because no
 * trusted proxy overwrites it, gets more guesses than the numbers below suggest. It slows
 * guessing; it is not a hard limit. The real defence is a long random password.
 */
export interface AttemptRecord {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}
export type AttemptStore = Map<string, AttemptRecord>;

export const BACKOFF = {
  /** Wrong passwords allowed before the first lockout. */
  threshold: 5,
  /** First lockout; each further wrong password doubles it. */
  baseLockMs: 60_000,
  maxLockMs: 15 * 60_000,
  /** A record with no failure for this long is forgotten. */
  forgetAfterMs: 60 * 60_000,
  /** Cap on tracked IPs; the least recently failing one is evicted first. */
  maxEntries: 2000,
} as const;

/** Seconds until this IP may try again; 0 when it is not locked out. */
export function lockoutSeconds(store: AttemptStore, ip: string, now: number): number {
  const record = store.get(ip);
  if (!record || record.lockedUntil <= now) return 0;
  return Math.ceil((record.lockedUntil - now) / 1000);
}

/** Counts one wrong password. Returns the lockout it caused in seconds, or 0. */
export function recordFailure(store: AttemptStore, ip: string, now: number): number {
  const previous = store.get(ip);
  const fresh = previous && now - previous.lastFailureAt <= BACKOFF.forgetAfterMs;
  const failures = (fresh ? previous.failures : 0) + 1;
  let lockedUntil = 0;
  if (failures >= BACKOFF.threshold) {
    const doublings = Math.min(failures - BACKOFF.threshold, 10);
    lockedUntil = now + Math.min(BACKOFF.baseLockMs * 2 ** doublings, BACKOFF.maxLockMs);
  }
  // Re-insert so Map order is least-recently-failing first, then trim from the front.
  store.delete(ip);
  store.set(ip, { failures, lastFailureAt: now, lockedUntil });
  while (store.size > BACKOFF.maxEntries) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
  return lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0;
}

/** A correct password clears the IP's count. */
export function clearFailures(store: AttemptStore, ip: string): void {
  store.delete(ip);
}
