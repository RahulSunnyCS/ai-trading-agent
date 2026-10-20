import type { APIRequestContext } from 'playwright';
import { describe } from './diagnose.js';
import type { QAlgo, QLedgerRow } from './quantiply-plan.js';
import {
  type Execution,
  Q_ACTIVE,
  algotestAfter,
  capped,
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
 *
 * Both work in bounded passes: list, act on what needs it and was not acted on yet, wait for
 * square-offs to show done, list again. An algo or deploy that entered between a list and a call
 * (the stop is most likely pressed right at an entry) is squared off on the next pass.
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
  /** how long to wait, each pass, for squared-off positions to show closed */
  waitMs: number;
  pollMs: number;
  /** how many list-and-act passes at most */
  passes: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_WAITS: Waits = {
  waitMs: 60_000,
  pollMs: 5_000,
  passes: 4,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** How many times a list call is tried before a platform's stop gives up on it. */
export const LIST_TRIES = 3;

/**
 * A list call that rides out a blip: up to `LIST_TRIES` tries, `pollMs`, then twice that, apart.
 * A stop makes dozens of list calls; one 5xx must not end it half way.
 */
async function listing<T>(list: () => Promise<T>, w: Waits, log: StopLog, platform: string) {
  for (let n = 1; ; n += 1) {
    try {
      return await list();
    } catch (error) {
      await log({ platform, step: 'list_failed', try: n, detail: describe(error) });
      if (n >= LIST_TRIES) throw error;
      await w.sleep(w.pollMs * 2 ** (n - 1));
    }
  }
}

/** Poll `list` until `done` holds or the wait is over; the last list either way. */
async function until<T>(list: () => Promise<T>, done: (x: T) => boolean, w: Waits): Promise<T> {
  let last = await list();
  for (let waited = 0; !done(last) && waited < w.waitMs; waited += w.pollMs) {
    await w.sleep(w.pollMs);
    last = await list();
  }
  return last;
}

function istClock(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(11, 16);
}

/** The square-offs already sent, said so the owner never exits them a second time at the broker. */
function inFlight(sent: Map<string, { name: string; at: string }>, where: string): string[] {
  if (!sent.size) return [];
  const items = [...sent.values()].map((s) => `${s.name} (sent ${s.at})`);
  return [
    `⏳ square-off already sent for: ${capped(items)}. Do NOT exit these at the broker: open ${where} first`,
  ];
}

/**
 * One Quantiply account. Each pass: square off and terminate the tool's open algos not yet sent,
 * switch off its enabled ones not yet switched, wait for the squared-off ones to show finished;
 * while a sent one still shows open, later passes keep waiting. A squared-off algo that is still
 * enabled is switched off on the next pass. Afterwards: a sent square-off still showing open is
 * "sent, still closing: do NOT exit at the broker"; anything else of the tool's still open or
 * enabled is "by hand". `record` adds rows to the account's deploy ledger (so the enabler leaves
 * a stopped algo off); it may fail.
 */
export async function stopQuantiply(
  platform: string,
  api: QStopApi,
  ledger: QLedgerRow[],
  log: StopLog,
  opts: {
    dryRun: boolean;
    waits?: Waits;
    record?: (row: Record<string, unknown>, algo: QAlgo) => Promise<void>;
  },
): Promise<Report> {
  const w = opts.waits ?? DEFAULT_WAITS;
  const list = () => listing(() => api.list(), w, log, platform);
  const lines: string[] = [];
  const sent = new Map<string, { name: string; at: string }>();
  let ok = true;
  try {
    const firstList = await list();
    const first = planQuantiplyStop(ledger, firstList);
    await log({
      platform,
      step: 'plan',
      sqOff: capped(first.sqOff, 50),
      disable: capped(first.disable, 50),
    });
    if (opts.dryRun) {
      lines.push(
        first.sqOff.length
          ? `would square off & terminate: ${capped(first.sqOff)}`
          : "nothing of the tool's open",
      );
      if (first.disable.length) lines.push(`would switch off: ${capped(first.disable)}`);
      if (first.byHand.length)
        lines.push(`⚠️ by hand (status unknown to the tool): ${capped(first.byHand)}`);
      if (first.notMine.length) lines.push(`not the tool's, left alone: ${capped(first.notMine)}`);
      return { platform, ok: first.byHand.length === 0, lines };
    }
    const triedSq = new Set<string>();
    const triedOff = new Set<string>();
    const off: string[] = [];
    const stillOpen = (xs: QAlgo[]) => xs.some((x) => sent.has(x.id) && x.status === Q_ACTIVE);
    let current = firstList;
    for (let pass = 1; pass <= w.passes; pass += 1) {
      if (pass > 1) current = await list();
      const plan = planQuantiplyStop(ledger, current);
      const sq = plan.sqOff.filter((a) => !triedSq.has(a.id));
      const toOff = plan.disable.filter((a) => !triedOff.has(a.id));
      if (!sq.length && !toOff.length) {
        // nothing new to send: keep waiting while a sent square-off still shows open
        if (stillOpen(current) && pass < w.passes) {
          current = await until(list, (xs) => !stillOpen(xs), w);
          continue;
        }
        break;
      }
      let sentNow = false;
      for (const a of sq) {
        triedSq.add(a.id);
        try {
          await api.squareOffTerminate(a.id);
          sent.set(a.id, { name: a.name, at: istClock() });
          sentNow = true;
          await log({ platform, pass, step: 'sq_off_terminate', id: a.id, name: a.name, ok: true });
          await opts.record?.({ action: 'sqoff', id: a.id, name: a.name, ok: true }, a);
        } catch (error) {
          ok = false;
          lines.push(`❌ square off failed: ${a.name}: ${describe(error)}`);
          await log({
            platform,
            pass,
            step: 'sq_off_terminate',
            id: a.id,
            name: a.name,
            ok: false,
            detail: describe(error),
          });
        }
      }
      for (const a of toOff) {
        triedOff.add(a.id);
        try {
          await api.setEnabled(a.id, false);
          off.push(a.name);
          await log({ platform, pass, step: 'disable', id: a.id, name: a.name, ok: true });
          await opts.record?.({ action: 'disable', id: a.id, name: a.name, ok: true }, a);
        } catch (error) {
          ok = false;
          lines.push(`❌ switch off failed: ${a.name}: ${describe(error)}`);
          await log({
            platform,
            pass,
            step: 'disable',
            id: a.id,
            name: a.name,
            ok: false,
            detail: describe(error),
          });
          await opts.record?.(
            { action: 'disable', id: a.id, name: a.name, ok: false, detail: describe(error) },
            a,
          );
        }
      }
      if (sentNow) current = await until(list, (xs) => !stillOpen(xs), w);
    }
    const after = await list();
    const closed = [...sent.entries()]
      .filter(([id]) => after.find((x) => x.id === id)?.status !== Q_ACTIVE)
      .map(([, s]) => s.name);
    const closing = [...sent.entries()].filter(
      ([id]) => after.find((x) => x.id === id)?.status === Q_ACTIVE,
    );
    if (closed.length) lines.push(`✅ squared off & terminated: ${capped(closed)}`);
    if (off.length) lines.push(`✅ switched off: ${capped(off)}`);
    if (closing.length) {
      ok = false;
      lines.push(
        `⏳ square-off sent, still closing (Quantiply still shows TRADE_ACTIVE): ${capped(closing.map(([, s]) => `${s.name} (sent ${s.at})`))}. Open Quantiply first; do NOT exit these at the broker while its exit order is pending`,
      );
    }
    const left = quantiplyLeft(ledger, after, new Set(sent.keys()));
    for (const l of left.slice(0, 12)) lines.push(`⚠️ ${l}`);
    if (left.length > 12) lines.push(`⚠️ and ${left.length - 12} more: check Quantiply`);
    if (left.length) ok = false;
    const last = planQuantiplyStop(ledger, after);
    if (last.byHand.length) {
      ok = false;
      lines.push(`⚠️ by hand (status unknown to the tool): ${capped(last.byHand)}`);
    }
    if (last.notMine.length) lines.push(`not the tool's, left alone: ${capped(last.notMine)}`);
    if (!lines.length) lines.push("nothing of the tool's open or enabled");
    await log({ platform, step: 'done', ok, left, closing: closing.map(([id]) => id) });
  } catch (error) {
    ok = false;
    lines.push(`❌ ${describe(error)}`);
    lines.push(...inFlight(sent, 'Quantiply'));
    lines.push(
      sent.size
        ? "⚠️ anything else of the tool's: check Quantiply by hand"
        : '⚠️ check Quantiply by hand',
    );
    await log({
      platform,
      step: 'error',
      ok: false,
      detail: describe(error),
      sent: [...sent.keys()],
    });
  }
  return { platform, ok, lines };
}

/**
 * AlgoTest /live: square off every running deploy of the tool's, in passes, waiting (bounded)
 * while AlgoTest shows them squaring off; then confirm by listing. A deploy the stop squared off
 * is never "by hand": AlgoTest's own exit orders may still be going out.
 */
export async function stopAlgoTest(
  api: AStopApi,
  log: StopLog,
  opts: { dryRun: boolean; isTool: (e: Execution) => boolean; today: string; waits?: Waits },
): Promise<Report> {
  const platform = 'AlgoTest';
  const w = opts.waits ?? DEFAULT_WAITS;
  const list = () => listing(() => api.list(), w, log, platform);
  const plan = (xs: Execution[]) => planAlgoTestStop(xs, opts.isTool, opts.today);
  const lines: string[] = [];
  const tried = new Set<string>();
  const targetIds = new Set<string>();
  const sent = new Map<string, { name: string; at: string }>();
  let ok = true;
  try {
    const first = plan(await list());
    await log({
      platform,
      step: 'plan',
      squareOff: capped(first.squareOff, 50),
      squaring: capped(first.squaring, 50),
      byHand: capped(first.byHand, 50),
      check: capped(first.check, 50),
    });
    if (opts.dryRun) {
      lines.push(
        first.squareOff.length
          ? `would square off: ${capped(first.squareOff)}`
          : "nothing of the tool's running on /live",
      );
      if (first.squaring.length)
        lines.push(`AlgoTest already squaring off: ${capped(first.squaring)}`);
    } else {
      const targets = new Map<string, Execution>(first.squaring.map((e) => [e.id, e]));
      let latest: Execution[] = [];
      for (let pass = 1; pass <= w.passes; pass += 1) {
        const p = pass === 1 ? first : plan(await list());
        const fresh = p.squareOff.filter((e) => !tried.has(e.id));
        if (!fresh.length && pass > 1) break;
        for (const e of fresh) {
          tried.add(e.id);
          try {
            await api.squareOff(e.id);
            targets.set(e.id, e);
            sent.set(e.id, { name: e.name, at: istClock() });
            await log({ platform, pass, step: 'square_off', id: e.id, name: e.name, ok: true });
          } catch (error) {
            ok = false;
            lines.push(`❌ square off failed: ${e.name}: ${describe(error)}`);
            await log({
              platform,
              pass,
              step: 'square_off',
              id: e.id,
              name: e.name,
              ok: false,
              detail: describe(error),
            });
          }
        }
        if (!targets.size) break;
        latest = await until(
          list,
          (xs) => algotestAfter([...targets.values()], xs).pending.length === 0,
          w,
        );
      }
      for (const id of targets.keys()) targetIds.add(id);
      if (targets.size) {
        const r = algotestAfter([...targets.values()], latest.length ? latest : await list());
        if (r.confirmed.length) lines.push(`✅ squared off: ${capped(r.confirmed)}`);
        if (r.pending.length) {
          ok = false;
          lines.push(
            `⏳ square-off sent, AlgoTest is still squaring off: ${capped(r.pending)}. Do NOT exit these at the broker: re-check /live in a minute`,
          );
        }
        for (const c of r.check) lines.push(`⚠️ ${c}`);
        for (const b of r.byHand) lines.push(`⏳ ${b}`);
        if (r.check.length || r.byHand.length) ok = false;
        await log({ platform, step: 'done', ...r });
      } else lines.push("nothing of the tool's running on /live");
    }
    const final = opts.dryRun ? first : plan(await list());
    const untouched = opts.dryRun ? [] : final.squareOff.filter((e) => !tried.has(e.id));
    // a target's own outcome is already a line above
    final.byHand = final.byHand.filter((e) => !targetIds.has(e.id));
    final.check = final.check.filter((e) => !targetIds.has(e.id));
    if (untouched.length) {
      ok = false;
      lines.push(`⚠️ still live after the passes, square off on /live: ${capped(untouched)}`);
    }
    if (final.byHand.length) {
      ok = false;
      lines.push(
        `⚠️ square off by hand (AlgoTest offers no square-off for it now): ${capped(final.byHand.map((e) => `${e.name} (${e.status}${e.activeOnServer ? '' : ', not active on server'})`))}`,
      );
    }
    if (final.check.length) {
      ok = false;
      lines.push(
        `⚠️ switched to manual today, its legs may be open: check at the broker: ${capped(final.check)}`,
      );
    }
    if (final.notMine.length) lines.push(`not the tool's, left running: ${capped(final.notMine)}`);
  } catch (error) {
    ok = false;
    lines.push(`❌ ${describe(error)}`);
    lines.push(...inFlight(sent, 'algotest.in/live'));
    lines.push(
      sent.size
        ? "⚠️ anything else of the tool's: check algotest.in/live by hand"
        : '⚠️ check algotest.in/live by hand',
    );
    await log({
      platform,
      step: 'error',
      ok: false,
      detail: describe(error),
      sent: [...sent.keys()],
    });
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
