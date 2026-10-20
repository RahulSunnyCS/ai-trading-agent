import type { APIRequestContext, BrowserContext } from 'playwright';

/**
 * AlgoTest's API host. Its web app calls it with the session cookies and the CSRF header below
 * (`docs/algotest-execution.md` §7); a call without the header answers 401 "Missing CSRF token".
 */
export const ALGOTEST_API = 'https://api.algotest.in';

/** The logged-in session's `csrf_access_token` cookie, the value the CSRF header carries. */
export async function csrfToken(context: BrowserContext): Promise<string> {
  const csrf = (await context.cookies(ALGOTEST_API)).find(
    (c) => c.name === 'csrf_access_token',
  )?.value;
  if (!csrf) throw new Error('no csrf_access_token cookie for the API: not logged in');
  return csrf;
}

/** `GET /strategies` straight from the API: the saved strategies, `{_id, name, ...}` each. */
export async function listViaApi(
  request: APIRequestContext,
  csrf: string,
  apiUrl: string = ALGOTEST_API,
): Promise<unknown> {
  const response = await request.get(`${apiUrl}/strategies`, {
    headers: { 'X-CSRF-TOKEN-ACCESS': csrf },
    failOnStatusCode: false,
    timeout: 20_000,
  });
  if (!response.ok()) throw new Error(`listing answered ${response.status()}`);
  return response.json();
}

/** `DELETE /strategy/<id>`, the web app's own call; `request` must carry the session's cookies. */
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
