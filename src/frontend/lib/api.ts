/**
 * Minimal typed HTTP GET helper for the dashboard frontend.
 *
 * Design constraints:
 *  - Dependency-free: uses the browser's built-in `fetch` global.
 *  - No assumptions about the response shape beyond valid JSON.
 *    Callers receive the parsed body and unwrap `{ data }` envelopes themselves.
 *  - Errors (network failures and non-2xx responses) are surfaced as a typed
 *    result object rather than thrown, so callers always handle the error path
 *    explicitly — no silent 404-as-success bugs.
 */

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Typed result for apiGet.
 *
 * We use a discriminated union (ok / not-ok) rather than a nullable `data`
 * field so TypeScript can narrow the type in both branches cleanly:
 *
 *   const result = await apiGet<MyType>('/api/foo');
 *   if (!result.ok) { console.error(result.error); return; }
 *   // result.data is now narrowed to MyType here
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Fetch a JSON endpoint with GET and return a typed result.
 *
 * @param path    Absolute path starting with `/` (e.g. `/api/trades`).
 *                In production this hits the same origin; in dev Vite proxies
 *                `/api` and `/ws` to localhost:3000.
 * @param signal  Optional AbortSignal for request cancellation (e.g. from
 *                a React useEffect cleanup).
 *
 * Errors are never thrown — callers check `result.ok` instead.
 * This avoids unhandled-rejection footguns in React components.
 */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<ApiResult<T>> {
  try {
    // Only pass `signal` when defined: with exactOptionalPropertyTypes, fetch's
    // RequestInit.signal is `AbortSignal | null` and will not accept `undefined`.
    const response = await fetch(path, signal ? { signal } : undefined);

    // Surface HTTP errors explicitly.
    // We do NOT swallow 404/500 as "empty data" — the caller must decide how to
    // handle each status code.  A 404 from /api/trades is semantically different
    // from a 200 with an empty data array.
    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} ${response.statusText}`,
        status: response.status,
      };
    }

    // Parse the response body as JSON.  If the server returns malformed JSON
    // we catch that below and report it as an error rather than letting it
    // propagate as an unhandled exception.
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (err) {
    // AbortError is a normal cancellation — still surfaced as an error result
    // so the caller can check `result.error === 'AbortError'` and decide
    // whether to display anything (usually: do nothing on cleanup-abort).
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: 'AbortError' };
    }

    // Generic network failure (offline, DNS failure, CORS block, parse error).
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// POST helper
// ---------------------------------------------------------------------------

/**
 * Fetch a JSON endpoint with POST and return a typed result.
 *
 * @param path  Absolute path starting with `/` (e.g. `/api/backfill`).
 * @param body  Request body, serialised to JSON.
 *
 * Mirrors apiGet: errors are never thrown — callers check `result.ok`.
 */
export async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let errMsg = `HTTP ${response.status} ${response.statusText}`;
      try {
        const errBody = (await response.json()) as { error?: string };
        if (errBody.error) errMsg = errBody.error;
      } catch {
        // JSON parse failed — use the HTTP status message
      }
      return { ok: false, error: errMsg, status: response.status };
    }
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: 'AbortError' };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Convenience unwrap helper
// ---------------------------------------------------------------------------

/**
 * Unwrap the server's standard `{ data: T, message?: string }` envelope from
 * a raw parsed body.
 *
 * Use this AFTER a successful apiGet call when you know the server returns an
 * ApiEnvelope:
 *
 *   const result = await apiGet<ApiEnvelope<PaperTrade[]>>('/api/trades');
 *   if (!result.ok) { ... }
 *   const trades = unwrapData(result.data);
 *
 * Returns `null` when the envelope has `data: null` (e.g. the straddle stub).
 * This preserves the null vs empty-array distinction — callers decide how to
 * render each case.
 */
export function unwrapData<T>(envelope: { data: T; message?: string }): T {
  return envelope.data;
}
