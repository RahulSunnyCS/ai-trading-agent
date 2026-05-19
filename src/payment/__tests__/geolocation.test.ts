/**
 * Unit tests for src/payment/geolocation.ts
 *
 * getClientCountry() accepts an injectable fetchFn so we never make real
 * network calls. Each describe block that exercises the cache resets the
 * module (vi.resetModules) so the in-process Map starts empty.
 */

import type { FastifyRequest } from 'fastify';
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fetch stub. Returns the mock function directly (typed as MockInstance)
 * so callers can inspect .mock.calls, and the same reference cast to `typeof fetch`
 * for passing to getClientCountry().
 */
function buildFetchStub(
  json: unknown,
  ok = true,
  _status = 200,
): MockInstance & { asFetch: typeof fetch } {
  const mock = vi.fn().mockResolvedValue({
    ok,
    status: _status,
    json: vi.fn().mockResolvedValue(json),
  });
  (mock as unknown as { asFetch: typeof fetch }).asFetch = mock as unknown as typeof fetch;
  return mock as unknown as MockInstance & { asFetch: typeof fetch };
}

/** Build a fetch stub that rejects (network error). */
function buildFetchError(error: Error): MockInstance & { asFetch: typeof fetch } {
  const mock = vi.fn().mockRejectedValue(error);
  (mock as unknown as { asFetch: typeof fetch }).asFetch = mock as unknown as typeof fetch;
  return mock as unknown as MockInstance & { asFetch: typeof fetch };
}

/** Extract the URL string from the first call to a fetchFn mock (non-null asserted). */
function firstCalledUrl(mock: MockInstance): string {
  const firstCall = mock.mock.calls[0];
  if (firstCall === undefined) {
    throw new Error('fetchFn was never called');
  }
  const url = firstCall[0];
  if (typeof url !== 'string') {
    throw new Error(`Expected first argument to be a string, got ${typeof url}`);
  }
  return url;
}

/** ip-api.com success payload for India */
const INDIA_PAYLOAD = { status: 'success', country: 'India', countryCode: 'IN' };
/** ip-api.com success payload for USA */
const USA_PAYLOAD = { status: 'success', country: 'United States', countryCode: 'US' };

// ---------------------------------------------------------------------------
// getClientCountry
// ---------------------------------------------------------------------------

