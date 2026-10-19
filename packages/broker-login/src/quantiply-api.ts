import type { Page } from 'playwright';
import { type QAlgo, parseDayWise } from './quantiply-plan.js';
import { QUANTIPLY_SITES, type QuantiplySite } from './quantiply-rules.js';

/**
 * Quantiply's own API, as its web app calls it (BL-139; `docs/algotest-execution.md`, "Quantiply
 * algos through its API"). The token is the JWT the web app keeps after the Angel One login; it
 * is a live credential to the owner's algos: callers register it as a secret, and nothing here
 * logs it or puts it in an error.
 */

/** Angel One's site; `QuantiplyApi` and `readToken` take the site of the row they serve. */
export const QUANTIPLY_API = QUANTIPLY_SITES.angelone.apiOrigin;
/** Where the web app keeps its session, in local storage on the app's origin. */
export const STORAGE_KEY = 'quantiply-dashboard-local';

/** The JWT from a logged-in browser context (any page on the app's origin will do). */
export async function readToken(
  page: Page,
  site: QuantiplySite = QUANTIPLY_SITES.angelone,
): Promise<string> {
  const appOrigin = `https://${site.appHost}`;
  if (new URL(page.url()).origin !== appOrigin) {
    await page.goto(`${appOrigin}/algos`, { waitUntil: 'domcontentloaded' });
  }
  const token = await page.evaluate((key) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '{}') as { token?: unknown };
      return typeof value.token === 'string' ? value.token : '';
    } catch {
      return '';
    }
  }, STORAGE_KEY);
  if (!token) throw new Error(`no Quantiply token in local storage (${STORAGE_KEY})`);
  return token;
}

export interface Saved {
  id: string;
  day: string;
  name: string;
}

export class QuantiplyApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly site: QuantiplySite = QUANTIPLY_SITES.angelone,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const appOrigin = `https://${this.site.appHost}`;
    const response = await this.fetchImpl(`${this.site.apiOrigin}${path}`, {
      method,
      headers: {
        Accept: 'application/json, text/plain, */*',
        authorization: `Bearer ${this.token}`,
        Origin: appOrigin,
        Referer: `${appOrigin}/`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json: { status?: unknown; message?: unknown } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON: reported below with the status
    }
    const message = typeof json?.message === 'string' ? json.message.slice(0, 200) : '';
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status} ${message}`);
    if (json?.status !== 'success') {
      throw new Error(`${method} ${path}: unexpected answer (${message || text.slice(0, 80)})`);
    }
    return json;
  }

  async list(): Promise<QAlgo[]> {
    return parseDayWise(await this.call('GET', '/algos/day-wise'));
  }

  /** `POST /algos`: Quantiply makes one algo per weekday in `body.day`. */
  async create(body: unknown): Promise<Saved[]> {
    const json = (await this.call('POST', '/algos', body)) as { data?: unknown };
    if (!Array.isArray(json.data) || !json.data.length) throw new Error('create: no algo returned');
    return (json.data as Record<string, unknown>[]).map((a) => {
      if (typeof a._id !== 'string') throw new Error('create: an algo without _id');
      return { id: a._id, day: String(a.day), name: String(a.name) };
    });
  }

  /** `GET /algos/:id`: the saved algo, configuration included (the read-back). */
  async get(id: string): Promise<Record<string, unknown>> {
    const json = (await this.call('GET', `/algos/${encodeURIComponent(id)}`)) as { data?: unknown };
    const data = Array.isArray(json.data) ? json.data[0] : json.data;
    if (!data || typeof data !== 'object') throw new Error(`get ${id}: no algo returned`);
    return data as Record<string, unknown>;
  }

  /** `DELETE /algos/:id`: one weekday's algo. */
  async remove(id: string): Promise<void> {
    await this.call('DELETE', `/algos/${encodeURIComponent(id)}`);
  }
}
