import type { APIRequestContext } from 'playwright';
import { describe } from './diagnose.js';
import type { QAlgo, QLedgerRow } from './quantiply-plan.js';
import {
  type Execution,
  algotestAfter,
  names,
  parseExecutions,
  planAlgoTestStop,
  planQuantiplyStop,
  quantiplyLeft,
} from './stop-plan.js';

/**
 * BL-143 Phase 4: the stop button's calls, per platform, against injected clients, so the tests
 * run them against stand-in HTTP servers (`stop-run.test.ts`) and a dry run against a fixture.
 * `stop-button.ts` logs in and passes the real clients. Each executor never throws: whatever
 * happens is a line of its platform's report, and every call is a row in the stop log.
 */

export interface QStopApi {
  list(): Promise<QAlgo[]>;
  squareOffTerminate(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

export interface AStopApi {
  list(): Promise<Execution[]>;
  squareOff(id: string): Promise<void>;
}

export type StopLog = (row: Record<string, unknown>) => Promise<void>;

export interface Report {
  platform: string;
  /** everything of the tool's is squared off and switched off, as the platform shows it now */
  ok: boolean;
  lines: string[];
}

export interface Waits {
  /** how long to wait for squared-off positions to show closed */
  waitMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_WAITS: Waits = {
  waitMs: 90_000,
  pollMs: 5_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Poll `list` until `done` holds or the wait is over; the last list either way. */
async function until<T>(list: () => Promise<T>, done: (x: T) => boolean, w: Waits): Promise<T> {
  let last = await list();
  for (let waited = 0; !done(last) && waited < w.waitMs; waited += w.pollMs) {
    await w.sleep(w.pollMs);
    last = await list();
  }
  return last;
}

/**
 * One Quantiply account. Order: square off and terminate the tool's open algos, switch off its
 * enabled ones, wait for the squared-off ones to show finished and switch those off too, then list
 * again and report anything of the tool's still open or enabled as "by hand". `record` adds a row
 * to the account's deploy ledger (so the enabler leaves a stopped algo off today); it may fail.
 */
export async function stopQuantiply(
  platform: string,
  api: QStopApi,
  ledger: QLedgerRow[],
  log: StopLog,
  opts: {
    dryRun: boolean;
    waits?: Waits;
    record?: (row: Record<string, unknown>) => Promise<void>;
  },
): Promise<Report> {
  const w = opts.waits ?? DEFAULT_WAITS;
  const lines: string[] = [];
  let ok = true;
  try {
    const before = await api.list();
    const plan = planQuantiplyStop(ledger, before);
    await log({ platform, step: 'plan', sqOff: names(plan.sqOff), disable: names(plan.disable) });
    if (opts.dryRun) {
      lines.push(
        plan.sqOff.length
          ? `would square off & terminate: ${names(plan.sqOff)}`
          : "nothing of the tool's open",
      );
      if (plan.disable.length) lines.push(`would switch off: ${names(plan.disable)}`);
      if (plan.byHand.length)
        lines.push(`⚠️ by hand (status unknown to the tool): ${names(plan.byHand)}`);
      if (plan.notMine.length) lines.push(`not the tool's, left alone: ${names(plan.notMine)}`);
      return { platform, ok: plan.byHand.length === 0, lines };
    }
    const sent: QAlgo[] = [];
    for (const a of plan.sqOff) {
      try {
        await api.squareOffTerminate(a.id);
        sent.push(a);
        await log({ platform, step: 'sq_off_terminate', id: a.id, name: a.name, ok: true });
        await opts.record?.({ action: 'sqoff', id: a.id, name: a.name, ok: true });
      } catch (error) {
        ok = false;
        lines.push(`❌ square off failed: ${a.name}: ${describe(error)}`);
        await log({
          platform,
          step: 'sq_off_terminate',
          id: a.id,
          name: a.name,
          ok: false,
          detail: describe(error),
        });
      }
    }
    const switchOff = async (a: QAlgo) => {
      try {
        await api.setEnabled(a.id, false);
        await log({ platform, step: 'disable', id: a.id, name: a.name, ok: true });
        await opts.record?.({ action: 'disable', id: a.id, name: a.name, ok: true });
        return true;
      } catch (error) {
        ok = false;
        lines.push(`❌ switch off failed: ${a.name}: ${describe(error)}`);
        await log({
          platform,
          step: 'disable',
          id: a.id,
          name: a.name,
          ok: false,
          detail: describe(error),
        });
        await opts.record?.({
          action: 'disable',
          id: a.id,
          name: a.name,
          ok: false,
          detail: describe(error),
        });
        return false;
      }
    };
    const off: string[] = [];
    for (const a of plan.disable) if (await switchOff(a)) off.push(a.name);

    // Squared-off algos: wait until Quantiply shows them finished, then switch them off.
    let after = await api.list();
    if (sent.length) {
      const ids = new Set(sent.map((a) => a.id));
      after = await until(
        () => api.list(),
        (xs) => !xs.some((x) => ids.has(x.id) && x.status === 'TRADE_ACTIVE'),
        w,
      );
      for (const a of after) {
        if (ids.has(a.id) && a.enabled && a.status !== 'TRADE_ACTIVE' && (await switchOff(a)))
          off.push(a.name);
      }
      after = await api.list();
    }
    const closed = sent.filter((a) => after.find((x) => x.id === a.id)?.status !== 'TRADE_ACTIVE');
    if (closed.length) lines.push(`✅ squared off & terminated: ${names(closed)}`);
    if (off.length) lines.push(`✅ switched off: ${off.join(', ')}`);
    const left = quantiplyLeft(ledger, after);
    for (const l of left) lines.push(`⚠️ ${l}`);
    if (left.length) ok = false;
    if (plan.byHand.length) {
      ok = false;
      lines.push(`⚠️ by hand (status unknown to the tool): ${names(plan.byHand)}`);
    }
    if (plan.notMine.length) lines.push(`not the tool's, left alone: ${names(plan.notMine)}`);
    if (!lines.length) lines.push("nothing of the tool's open or enabled");
    await log({ platform, step: 'done', ok, left });
  } catch (error) {
    ok = false;
    lines.push(`❌ ${describe(error)}: check Quantiply by hand`);
    await log({ platform, step: 'error', ok: false, detail: describe(error) });
  }
  return { platform, ok, lines };
}

/** AlgoTest /live: square off every running deploy of the tool's, then confirm by listing. */
export async function stopAlgoTest(
  api: AStopApi,
  log: StopLog,
  opts: { dryRun: boolean; waits?: Waits },
): Promise<Report> {
  const platform = 'AlgoTest';
  const w = opts.waits ?? DEFAULT_WAITS;
  const lines: string[] = [];
  let ok = true;
  try {
    const before = await api.list();
    const plan = planAlgoTestStop(before);
    await log({
      platform,
      step: 'plan',
      squareOff: names(plan.squareOff),
      byHand: names(plan.byHand),
    });
    if (opts.dryRun) {
      lines.push(
        plan.squareOff.length
          ? `would square off: ${names(plan.squareOff)}`
          : "nothing of the tool's running on /live",
      );
    } else {
      const sent: Execution[] = [];
      for (const e of plan.squareOff) {
        try {
          await api.squareOff(e.id);
          sent.push(e);
          await log({ platform, step: 'square_off', id: e.id, name: e.name, ok: true });
        } catch (error) {
          ok = false;
          lines.push(`❌ square off failed: ${e.name}: ${describe(error)}`);
          await log({
            platform,
            step: 'square_off',
            id: e.id,
            name: e.name,
            ok: false,
            detail: describe(error),
          });
        }
      }
      if (sent.length) {
        const after = await until(
          () => api.list(),
          (xs) => algotestAfter(sent, xs).pending.length === 0,
          w,
        );
        const r = algotestAfter(sent, after);
        if (r.confirmed.length) lines.push(`✅ squared off: ${r.confirmed.join(', ')}`);
        if (r.pending.length) {
          ok = false;
          lines.push(
            `⚠️ square off sent, not shown done yet (check /live): ${r.pending.join(', ')}`,
          );
        }
        for (const b of r.byHand) lines.push(`⚠️ ${b}`);
        if (r.byHand.length) ok = false;
        await log({
          platform,
          step: 'done',
          confirmed: r.confirmed,
          pending: r.pending,
          byHand: r.byHand,
        });
      } else if (!plan.squareOff.length) lines.push("nothing of the tool's running on /live");
    }
    if (plan.byHand.length) {
      ok = false;
      lines.push(
        `⚠️ square off by hand (AlgoTest offers no square-off for it now): ${plan.byHand.map((e) => `${e.name} (${e.status}${e.activeOnServer ? '' : ', not active on server'})`).join(', ')}`,
      );
    }
    if (plan.notMine.length) lines.push(`not the tool's, left running: ${names(plan.notMine)}`);
  } catch (error) {
    ok = false;
    lines.push(`❌ ${describe(error)}: check algotest.in/live by hand`);
    await log({ platform, step: 'error', ok: false, detail: describe(error) });
  }
  return { platform, ok, lines };
}

/** A minimal HTTP call, so AlgoTest's client runs over Playwright's request context or `fetch`. */
export type Http = (
  method: 'GET' | 'PUT',
  path: string,
) => Promise<{ status: number; body: unknown }>;

const EXECUTION_ID = /^[0-9a-f]{24}$/i;

/**
 * AlgoTest's own calls (its web app's `/execution` client, read from its public bundle
 * 2026-10-20; `docs/algotest-execution.md` §7): the live list and the per-deploy square-off.
 */
export function algotestStopApi(http: Http): AStopApi {
  return {
    async list() {
      const r = await http('GET', '/execution/v2/executions?environment=live');
      if (r.status < 200 || r.status > 299) throw new Error(`live list answered ${r.status}`);
      return parseExecutions(r.body);
    },
    async squareOff(id) {
      if (!EXECUTION_ID.test(id)) throw new Error(`not an execution id: ${JSON.stringify(id)}`);
      const r = await http('PUT', `/execution/v2/square-off/${id}`);
      if (r.status < 200 || r.status > 299) {
        const msg = (r.body as { msg?: unknown; detail?: unknown } | null)?.msg ?? '';
        throw new Error(`square off answered ${r.status} ${String(msg).slice(0, 200)}`);
      }
    },
  };
}

/**
 * `Http` over Playwright's request context of a logged-in AlgoTest browser: its cookies plus the
 * CSRF header the web app sends (`strategy-delete.ts` does the same for deletes).
 */
export function playwrightHttp(request: APIRequestContext, csrf: string, apiUrl: string): Http {
  return async (method, path) => {
    const response = await request.fetch(`${apiUrl}${path}`, {
      method,
      headers: { 'X-CSRF-TOKEN-ACCESS': csrf },
      failOnStatusCode: false,
      timeout: 20_000,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // not JSON: the status says enough
    }
    return { status: response.status(), body };
  };
}

/** For `--dry-run --fixture`: lists from a file, and every write refused. */
export function fixtureApis(fixture: {
  quantiply?: Record<string, QAlgo[]>;
  algotest?: unknown;
}): { quantiply: (broker: string) => QStopApi | null; algotest: AStopApi | null } {
  const refuse = async () => {
    throw new Error('dry run: no call is ever sent');
  };
  return {
    quantiply: (broker) => {
      const list = fixture.quantiply?.[broker];
      return list
        ? { list: async () => list, squareOffTerminate: refuse, setEnabled: refuse }
        : null;
    },
    algotest:
      fixture.algotest === undefined
        ? null
        : { list: async () => parseExecutions(fixture.algotest), squareOff: refuse },
  };
}
