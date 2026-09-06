import type { FastifyRequest } from 'fastify';

export interface GeolocationResult {
  country: string | null;
  isIndia: boolean;
  confidence: 'high' | 'low' | 'unknown';
}

// ip-api.com response shape for the fields we request
interface IpApiResponse {
  status: string;
  country: string;
  countryCode: string;
}

// In-process cache: ip → { result, expiresAt }.
// ip-api.com free tier is 45 req/min; caching prevents exhaustion on repeated
// page loads from the same IP and reduces tail latency from the external call.
// TTL is 15 minutes — IP-to-country mapping is stable over this window.
const CACHE_TTL_MS = 15 * 60 * 1_000;
const _geoCache = new Map<string, { result: GeolocationResult; expiresAt: number }>();

// Only IPv4 and IPv6 characters are valid — guard against path injection into
// the URL before interpolation. ip-api.com rejects malformed IPs anyway, but
// defence-in-depth prevents even cosmetic log noise from injected path segments.
const SAFE_IP_RE = /^[\d.:a-fA-F]+$/;

/**
 * Resolves the country for a given IP address by calling ip-api.com (or the
 * URL override in GEOLOCATION_API_URL). Used solely to decide whether to show
 * the UPI payment option on the frontend — it is NOT a security or pricing gate.
 *
 * Results are cached for 15 minutes per IP to stay within the free-tier rate
 * limit (45 req/min) and avoid blocking on the external HTTP call for repeat visitors.
 *
 * The fetchFn parameter exists so unit tests can inject a mock without making
 * real network calls. Passing a stub avoids flaky tests that depend on external
 * API availability and lets us exercise every code path (success, timeout,
 * malformed JSON, non-200) deterministically.
 */
export async function getClientCountry(
  ip: string,
  fetchFn: typeof fetch = fetch,
): Promise<GeolocationResult> {
  // Validate IP format before URL interpolation (defence-in-depth).
  const safeIp = SAFE_IP_RE.test(ip) ? ip : '0.0.0.0';

  // Return cached result if still fresh.
  const cached = _geoCache.get(safeIp);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  // Use || not ?? so an empty-string env var falls back to the default correctly.
  const baseUrl = process.env.GEOLOCATION_API_URL || 'https://ip-api.com/json';
  const url = `${baseUrl}/${safeIp}?fields=status,country,countryCode`;

  // Abort the request after 5 seconds to avoid blocking the response
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);

  const unknown: GeolocationResult = { country: null, isIndia: false, confidence: 'unknown' };

  try {
    const response = await fetchFn(url, { signal: controller.signal });

    if (!response.ok) {
      _geoCache.set(safeIp, { result: unknown, expiresAt: Date.now() + CACHE_TTL_MS });
      return unknown;
    }

    // Parse and validate the response; treat any shape mismatch as unknown
    const data: unknown = await response.json();

    if (
      data === null ||
      typeof data !== 'object' ||
      !('status' in data) ||
      !('country' in data) ||
      !('countryCode' in data)
    ) {
      _geoCache.set(safeIp, { result: unknown, expiresAt: Date.now() + CACHE_TTL_MS });
      return unknown;
    }

    const typed = data as IpApiResponse;

    if (typed.status !== 'success') {
      _geoCache.set(safeIp, { result: unknown, expiresAt: Date.now() + CACHE_TTL_MS });
      return unknown;
    }

    // Validate that countryCode looks like an ISO 3166-1 alpha-2 code (2 letters)
    if (typeof typed.countryCode !== 'string' || !/^[A-Z]{2}$/.test(typed.countryCode)) {
      _geoCache.set(safeIp, { result: unknown, expiresAt: Date.now() + CACHE_TTL_MS });
      return unknown;
    }

    const result: GeolocationResult = {
      country: typed.country,
      isIndia: typed.countryCode === 'IN',
      confidence: 'high',
    };
    _geoCache.set(safeIp, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch {
    // Catches network errors, AbortError (timeout), and JSON parse failures.
    // We never let a geolocation failure propagate — the caller should degrade
    // gracefully and simply not show the UPI option.
    // Cache failed lookups briefly (same TTL) to avoid hammering ip-api.com on errors.
    _geoCache.set(safeIp, { result: unknown, expiresAt: Date.now() + CACHE_TTL_MS });
    return unknown;
  } finally {
    clearTimeout(timeoutId);
  }
}

// trustProxy must be set to the number of known proxy hops (e.g. 1 for Railway/Fly.io)
// in the Fastify instance config. Misconfiguring trustProxy is a geolocation spoofing risk
// (cosmetic only — IP is not used for pricing decisions, only to display the UPI option).
//
// We rely entirely on Fastify's built-in proxy-trust resolution rather than reading
// X-Forwarded-For ourselves. Reading X-Forwarded-For directly would allow any client
// to inject arbitrary IPs into that header and spoof their location — Fastify's
// trustProxy handles the hop-count logic correctly when configured.
export function extractClientIp(request: FastifyRequest): string {
  const ip = request.ip;

  // request.ip is set by Fastify after resolving the correct proxy hop.
  // If somehow it is missing (misconfigured Fastify, test stub), fall back
  // to a safe, non-routable sentinel rather than crashing or returning undefined.
  if (!ip) {
    return '0.0.0.0';
  }

  return ip;
}
