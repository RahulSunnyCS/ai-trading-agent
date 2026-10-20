import type { Page } from 'playwright';
import { type QAlgo, parseDayWise } from './quantiply-plan.js';
import { QUANTIPLY_SITES, type QuantiplySite } from './quantiply-rules.js';

/**
 * Quantiply's own API, as its web app calls it (BL-139; `docs/algotest-execution.md`, "Quantiply
 * algos through its API"). The token is the JWT the web app keeps after the Angel One login; it
 * is a live credential to the owner's algos: callers register it as a secret, and nothing here
 * logs it or puts it in an error.
 */

/**
 * A call the server answered with an HTTP error status. A 4xx is a definite refusal (nothing was
 * done); a 5xx, a timeout or a network error may have reached the server with only the answer
 * lost (BL-143: a square-off that "may have been sent").
 */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A call refused before it was sent (a bad id): nothing reached the platform. */
export class NotSentError extends Error {}

/** True only for a definite refusal (a 4xx, or never sent): the call did nothing. */
export function definitelyRefused(error: unknown): boolean {
  if (error instanceof NotSentError) return true;
  return error instanceof HttpStatusError && error.status >= 400 && error.status < 500;
}

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

  /**
   * `lenient`: any 2xx counts as sent, whatever the JSON says. Only for a call whose answer the
   * web app itself does not read (the square-off): the caller confirms by listing again.
   */
  private async call(
    method: string,
    path: string,
    body?: unknown,
    opts: { lenient?: boolean } = {},
  ): Promise<unknown> {
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
    if (!response.ok)
      throw new HttpStatusError(
        response.status,
        `${method} ${path} answered ${response.status} ${message}`,
      );
    if (opts.lenient) return json;
    if (json?.status !== 'success') {
      throw new Error(`${method} ${path}: unexpected answer (${message || text.slice(0, 80)})`);
    }
    return json;
  }

  async list(): Promise<QAlgo[]> {
    return parseDayWise(await this.call('GET', '/algos/day-wise'));
  }

  /** `GET /algos/day-wise` as it answers (BL-141's capture reads `multiplier` and `pnl` too). */
  async dayWise(): Promise<unknown> {
    return this.call('GET', '/algos/day-wise');
  }

  /**
   * `GET /pnl-chart/algo?graphLevel=account&from=D&to=D`, every page (`paging.after`): the web
   * app's P&L chart for the account. Its `metaData.lastValues` holds each algo's closing MTM for
   * the period (BL-141; `docs/algotest-execution.md`, "Live results"). Read-only.
   */
  async pnlChartAccount(day: string): Promise<unknown[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a day: ${day}`);
    const pages: unknown[] = [];
    let after: string | null = null;
    for (let n = 0; n < 20; n += 1) {
      const query = `?graphLevel=account&from=${day}&to=${day}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const page = (await this.call('GET', `/pnl-chart/algo${query}`)) as {
        paging?: { after?: unknown };
      };
      pages.push(page);
      const raw = page.paging?.after;
      const next = typeof raw === 'number' ? String(raw) : raw;
      if (typeof next !== 'string' || !next || next === after) return pages;
      after = next;
    }
    throw new Error('pnl chart: more than 20 pages');
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

  /** `GET /brokers`: the broker accounts linked to this Quantiply login (read-only). */
  async brokers(): Promise<unknown> {
    return this.call('GET', '/brokers');
  }

  /**
   * `PUT /algos/:id/enable` or `/disable`, no body: the web app's row switch (`toggleAlgo`,
   * read from its bundle 2026-10-20). Enabled = deployed on the algo's weekday, every week until
   * disabled. The app counts `status: "success"` as done, as `call` does.
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.call('PUT', `/algos/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`);
  }

  /** `PUT /algos/:id` with `{broker}`: the web app's "Select Client ID / Broker" (`updateBroker`). */
  async setBroker(id: string, broker: string): Promise<void> {
    await this.call('PUT', `/algos/${encodeURIComponent(id)}`, { broker });
  }

  /**
   * `PUT /algos/:id/action/SQ_OFF_TERMINATE`, no body: the web app's "Square off all positions &
   * Terminate algo" (`sqOffAll`, read from its bundle 2026-10-20; shown only for `TRADE_ACTIVE`).
   * Quantiply closes the algo's open positions itself and stops managing it. REAL ORDERS: only the
   * stop button (`stop-button.ts --apply`) calls it. The app does not read the answer; neither does
   * this (any 2xx): the caller lists again to confirm.
   */
  async squareOffTerminate(id: string): Promise<void> {
    await this.call('PUT', `/algos/${encodeURIComponent(id)}/action/SQ_OFF_TERMINATE`, undefined, {
      lenient: true,
    });
  }
}
