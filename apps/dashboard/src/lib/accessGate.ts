/**
 * Access gate for a remotely served dashboard (see docs/remote-dashboard.md).
 *
 * Two independent jobs, both read from env per request so tests can vary them:
 *  1. Password gate — the browser's Basic-Auth prompt, checked against
 *     DASHBOARD_PASSWORD (username ignored). Fails closed: once the dashboard
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
 * Runs in the edge middleware runtime: Web Crypto only, no node:crypto.
 */

export const PASSWORD_REALM = 'Trading Research';

const UPSTREAM_ID_HEADER = 'cf-access-client-id';
const UPSTREAM_SECRET_HEADER = 'cf-access-client-secret';

type Env = Record<string, string | undefined>;

export interface GateConfig {
  /** The configured password, or null when unset/blank. */
  password: string | null;
  /** True when a missing password must block requests rather than allow them. */
  passwordRequired: boolean;
  upstream: { clientId: string; clientSecret: string } | null;
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
  return {
    // Not trimmed: a password is used exactly as configured.
    password: env.DASHBOARD_PASSWORD ? env.DASHBOARD_PASSWORD : null,
    passwordRequired: remote,
    upstream,
    configError: halfToken
      ? 'UPSTREAM_ACCESS_CLIENT_ID and UPSTREAM_ACCESS_CLIENT_SECRET must both be set (only one is)'
      : null,
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
 * Access credentials (and minus Authorization, which carries the dashboard
 * password and has no business reaching the APIs), plus the configured
 * service token when set. Returns null when nothing needs changing.
 */
export function upstreamHeaders(incoming: Headers, config: GateConfig): Headers | null {
  const hasClientCopies =
    incoming.has(UPSTREAM_ID_HEADER) ||
    incoming.has(UPSTREAM_SECRET_HEADER) ||
    incoming.has('authorization');
  if (!hasClientCopies && !config.upstream) return null;
  const headers = new Headers(incoming);
  headers.delete(UPSTREAM_ID_HEADER);
  headers.delete(UPSTREAM_SECRET_HEADER);
  headers.delete('authorization');
  if (config.upstream) {
    headers.set(UPSTREAM_ID_HEADER, config.upstream.clientId);
    headers.set(UPSTREAM_SECRET_HEADER, config.upstream.clientSecret);
  }
  return headers;
}
