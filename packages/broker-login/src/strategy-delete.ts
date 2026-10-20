import type { APIRequestContext } from 'playwright';

/** AlgoTest's API host (the web app's axios client: cookies plus the CSRF header below). */
export const ALGOTEST_API = 'https://api.algotest.in';

/**
 * Delete one saved strategy by its id, the call AlgoTest's own web app makes (its bundle:
 * `SP.delete("/strategy/" + id)`, an axios client with `withCredentials` and
 * `xsrfCookieName: "csrf_access_token"`, `xsrfHeaderName: "X-CSRF-TOKEN-ACCESS"`; read 2026-10-20).
 * `request` must carry the logged-in session's cookies (a Playwright page's `page.request`).
 */
export async function deleteStrategyById(
  request: APIRequestContext,
  id: string,
  csrf: string,
  apiUrl: string = ALGOTEST_API,
): Promise<void> {
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new Error(`not a strategy id: ${JSON.stringify(id)}`);
  const response = await request.delete(`${apiUrl}/strategy/${id}`, {
    headers: { 'X-CSRF-TOKEN-ACCESS': csrf },
    failOnStatusCode: false,
    timeout: 20_000,
  });
  if (!response.ok()) throw new Error(`delete answered ${response.status()}`);
}

/** The ids a listing held, minus `gone`, that are missing afterwards: each must still be there. */
export function vanished(before: string[], after: string[], gone: string): string[] {
  const now = new Set(after);
  return before.filter((id) => id !== gone && !now.has(id));
}