describe('getClientCountry()', () => {
  // Reset the module before each test so the internal _geoCache Map is empty
  // and env overrides are clean.
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ---- Happy path ----

  it('should return {country: "India", isIndia: true, confidence: "high"} for an Indian IP', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchStub(INDIA_PAYLOAD);
    const result = await getClientCountry('1.2.3.4', stub.asFetch);
    expect(result).toEqual({ country: 'India', isIndia: true, confidence: 'high' });
  });

  it('should return {country: "United States", isIndia: false, confidence: "high"} for a US IP', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchStub(USA_PAYLOAD);
    const result = await getClientCountry('8.8.8.8', stub.asFetch);
    expect(result).toEqual({ country: 'United States', isIndia: false, confidence: 'high' });
  });

  // ---- Failure / degraded path ----

  it('should return the unknown sentinel when fetch throws a network error', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchError(new Error('network error'));
    const result = await getClientCountry('1.2.3.4', stub.asFetch);
    expect(result).toEqual({ country: null, isIndia: false, confidence: 'unknown' });
  });

  it('should not throw when fetch throws — returns unknown sentinel', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchError(new Error('network error'));
    await expect(getClientCountry('1.2.3.4', stub.asFetch)).resolves.toBeDefined();
  });

  it('should return unknown when HTTP response is non-200', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchStub({}, false, 429);
    const result = await getClientCountry('1.2.3.4', stub.asFetch);
    expect(result).toEqual({ country: null, isIndia: false, confidence: 'unknown' });
  });

  it('should return unknown when response JSON status is not "success"', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const payload = { status: 'fail', country: '', countryCode: '' };
    const stub = buildFetchStub(payload);
    const result = await getClientCountry('1.2.3.4', stub.asFetch);
    expect(result).toEqual({ country: null, isIndia: false, confidence: 'unknown' });
  });

  it('should return unknown when response JSON is missing required fields', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchStub({ message: 'unexpected format' });
    const result = await getClientCountry('1.2.3.4', stub.asFetch);
    expect(result).toEqual({ country: null, isIndia: false, confidence: 'unknown' });
  });

  it('should return unknown when response JSON is null', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchStub(null);
    const result = await getClientCountry('1.2.3.4', stub.asFetch);
    expect(result).toEqual({ country: null, isIndia: false, confidence: 'unknown' });
  });

  it('should return unknown when countryCode is not a 2-letter uppercase string', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const payload = { status: 'success', country: 'Testland', countryCode: 'INVALID' };
    const stub = buildFetchStub(payload);
    const result = await getClientCountry('1.2.3.4', stub.asFetch);
    expect(result).toEqual({ country: null, isIndia: false, confidence: 'unknown' });
  });

  it('should return unknown on timeout (AbortError simulated via fetch rejection)', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    // The AbortController fires after 5s; we simulate by rejecting with an AbortError.
    // The catch block handles all thrown errors uniformly, including AbortError.
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const stub = buildFetchError(abortError as unknown as Error);
    const result = await getClientCountry('1.2.3.4', stub.asFetch);
    expect(result).toEqual({ country: null, isIndia: false, confidence: 'unknown' });
  });

  // ---- Base URL / env override ----

  it('should use GEOLOCATION_API_URL env var as the base URL when set', async () => {
    vi.stubEnv('GEOLOCATION_API_URL', 'https://custom-geo.example.com/json');
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchStub(INDIA_PAYLOAD);
    await getClientCountry('1.2.3.4', stub.asFetch);
    expect(firstCalledUrl(stub)).toContain('https://custom-geo.example.com/json');
  });

  it('should fall back to https://ip-api.com/json when GEOLOCATION_API_URL is not set', async () => {
    // The implementation uses ??, which only falls back for null/undefined — NOT ''.
    // process.env.X = undefined coerces to the string "undefined" in Node.js.
    // We must use delete to achieve genuine key absence, which triggers the ?? fallback.
    const original = process.env.GEOLOCATION_API_URL;
    // biome-ignore lint/performance/noDelete: delete is required to make process.env.X genuinely absent
    delete process.env.GEOLOCATION_API_URL;

    try {
      const { getClientCountry } = await import('../geolocation.ts');
      const stub = buildFetchStub(INDIA_PAYLOAD);
      await getClientCountry('1.2.3.4', stub.asFetch);
      expect(firstCalledUrl(stub)).toContain('https://ip-api.com/json');
    } finally {
      if (original !== undefined) {
        process.env.GEOLOCATION_API_URL = original;
      }
    }
  });

  it('should embed the IP in the request URL', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchStub(INDIA_PAYLOAD);
    await getClientCountry('203.0.113.42', stub.asFetch);
    expect(firstCalledUrl(stub)).toContain('203.0.113.42');
  });

  // ---- Caching ----

  it('should cache the result for the same IP so fetchFn is called only once', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchStub(INDIA_PAYLOAD);
    await getClientCountry('1.2.3.4', stub.asFetch);
    await getClientCountry('1.2.3.4', stub.asFetch);
    expect(stub.mock.calls.length).toBe(1);
  });

  it('should return the cached result on a second call for the same IP', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchStub(INDIA_PAYLOAD);
    const first = await getClientCountry('1.2.3.4', stub.asFetch);
    const second = await getClientCountry('1.2.3.4', stub.asFetch);
    expect(second).toEqual(first);
  });

  it('should maintain separate cache entries for different IPs', async () => {
    const { getClientCountry } = await import('../geolocation.ts');

    const indiaStub = buildFetchStub(INDIA_PAYLOAD);
    const usaStub = buildFetchStub(USA_PAYLOAD);

    const indiaResult = await getClientCountry('1.2.3.4', indiaStub.asFetch);
    const usaResult = await getClientCountry('8.8.8.8', usaStub.asFetch);

    expect(indiaResult.isIndia).toBe(true);
    expect(usaResult.isIndia).toBe(false);

    // Each fetch was called exactly once for its respective IP
    expect(indiaStub.mock.calls.length).toBe(1);
    expect(usaStub.mock.calls.length).toBe(1);
  });

  // ---- Adversarial / injection guard ----

  it('should sanitise a path-injection attempt in the IP (replaces with 0.0.0.0)', async () => {
    const { getClientCountry } = await import('../geolocation.ts');
    const stub = buildFetchStub(INDIA_PAYLOAD);
    // IP contains path-injection characters — impl sanitises to 0.0.0.0
    await getClientCountry('../../etc/passwd', stub.asFetch);
    const url = firstCalledUrl(stub);
    expect(url).toContain('0.0.0.0');
    expect(url).not.toContain('../');
  });
});

// ---------------------------------------------------------------------------
// extractClientIp
// ---------------------------------------------------------------------------

describe('extractClientIp()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should return request.ip when it is a valid string', async () => {
    const { extractClientIp } = await import('../geolocation.ts');
    const req = { ip: '203.0.113.42' } as FastifyRequest;
    expect(extractClientIp(req)).toBe('203.0.113.42');
  });

  it('should return "0.0.0.0" when request.ip is undefined', async () => {
    const { extractClientIp } = await import('../geolocation.ts');
    // Fastify's type says `ip` is string, but at runtime it can be absent
    // in a misconfigured test stub — cast through unknown to satisfy tsc.
    const req = { ip: undefined } as unknown as FastifyRequest;
    expect(extractClientIp(req)).toBe('0.0.0.0');
  });

  it('should return "0.0.0.0" when request.ip is an empty string', async () => {
    const { extractClientIp } = await import('../geolocation.ts');
    const req = { ip: '' } as unknown as FastifyRequest;
    expect(extractClientIp(req)).toBe('0.0.0.0');
  });

  it('should return an IPv6 address unchanged', async () => {
    const { extractClientIp } = await import('../geolocation.ts');
    const req = { ip: '2001:db8::1' } as FastifyRequest;
    expect(extractClientIp(req)).toBe('2001:db8::1');
  });
});
