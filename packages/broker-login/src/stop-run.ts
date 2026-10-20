import type { APIRequestContext } from 'playwright';
import { describe } from './diagnose.js';
import { HttpStatusError, NotSentError, definitelyRefused } from './quantiply-api.js';
import type { QAlgo, QLedgerRow } from './quantiply-plan.js';
import {
  type Execution,
  Q_ACTIVE,
  type Watched,
  algotestOutcome,
  canSquareOff,
  capped,
  parseExecutions,
  planAlgoTestStop,
  planQuantiplyStop,
  quantiplyLeft,
  squaringOff,
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

/** A square-off this stop (or an earlier one today) sent, or that may have gone out. */
export interface SentInfo {
  name: string;
  /** IST `HH:MM` it was sent */
  at: string;
  /** sent by an earlier stop today (`stop/<day>.jsonl`): never sent again */
  earlier?: boolean;
  /** the call got no answer: it may or may not have reached the platform */
  maybe?: boolean;
}

export type Sent = Map<string, SentInfo>;

const label = (s: SentInfo) => `${s.name} (sent ${s.at}${s.earlier ? ' by an earlier stop' : ''})`;

/** The square-offs already sent, said so the owner never exits them a second time at the broker. */
function inFlight(sent: Sent, maybe: Sent, where: string): string[] {
  const out: string[] = [];
  if (sent.size)
    out.push(
      `⏳ square-off already sent for: ${capped([...sent.values()].map(label))}. Do NOT exit these at the broker: open ${where} first`,
    );
  if (maybe.size)
    out.push(
      `⚠️ square-off may have been sent (no answer): ${capped([...maybe.values()].map(label))}. Open ${where} first; exit at the broker only if it shows no pending exit`,
    );
  return out;
}

/**
 * One Quantiply account. Each pass: square off and terminate the tool's open algos not yet sent
 * (today: an earlier stop's square-offs, `prior`, are never sent again), switch off its enabled
 * ones not yet switched, wait for the squared-off ones to show finished; while one still shows
 * open, later passes keep waiting. A squared-off algo that is still enabled is switched off on the
 * next pass. A call refused outright (a 4xx) was not sent; one with no answer (a timeout, a
 * network error, a 5xx) MAY have been sent and is never treated as not sent. Afterwards:
 * - sent and still open: "square-off sent, still closing: do NOT exit at the broker";
 * - maybe sent and still open: "may have been sent (no answer): open Quantiply first";
 * - anything else of the tool's still open or enabled: "by hand".
 * `record` adds rows to the account's deploy ledger (so the enabler leaves a stopped algo off).
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
    /** today's square-offs an earlier stop sent: waited on, never sent again */
    prior?: Sent;
  },
): Promise<Report> {
  const w = opts.waits ?? DEFAULT_WAITS;
  const list = () => listing(() => api.list(), w, log, platform);
  const lines: string[] = [];
  // an earlier stop's no-answer square-off stays "may have been sent", never becomes "sent"
  const sent: Sent = new Map([...(opts.prior ?? [])].filter(([, x]) => !x.maybe));
  const maybe: Sent = new Map([...(opts.prior ?? [])].filter(([, x]) => x.maybe));
  let ok = true;
  try {
    const firstList = await list();
    const first = planQuantiplyStop(ledger, firstList);
    await log({
      platform,
      step: 'plan',
      sqOff: capped(first.sqOff, 50),
      disable: capped(first.disable, 50),
      earlier: [...sent.keys()],
    });
    if (opts.dryRun) {
      const fresh = first.sqOff.filter((a) => !sent.has(a.id));
      lines.push(
        fresh.length
          ? `would square off & terminate: ${capped(fresh)}`
          : "nothing of the tool's open",
      );
      if (fresh.length < first.sqOff.length)
        lines.push(
          `already sent today, not sent again: ${capped(first.sqOff.filter((a) => sent.has(a.id)))}`,
        );
      if (first.disable.length) lines.push(`would switch off: ${capped(first.disable)}`);
      if (first.byHand.length)
        lines.push(`⚠️ by hand (status unknown to the tool): ${capped(first.byHand)}`);
      if (first.notMine.length) lines.push(`not the tool's, left alone: ${capped(first.notMine)}`);
      return { platform, ok: first.byHand.length === 0, lines };
    }
    const triedSq = new Set<string>([...sent.keys(), ...maybe.keys()]);
    const triedOff = new Set<string>();
    const off: string[] = [];
    const watched = () => new Set([...sent.keys(), ...maybe.keys()]);
    const stillOpen = (xs: QAlgo[]) => {
      const ids = watched();
      return xs.some((x) => ids.has(x.id) && x.status === Q_ACTIVE);
    };
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
          const refused = definitelyRefused(error);
          if (refused) lines.push(`❌ square off refused: ${a.name}: ${describe(error)}`);
          else {
            maybe.set(a.id, { name: a.name, at: istClock() });
            sentNow = true;
            lines.push(`⚠️ square-off call got no answer: ${a.name}: ${describe(error)}`);
            await opts.record?.(
              { action: 'sqoff', id: a.id, name: a.name, ok: false, maybe: true },
              a,
            );
          }
          await log({
            platform,
            pass,
            step: 'sq_off_terminate',
            id: a.id,
            name: a.name,
            ok: false,
            maybe: !refused,
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
    const status = (id: string) => after.find((x) => x.id === id)?.status;
    const closed = [...sent.entries(), ...maybe.entries()]
      .filter(([id]) => status(id) !== Q_ACTIVE)
      .map(([, s]) => s.name);
    const closing = [...sent.entries()].filter(([id]) => status(id) === Q_ACTIVE);
    const maybeOpen = [...maybe.entries()].filter(([id]) => status(id) === Q_ACTIVE);
    if (closed.length) lines.push(`✅ squared off & terminated: ${capped(closed)}`);
    if (off.length) lines.push(`✅ switched off: ${capped(off)}`);
    if (closing.length) {
      ok = false;
      lines.push(
        `⏳ square-off sent, still closing (Quantiply still shows TRADE_ACTIVE): ${capped(closing.map(([, s]) => label(s)))}. Open Quantiply first; do NOT exit these at the broker while its exit order is pending`,
      );
    }
    if (maybeOpen.length) {
      ok = false;
      lines.push(
        `⚠️ square-off may have been sent (no answer): ${capped(maybeOpen.map(([, s]) => label(s)))}. Open Quantiply first; exit at the broker only if it shows no pending exit`,
      );
    }
    const left = quantiplyLeft(ledger, after, watched());
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
    await log({
      platform,
      step: 'done',
      ok,
      left,
      closing: closing.map(([id]) => id),
      maybe: maybeOpen.map(([id]) => id),
    });
  } catch (error) {
    ok = false;
    lines.push(`❌ ${describe(error)}`);
    lines.push(...inFlight(sent, maybe, 'Quantiply'));
    lines.push(
      sent.size || maybe.size
        ? "⚠️ anything else of the tool's: check Quantiply by hand"
        : '⚠️ check Quantiply by hand',
    );
    await log({
      platform,
      step: 'error',
      ok: false,
      detail: describe(error),
      sent: [...sent.keys()],
      maybe: [...maybe.keys()],
    });
  }
  return { platform, ok, lines };
}

/**
 * AlgoTest /live: square off every running deploy of the tool's, in passes (later passes keep
 * waiting while one still shows squaring off), never sending one an earlier stop today already
 * sent (`prior`). A call refused outright (a 4xx) was not sent; one with no answer MAY have been
 * sent. The report reads /live afresh: only `SquaredOff` is done; a deploy squaring off is "still
 * closing: do NOT exit at the broker"; one whose square-off was refused and is still live is
 * "❌ still LIVE: square off by hand".
 */
export async function stopAlgoTest(
  api: AStopApi,
  log: StopLog,
  opts: {
    dryRun: boolean;
    isTool: (e: Execution) => boolean;
    today: string;
    waits?: Waits;
    prior?: Sent;
  },
): Promise<Report> {
  const platform = 'AlgoTest';
  const w = opts.waits ?? DEFAULT_WAITS;
  const list = () => listing(() => api.list(), w, log, platform);
  const plan = (xs: Execution[]) => planAlgoTestStop(xs, opts.isTool, opts.today);
  const lines: string[] = [];
  const watched = new Map<string, Watched>();
  for (const [id, s] of opts.prior ?? [])
    watched.set(id, { ...s, kind: s.maybe ? 'maybe' : 'sent' });
  const sentOf = (kind: Watched['kind']): Sent =>
    new Map([...watched].filter(([, x]) => x.kind === kind));
  let ok = true;
  try {
    const firstList = await list();
    const first = plan(firstList);
    await log({
      platform,
      step: 'plan',
      squareOff: capped(first.squareOff, 50),
      squaring: capped(first.squaring, 50),
      byHand: capped(first.byHand, 50),
      check: capped(first.check, 50),
      earlier: [...watched.keys()],
    });
    if (opts.dryRun) {
      const fresh = first.squareOff.filter((e) => !watched.has(e.id));
      lines.push(
        fresh.length
          ? `would square off: ${capped(fresh)}`
          : "nothing of the tool's running on /live",
      );
      if (first.squaring.length)
        lines.push(`AlgoTest already squaring off: ${capped(first.squaring)}`);
    } else {
      for (const e of first.squaring)
        if (!watched.has(e.id)) watched.set(e.id, { name: e.name, at: '', kind: 'squaring' });
      const pending = (xs: Execution[]) =>
        xs.some((e) => {
          const x = watched.get(e.id);
          if (!x || x.kind === 'refused') return false;
          return squaringOff(e.status) || (canSquareOff(e) && x.kind !== 'squaring');
        });
      let current = firstList;
      for (let pass = 1; pass <= w.passes; pass += 1) {
        if (pass > 1) current = await list();
        // one AlgoTest was squaring off that went back to live is sent like any other
        const fresh = plan(current).squareOff.filter(
          (e) => !watched.has(e.id) || watched.get(e.id)?.kind === 'squaring',
        );
        if (!fresh.length) {
          // nothing new to send: keep waiting while a square-off still shows in progress
          if (pending(current) && pass < w.passes) {
            current = await until(list, (xs) => !pending(xs), w);
            continue;
          }
          break;
        }
        for (const e of fresh) {
          try {
            await api.squareOff(e.id);
            watched.set(e.id, { name: e.name, at: istClock(), kind: 'sent' });
            await log({ platform, pass, step: 'square_off', id: e.id, name: e.name, ok: true });
          } catch (error) {
            ok = false;
            const refused = definitelyRefused(error);
            watched.set(e.id, {
              name: e.name,
              at: istClock(),
              kind: refused ? 'refused' : 'maybe',
              detail: describe(error),
            });
            lines.push(
              refused
                ? `❌ square off refused: ${e.name}: ${describe(error)}`
                : `⚠️ square-off call got no answer: ${e.name}: ${describe(error)}`,
            );
            await log({
              platform,
              pass,
              step: 'square_off',
              id: e.id,
              name: e.name,
              ok: false,
              maybe: !refused,
              detail: describe(error),
            });
          }
        }
        current = await until(list, (xs) => !pending(xs), w);
      }
    }
    // the report reads /live afresh
    const finalList = opts.dryRun ? firstList : await list();
    const final = plan(finalList);
    if (!opts.dryRun) {
      const r = algotestOutcome(watched, finalList);
      if (r.confirmed.length) lines.push(`✅ squared off: ${capped(r.confirmed)}`);
      if (r.closing.length)
        lines.push(
          `⏳ square-off sent, still closing: ${capped(r.closing)}. Do NOT exit these at the broker: re-check /live in a minute`,
        );
      if (r.maybeOpen.length)
        lines.push(
          `⚠️ square-off may have been sent (no answer): ${capped(r.maybeOpen)}. Open AlgoTest /live first; exit at the broker only if it shows no pending exit`,
        );
      if (r.refusedLive.length)
        lines.push(`❌ still LIVE: square off by hand on AlgoTest /live: ${capped(r.refusedLive)}`);
      for (const c of r.check) lines.push(`⚠️ ${c}`);
      for (const o of r.other) lines.push(`⚠️ ${o}`);
      if (
        r.closing.length +
        r.maybeOpen.length +
        r.refusedLive.length +
        r.check.length +
        r.other.length
      )
        ok = false;
      await log({ platform, step: 'done', ...r });
      // an earlier stop's deploy gone from /live: said this once, not on every later stop
      const listed = new Set(finalList.map((e) => e.id));
      for (const [id, x] of watched) {
        if (x.earlier && !listed.has(id)) await log({ platform, step: 'gone', id, name: x.name });
      }
    }
    // a watched deploy's outcome is already a line above
    final.squareOff = final.squareOff.filter((e) => !watched.has(e.id));
    final.byHand = final.byHand.filter((e) => !watched.has(e.id));
    final.check = final.check.filter((e) => !watched.has(e.id));
    if (!opts.dryRun && final.squareOff.length) {
      ok = false;
      lines.push(
        `❌ still LIVE after the passes: square off by hand on AlgoTest /live: ${capped(final.squareOff)}`,
      );
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
    if (!opts.dryRun && !watched.size && !lines.length)
      lines.push("nothing of the tool's running on /live");
    if (final.notMine.length) lines.push(`not the tool's, left running: ${capped(final.notMine)}`);
  } catch (error) {
    ok = false;
    lines.push(`❌ ${describe(error)}`);
    lines.push(...inFlight(sentOf('sent'), sentOf('maybe'), 'algotest.in/live'));
    lines.push(
      [...watched.values()].some((x) => x.kind === 'sent' || x.kind === 'maybe')
        ? "⚠️ anything else of the tool's: check algotest.in/live by hand"
        : '⚠️ check algotest.in/live by hand',
    );
    await log({
      platform,
      step: 'error',
      ok: false,
      detail: describe(error),
      watched: [...watched.keys()],
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
      if (!EXECUTION_ID.test(id))
        throw new NotSentError(`not an execution id: ${JSON.stringify(id)}`);
      const r = await http('PUT', `/execution/v2/square-off/${id}`);
      if (r.status < 200 || r.status > 299) {
        const msg = (r.body as { msg?: unknown; detail?: unknown } | null)?.msg ?? '';
        throw new HttpStatusError(
          r.status,
          `square off answered ${r.status} ${String(msg).slice(0, 200)}`,
        );
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
