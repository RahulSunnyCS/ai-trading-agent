import type { LiveState } from './deploy-plan.js';
import { NAME_PREFIXES } from './strategy-plan.js';

/**
 * BL-143 Phases 2-3, decided without a browser or network: the 09:05 margin check, the 09:25
 * deploy check and the day's loss levels. `trade-monitor.ts` reads the platforms (read-only) and
 * sends the messages; everything it decides is here, so the tests need neither.
 *
 * Nothing here, or in the monitor, ever changes anything on a platform or a broker: it reads
 * pages and GET answers, and Telegrams. The loss levels alert; they never square off.
 */

/** The owner's levels (2026-10-20): the day's combined MTM, open + booked, both platforms. */
export const LOSS_WARNING_INR = -5000;
export const LOSS_ALERT_INR = -8000;

/** IST minutes. */
export const SESSION_CLOSE = 15 * 60 + 30;
export const MARGIN_AT = 9 * 60 + 5;
/**
 * No login and no open session from 09:10 to 09:25 (review of PR #276): the 09:16 pick and
 * deploy and the 09:18-09:21 top-ups log in then, and neither platform is known to keep two
 * sessions for one user. The margin check must be over by 09:10; the deploy check and the loss
 * readings start at 09:25.
 */
export const QUIET_FROM = 9 * 60 + 10;
export const QUIET_UNTIL = 9 * 60 + 25;
export const DEPLOY_CHECK_AT = QUIET_UNTIL;
export const LOSS_FROM = QUIET_UNTIL;

export function inQuietWindow(minutes: number): boolean {
  return minutes >= QUIET_FROM && minutes < QUIET_UNTIL;
}

export function inLossWindow(minutes: number): boolean {
  return minutes >= LOSS_FROM && minutes < SESSION_CLOSE;
}

/** A part runs only when its `.env` switch is exactly "on" (any case), like ALGOTEST_UPLOAD. */
export function switchOn(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name]?.trim().toLowerCase() === 'on';
}

// --- logins: the caps and the waits ----------------------------------------------------------

/** Codes typed (or AlgoTest password logins) per platform a day, at most. */
export const LOGIN_CAP = { algotest: 3, quantiply: 2 } as const;
/** After a failed login, no new one for this long. */
export const LOGIN_BACKOFF_MS = 10 * 60_000;
/** A session the platform ended (401 / logged out) is replaced at most this often. */
export const RELOGIN_EVERY_MS = 30 * 60_000;
/**
 * No login within this long of losing a session, the first replacement included (re-review of
 * PR #276, B): the session most likely ended because someone else logged in (the owner's browser,
 * the stop button), and logging straight back in would end theirs.
 */
export const RELOGIN_AFTER_LOSS_MS = 10 * 60_000;
/** A replacement also waits while another process logged in to the platform this recently. */
export const OTHER_LOGIN_RECENT_MS = 10 * 60_000;

export interface LoginLog {
  /** codes typed / logins sent today */
  count: number;
  /** ISO time of the last failed login */
  failedAt?: string;
  /** ISO time of the last login that replaced a lost session */
  reloginAt?: string;
  /** ISO time the platform last ended the monitor's session (401 / logged out) */
  lostAt?: string;
  /** ISO time of the monitor's last successful login */
  loggedInAt?: string;
}

/**
 * Is the next login a replacement for a lost session? In this process (`lostInMemory`), or by the
 * state file: a loss later than the last successful login, so a restarted monitor still applies
 * the replacement checks (another recent login, at most every 30 min).
 */
export function isReplacing(log: LoginLog, lostInMemory: boolean): boolean {
  if (lostInMemory) return true;
  if (!log.lostAt) return false;
  return !log.loggedInAt || Date.parse(log.lostAt) > Date.parse(log.loggedInAt);
}

export interface LoginContext {
  log: LoginLog;
  cap: number;
  /** IST minutes */
  minutes: number;
  nowMs: number;
  /** this login replaces a session the platform ended */
  replacing: boolean;
  /**
   * When another process last logged in to this platform (AlgoTest's lock stamp, Quantiply's
   * TOTP window stamp), ms; null when unknown. Read only for a replacement: the monitor's own
   * last login is older than its lost session, so a stamp this recent is someone else's.
   */
  otherLoginAtMs?: number | null;
  /** the stop button (PR #275) is running: never log in under it */
  stopRunning?: boolean;
}

const ago = (nowMs: number, iso: string | undefined) =>
  iso === undefined ? Number.POSITIVE_INFINITY : nowMs - Date.parse(iso);

/**
 * May the monitor log in to a platform now? Never in the quiet window or while the stop button
 * runs, never past the cap, not within the backoff after a failure, not within 10 min of losing a
 * session, and a replacement only when no other login to the platform is recent and at most every
 * 30 min. `why` is said in the log; null means go ahead.
 */
export function loginRefusal(c: LoginContext): string | null {
  const { log, cap, minutes, nowMs, replacing } = c;
  if (inQuietWindow(minutes)) return 'no login between 09:10 and 09:25 (the deploy window)';
  if (c.stopRunning) return 'the stop button is running';
  if (log.count >= cap) return `${cap} logins today already`;
  if (ago(nowMs, log.failedAt) < LOGIN_BACKOFF_MS) {
    return 'a login failed less than 10 minutes ago';
  }
  if (ago(nowMs, log.lostAt) < RELOGIN_AFTER_LOSS_MS) {
    return 'the session ended less than 10 minutes ago (another login may be in use)';
  }
  if (replacing) {
    if (typeof c.otherLoginAtMs === 'number' && nowMs - c.otherLoginAtMs < OTHER_LOGIN_RECENT_MS) {
      return 'another login to this platform was less than 10 minutes ago';
    }
    if (ago(nowMs, log.reloginAt) < RELOGIN_EVERY_MS) {
      return 'the session was already replaced less than 30 minutes ago';
    }
  }
  return null;
}

const laterIso = (a: string | undefined, b: string | undefined) =>
  a === undefined ? b : b === undefined ? a : Date.parse(a) >= Date.parse(b) ? a : b;

/**
 * The day's logins from two copies (the state file on disk and this process's): the higher count
 * and the later time of each kind, per platform. A `--print` run and the scheduled monitor both
 * count toward the caps without one overwriting the other's logins (re-review of #276, E).
 */
export function mergeLogins<K extends string>(
  a: Partial<Record<K, LoginLog>> | undefined,
  b: Partial<Record<K, LoginLog>> | undefined,
): Partial<Record<K, LoginLog>> {
  const out: Partial<Record<K, LoginLog>> = {};
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]) as Set<K>;
  for (const k of keys) {
    const x = a?.[k];
    const y = b?.[k];
    const merged: LoginLog = { count: Math.max(x?.count ?? 0, y?.count ?? 0) };
    for (const f of ['failedAt', 'reloginAt', 'lostAt', 'loggedInAt'] as const) {
      const v = laterIso(x?.[f], y?.[f]);
      if (v !== undefined) merged[f] = v;
    }
    out[k] = merged;
  }
  return out;
}

// --- waiting for the platforms' jobs ---------------------------------------------------------

/**
 * The two windows the scheduler's platform jobs log in in. Inside one, a job may be "due" or about
 * to run; after its end (the cap) only a run that is actually in progress still blocks.
 * Morning: algotest-topup's three attempts (09:18, 10 min each, 2 min apart) end by 09:52 at worst,
 * quantiply-topup's two and the queued quantiply-deploy-topup by 09:51. Evening: the 15:35 / 15:40
 * deploy check and disable, the 15:40 / 15:55 live-results capture (BL-141), the 16:40 / 16:45
 * uploads and the 16:55 enable.
 */
export const WAIT_WINDOWS = {
  morning: { from: 9 * 60 + 10, until: 10 * 60 },
  evening: { from: 15 * 60 + 35, until: 17 * 60 + 30 },
} as const;
export type WaitWindow = keyof typeof WAIT_WINDOWS;
/** The morning cap. */
export const JOBS_WAIT_UNTIL = WAIT_WINDOWS.morning.until;
/** A slot this close ahead counts as about to run. */
export const JOB_SOON_MS = 5 * 60_000;

export interface PlatformJob {
  id: string;
  window: WaitWindow;
}

/**
 * The scheduler jobs that log in to each platform (re-reviews of #276: A, and must-fix 1). Before
 * any login the monitor reads the scheduler's `GET /jobs`, at any hour: a run of one of these in
 * progress today always blocks (bounded by the job's own timeout, which the scheduler enforces
 * while its API answers); a slot that has come with no run yet, one about to come, or an API that
 * does not answer blocks only until the job's window's cap.
 */
export const PLATFORM_JOBS: Record<'algotest' | 'quantiply', readonly PlatformJob[]> = {
  algotest: [
    { id: 'algotest-deploy', window: 'morning' },
    { id: 'algotest-topup', window: 'morning' },
    { id: 'algotest-deploy-check', window: 'evening' },
    { id: 'algotest-evening', window: 'evening' },
    // BL-141: the 15:40 capture and its 15:55 retry log in to both platforms
    { id: 'live-capture', window: 'evening' },
    { id: 'live-capture-retry', window: 'evening' },
  ],
  quantiply: [
    { id: 'quantiply-topup', window: 'morning' },
    { id: 'quantiply-deploy-topup', window: 'morning' },
    { id: 'quantiply-disable', window: 'evening' },
    { id: 'quantiply-evening', window: 'evening' },
    { id: 'quantiply-deploy', window: 'morning' },
    { id: 'live-capture', window: 'evening' },
    { id: 'live-capture-retry', window: 'evening' },
  ],
};

/** One row of the scheduler's `GET /jobs` (only what the monitor reads). */
export interface SchedulerJobView {
  id: string;
  nextRun: string | null;
  /** `alive` (open rows): its writer or its step's process group still exists */
  lastRun: { started_at: string; ended_at: string | null; alive?: boolean } | null;
  previousSlot?: string | null;
  previousSlotRun?: { started_at?: string; ended_at: string | null; alive?: boolean } | null;
  /** the longest a run can take while the scheduler lives (every step, attempt, delay, group wait) */
  maxRunMinutes?: number;
  catchUpHours?: number;
}

/** A "running" row older than the job's longest run plus this is one nothing closed: ignored. */
export const STALE_RUN_SLACK_MS = 5 * 60_000;
/** A due slot inside its catch-up window still blocks after the cap, for this long at most. */
export const DUE_GRACE_MS = 30 * 60_000;
/** Waiting this long on one job is said once, unmuted. */
export const LONG_WAIT_MS = 30 * 60_000;

export interface WaitItem {
  /** the job id, or `api` when the scheduler's API did not answer */
  job: string;
  window: WaitWindow;
  kind: 'running' | 'due' | 'soon' | 'api';
  text: string;
  /** the window's cap has passed */
  capped: boolean;
  /** a due slot still inside the job's catch-up window (the scheduler will start it) */
  inCatchUp?: boolean;
}

export interface JobsWait {
  /** what blocks a login now; empty = the monitor may log in */
  blocking: WaitItem[];
  /** what would block but its window's cap has passed: the monitor logs in anyway and says so */
  pastCap: WaitItem[];
}

const istMinuteOf = (d: Date) => Math.floor((d.getTime() / 60_000 + 330) % 1440);

/**
 * What of the scheduler's platform jobs could still log in, from `GET /jobs` (`views`; null = the
 * API did not answer, `apiError` says why). Every item says whether its window's cap has passed;
 * `jobsWait` decides what blocks.
 * - A run that started today and has not ended (or the run serving today's slot). One the
 *   scheduler reports `alive` (its writer or its step's process group exists) always counts; one
 *   it does not is ignored once older than the job's longest run plus `STALE_RUN_SLACK_MS`.
 * - Today's slot having come with no run yet (due, or queued behind its group); `inCatchUp` while
 *   the scheduler would still start it.
 * - A slot within `JOB_SOON_MS`.
 * - An API that does not answer, inside a window of the platform's jobs or for an hour after it.
 * A job not scheduled today, whose run today has ended, or that the scheduler does not list, is
 * not an item.
 */
export function jobsStillToEnd(
  views: SchedulerJobView[] | null,
  jobs: readonly PlatformJob[],
  now: Date,
  apiError = 'no answer',
): WaitItem[] {
  const out: WaitItem[] = [];
  const minutes = istMinuteOf(now);
  if (views === null) {
    for (const w of [...new Set(jobs.map((j) => j.window))]) {
      const win = WAIT_WINDOWS[w];
      const ids = jobs.filter((j) => j.window === w).map((j) => j.id);
      const text = `the scheduler's API does not answer (${apiError}): cannot tell whether ${ids.join(' / ')} ended`;
      if (minutes >= win.from && minutes < win.until + 60) {
        out.push({ job: 'api', window: w, kind: 'api', text, capped: minutes >= win.until });
      }
    }
    return out;
  }
  const day = istDayOf(now);
  for (const { id, window } of jobs) {
    const v = views.find((j) => j.id === id);
    if (!v) continue;
    const capped = minutes >= WAIT_WINDOWS[window].until;
    // A row whose processes still exist always counts, however old: a run's timeout pauses while
    // the laptop sleeps, so wall-clock age says nothing about it. Only a row the scheduler cannot
    // see alive (or an older API that does not say) is judged by its age.
    const fresh = (row: { started_at?: string; alive?: boolean }) =>
      row.alive === true ||
      row.started_at === undefined ||
      v.maxRunMinutes === undefined ||
      now.getTime() - Date.parse(row.started_at) <= v.maxRunMinutes * 60_000 + STALE_RUN_SLACK_MS;
    const last = v.lastRun;
    if (
      last &&
      last.ended_at === null &&
      istDayOf(new Date(last.started_at)) === day &&
      fresh(last)
    ) {
      const text = `${id} is running (since ${istClock(new Date(last.started_at))})`;
      out.push({ job: id, window, kind: 'running', text, capped });
      continue;
    }
    const slot = v.previousSlot ? new Date(v.previousSlot) : null;
    if (slot && istDayOf(slot) === day && slot.getTime() <= now.getTime()) {
      const run = v.previousSlotRun;
      if (run && run.ended_at === null) {
        if (fresh(run)) {
          const text = `${id} is running (its ${istClock(slot)} run)`;
          out.push({ job: id, window, kind: 'running', text, capped });
        }
        continue;
      }
      if (!run) {
        const inCatchUp = now.getTime() - slot.getTime() <= (v.catchUpHours ?? 0) * 3_600_000;
        const text = `${id} is due (its ${istClock(slot)} run has not started)`;
        out.push({ job: id, window, kind: 'due', text, capped, inCatchUp });
        continue;
      }
    }
    const next = v.nextRun ? new Date(v.nextRun) : null;
    const ahead = next ? next.getTime() - now.getTime() : Number.POSITIVE_INFINITY;
    if (next && istDayOf(next) === day && ahead > 0 && ahead <= JOB_SOON_MS) {
      out.push({ job: id, window, kind: 'soon', text: `${id} runs at ${istClock(next)}`, capped });
    }
  }
  return out;
}

/** The key `jobsWait`'s `firstSeen` is kept by. */
export const waitKey = (i: WaitItem) => `${i.kind}:${i.job}`;

/**
 * What blocks a login now. `firstSeen` (ms per `waitKey`, kept by the caller across checks) says
 * since when the monitor has seen each item.
 * - A run in progress: always (its own longest run bounds it; a row nothing closed is not an item).
 * - Due, about to run, or the API not answering: until the window's cap.
 * - After the cap, a due slot still inside its catch-up window (the scheduler starts it on its next
 *   tick, or it is queued behind its group): for `DUE_GRACE_MS` from when the monitor first saw it.
 * - Anything else past the cap: `pastCap` (log in anyway, and say so).
 */
export function jobsWait(
  items: WaitItem[],
  nowMs: number,
  firstSeen: Record<string, number>,
): JobsWait {
  const out: JobsWait = { blocking: [], pastCap: [] };
  for (const i of items) {
    const seen = firstSeen[waitKey(i)] ?? nowMs;
    const blocks =
      i.kind === 'running' ||
      !i.capped ||
      (i.kind === 'due' && i.inCatchUp === true && nowMs - seen < DUE_GRACE_MS);
    (blocks ? out.blocking : out.pastCap).push(i);
  }
  return out;
}

// --- money ---------------------------------------------------------------------------------

/** "₹ -1,23,456.50", "-₹ 1,234", "₹ 0", "− ₹12" -> a number; null when there is no figure. */
export function parseRupees(text: string): number | null {
  const m = /^\s*([-−–])?\s*₹\s*([-−–])?\s*(\d[\d,]*(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const value = Number((m[3] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return m[1] || m[2] ? -value : value;
}

/** ₹ in Indian grouping, no decimals: `₹-5,234`, `₹12,50,074`. */
export function inr(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `₹${sign}${Math.round(Math.abs(value)).toLocaleString('en-IN')}`;
}

// --- AlgoTest's Total MTM (/live) -------------------------------------------------------------

/**
 * One MTM card of /live (`[data-testid="broker-mtm"]`, read in the page by
 * `readMtmCardsInPage`): its label (the first line: "Total MTM" or a broker's alias), the text
 * of its figure element (`p.tabular-nums`) and that element's colour class. AlgoTest's bundle
 * (chunk 2331, 2026-10-20) renders the figure `text-green-500` when >= 0 and `text-red-500`
 * when < 0, and a loading dots element instead while it computes.
 */
export interface MtmCard {
  label: string;
  value: string | null;
  red: boolean;
  green: boolean;
}

/**
 * The "Total MTM" card's figure, or why it cannot be read: no such card, no figure element (still
 * loading), a figure that is not exactly one rupee amount, or a colour that disagrees with the
 * sign. A loss shown in red without a minus sign is read as negative.
 */
export function readTotalMtm(cards: MtmCard[]): { inr: number } | { error: string } {
  const total = cards.filter((c) => c.label.trim() === 'Total MTM');
  if (total.length !== 1) return { error: `${total.length} "Total MTM" cards on /live` };
  const card = total[0] as MtmCard;
  if (card.value === null) return { error: 'the Total MTM figure is not shown (still loading?)' };
  const value = parseRupees(card.value);
  if (value === null)
    return { error: `the Total MTM figure "${card.value.slice(0, 30)}" is not a rupee amount` };
  if (card.red === card.green) return { error: 'the Total MTM figure has no profit/loss colour' };
  if (card.red && value > 0) return { inr: -value };
  if (card.green && value < 0) return { error: 'the Total MTM figure is negative but shown green' };
  return { inr: value };
}

/** Runs in the page (`page.evaluate`): the MTM cards as plain data. Reads only. */
export function readMtmCardsInPage(): MtmCard[] {
  return Array.from(document.querySelectorAll('[data-testid="broker-mtm"]')).map((card) => {
    const figure = card.querySelector('p.tabular-nums');
    const text = (card as HTMLElement).innerText ?? card.textContent ?? '';
    return {
      label: text.split('\n')[0]?.trim() ?? '',
      value: figure ? (figure.textContent ?? '').trim() : null,
      red: !!figure?.classList.contains('text-red-500'),
      green: !!figure?.classList.contains('text-green-500'),
    };
  });
}

// --- AlgoTest's broker funds (GET api.algotest.in/brokers) ----------------------------------

export interface BrokerFunds {
  /** AlgoTest's broker id, e.g. `Broker.Finvasia` */
  broker: string;
  available: number | null;
  /** when AlgoTest last read the funds (its broker login), ISO */
  updatedAt: string | null;
  /** until when AlgoTest's broker session lasts, ISO */
  loggedUntil: string | null;
}

/** AlgoTest's timestamps carry no zone and are UTC (`02:47` = AlgoTest's 08:17 IST login). */
export function algotestInstant(ts: string | null): Date | null {
  if (!ts) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function istDayOf(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** `HH:MM` IST of an instant. */
export function istClock(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16);
}

/** `GET /brokers`' answer: one entry per linked broker, never its keys (they are not read). */
export function parseAlgotestBrokers(json: unknown): BrokerFunds[] {
  const list = (json as { brokers?: unknown }).brokers;
  if (!Array.isArray(list)) throw new Error('AlgoTest /brokers: no brokers list');
  return (list as Record<string, unknown>[])
    .filter((b) => b.deleted !== true)
    .map((b) => {
      const margin = (b.margin ?? {}) as Record<string, unknown>;
      return {
        broker: String(b.broker ?? ''),
        available: typeof margin.available === 'number' ? margin.available : null,
        updatedAt: typeof margin.updated_ts === 'string' ? margin.updated_ts : null,
        loggedUntil: typeof b.logged_until === 'string' ? b.logged_until : null,
      };
    });
}

/** AlgoTest's broker id for one of the repo's brokers. */
export const ALGOTEST_BROKER_ID = { finvasia: 'Broker.Finvasia', angelone: 'Broker.AngelOne' };

// --- margin need -----------------------------------------------------------------------------

export interface LegNeed {
  underlying: string;
  sell: boolean;
  lots: number;
  /** the closest-premium target when the leg is chosen by premium (₹ per unit), else null */
  premium: number | null;
}

/** A pick's legs at an account's platform multiplier (BL-140 Phase 4): every leg's lots times it. */
export function scaleLegs(legs: LegNeed[], multiplier: number): LegNeed[] {
  return multiplier === 1 ? legs : legs.map((l) => ({ ...l, lots: l.lots * multiplier }));
}

/** An AlgoTest `.algtst` (the export's file): `strategy.Ticker`, each leg's side, lots, premium. */
export function legsFromAlgtst(doc: unknown): LegNeed[] {
  const s = (doc as { strategy?: Record<string, unknown> }).strategy ?? {};
  const underlying = String(s.Ticker ?? '');
  const legs = (s.ListOfLegConfigs ?? []) as Record<string, unknown>[];
  return legs.map((leg) => ({
    underlying,
    sell: leg.PositionType === 'PositionType.Sell',
    lots: Number((leg.LotConfig as { Value?: unknown } | undefined)?.Value ?? 1),
    premium:
      leg.EntryType === 'EntryType.EntryByPremium' && typeof leg.StrikeParameter === 'number'
        ? leg.StrikeParameter
        : null,
  }));
}

/** A Quantiply create body (the export's file): each leg's `base`, side, `quantity`, premium. */
export function legsFromQuantiply(body: unknown): LegNeed[] {
  const conf = ((body as { configurations?: unknown }).configurations ?? {}) as {
    legs?: Record<string, unknown>[];
  };
  return (conf.legs ?? []).map((leg) => {
    const p = (leg.premium ?? {}) as { value?: unknown };
    return {
      underlying: String(leg.base ?? ''),
      sell: leg.transactionType === 'S',
      lots: Number(leg.quantity ?? 1),
      premium: leg.selectionType === 'PREMIUM' && typeof p.value === 'number' ? p.value : null,
    };
  });
}

/**
 * `margin.csv` (option-backtesting's reference data): the latest per-lot figure of each
 * underlying's short straddle. The file is the repo's one margin model (engine/margin.py).
 */
export function parseMarginCsv(text: string): Map<string, number> {
  const best = new Map<string, { month: string; inr: number }>();
  for (const line of text.split('\n').slice(1)) {
    const [underlying = '', type = '', month = '', value = ''] = line.trim().split(',');
    if (type !== 'short-straddle' || !underlying) continue;
    const inr = Number(value);
    const seen = best.get(underlying);
    if (Number.isFinite(inr) && (!seen || month > seen.month)) best.set(underlying, { month, inr });
  }
  return new Map([...best].map(([u, v]) => [u, v.inr]));
}

export interface PickNeed {
  name: string;
  inr: number;
  /** an underlying without its own row in margin.csv borrows NIFTY's figure */
  borrowed: string[];
  /** a bought leg whose premium is not known before entry (chosen by strike): need not estimated */
  unestimated: boolean;
}

/**
 * The documented estimate (BL-143): every sold leg-lot needs half the underlying's short-straddle
 * figure from margin.csv (NIFTY's when the underlying has none); every bought leg-lot its premium
 * x the lot size, known only for a leg chosen by closest premium. A bought leg chosen by strike
 * is "not estimated". No hedge benefit and every pick counted at once.
 */
export function pickNeed(
  name: string,
  legs: LegNeed[],
  perStraddle: Map<string, number>,
  lotOf: (underlying: string) => number | null,
): PickNeed {
  let total = 0;
  let unestimated = false;
  const borrowed = new Set<string>();
  for (const leg of legs) {
    if (!leg.sell) {
      const lot = lotOf(leg.underlying);
      if (leg.premium === null || lot === null) unestimated = true;
      else total += leg.premium * lot * leg.lots;
      continue;
    }
    let straddle = perStraddle.get(leg.underlying);
    if (straddle === undefined) {
      straddle = perStraddle.get('NIFTY') ?? 0;
      borrowed.add(leg.underlying);
    }
    total += (straddle / 2) * leg.lots;
  }
  return { name, inr: total, borrowed: [...borrowed], unestimated };
}

export type MarginVerdict = 'ok' | 'tight' | 'short' | 'unknown';

/** Enough with a 20% cushion = ok; enough but within it = tight; less = short. */
export function marginVerdict(free: number | null, need: number): MarginVerdict {
  if (free === null) return 'unknown';
  if (free >= need * 1.2) return 'ok';
  if (free >= need) return 'tight';
  return 'short';
}

export interface AccountMargin {
  /** `Finvasia`, `Angel One` */
  account: string;
  /** what the picks are for, e.g. `AlgoTest T1` */
  uses: string[];
  picks: PickNeed[];
  free: number | null;
  /** where the free figure came from, or why there is none */
  source: string;
  /** a list whose picks for today could not be read: the need is then unknown */
  picksMissing?: boolean;
}

const MARK: Record<MarginVerdict, string> = { ok: '✅', tight: '⚠️', short: '❌', unknown: '❔' };

export function marginMessage(
  day: string,
  accounts: AccountMargin[],
): { text: string; ok: boolean } {
  const lines: string[] = [];
  let ok = true;
  for (const a of accounts) {
    const need = a.picks.reduce((s, p) => s + p.inr, 0);
    const unest = a.picks.filter((p) => p.unestimated).map((p) => p.name);
    const short = marginVerdict(a.free, need) === 'short';
    // a known shortfall stands even when part of the need is unknown
    const v: MarginVerdict = short
      ? 'short'
      : a.picksMissing || unest.length
        ? 'unknown'
        : marginVerdict(a.free, need);
    if (v !== 'ok') ok = false;
    const free = a.free === null ? 'free not read' : `free ${inr(a.free)}`;
    const count = `${a.picks.length} pick${a.picks.length === 1 ? '' : 's'}`;
    const needText = a.picksMissing
      ? `need not known (picks not read)${a.picks.length ? `, ~${inr(need)} for the ${count} read` : ''}`
      : unest.length
        ? `need at least ~${inr(need)} for ${count} (${unest.join(', ')}: bought by strike, premium not estimated)`
        : `need ~${inr(need)} for ${count}`;
    const tail =
      v === 'short'
        ? ` — SHORT by ${inr(need - (a.free ?? 0))}`
        : v === 'tight'
          ? ' — under a 20% cushion'
          : '';
    lines.push(`${MARK[v]} ${a.account} (${a.uses.join(', ')}): ${free}, ${needText}${tail}`);
    lines.push(`   ${a.source}`);
    const borrowed = [...new Set(a.picks.flatMap((p) => p.borrowed))];
    if (borrowed.length)
      lines.push(`   ${borrowed.join(', ')} estimated with NIFTY's per-lot margin`);
  }
  const head = ok ? `✅ Margin check ${day}` : `⚠️ Margin check ${day}: look before 09:16`;
  return {
    text: [
      head,
      ...lines,
      'Estimate: half the short-straddle margin per sold leg-lot, the premium x lot per bought leg-lot, no hedge benefit',
    ].join('\n'),
    ok,
  };
}

// --- deploy check ----------------------------------------------------------------------------

export interface PlatformCheck {
  /** `AlgoTest T1`, `Quantiply Core` */
  label: string;
  expected: number;
  good: string[];
  /** a pick that is missing, not deployed, or not at 1 lot: what is wrong */
  problems: string[];
  /** a tool strategy deployed / enabled today that is not a pick */
  extra: string[];
  /** anything else worth a line (the owner's own strategies, a stale export) */
  notes: string[];
  /** the platform could not be read at all */
  error?: string;
}

const isTool = (name: string) => NAME_PREFIXES.some((p) => name.startsWith(p));

export type BrokerKey = 'finvasia' | 'angelone';

/** One deployed card of /live's "Deployed Strategies": its name (maybe cut) and its broker. */
export interface DeployedOn {
  name: string;
  broker: BrokerKey | null;
}

/**
 * The "Deployed Strategies" section of /live's text, one block per card. Each card starts with
 * "Deployed on <date>" and carries its name and "<broker - account>"
 * (docs/algotest-execution.md §7); a block that names neither Finvasia/Shoonya nor Angel has an
 * unknown broker.
 */
export function parseDeployedOn(text: string, names: string[]): DeployedOn[] {
  const start = text.indexOf('Deployed Strategies');
  const end = text.indexOf('\nActivation\n');
  if (start < 0) return [];
  const body = text.slice(start, end > start ? end : undefined);
  const blocks = body.split(/\n(?=Deployed on )/).slice(1);
  const out: DeployedOn[] = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const name =
      names.find((n) =>
        lines.some((l) => l === n || (l.endsWith('...') && n.startsWith(l.slice(0, -3)))),
      ) ?? '';
    const broker = /finvasia|shoonya/i.test(block)
      ? 'finvasia'
      : /angel/i.test(block)
        ? 'angelone'
        : null;
    if (name) out.push({ name, broker });
  }
  return out;
}

/** One AlgoTest row of BL-140 that uploads a list: its broker and today's picks. */
export interface AlgoTestRowPicks {
  broker: BrokerKey;
  picks: string[];
  /** the row's platform multiplier (BL-140 Phase 4): 1 when the row does not say */
  multiplier?: number;
}

/**
 * AlgoTest /live against the day's picks, per BL-140 row: each pick deployed once per row that
 * holds it (a pick in both rows' lists is two deploys), on that row's broker where /live names
 * it, at multiplier 1 (`multipliers`; a deployed pick missing from it is said, never passed
 * silently), and no tool strategy deployed that is not a pick. No broker logged in is a problem.
 */
export function checkAlgoTest(
  label: string,
  rows: AlgoTestRowPicks[],
  live: LiveState,
  multipliers: Map<string, number> | null,
  deployedOn: DeployedOn[],
): PlatformCheck {
  const wantedCount = new Map<string, BrokerKey[]>();
  const wantedMult = new Map<string, Set<number>>();
  for (const row of rows) {
    for (const name of row.picks) {
      wantedCount.set(name, [...(wantedCount.get(name) ?? []), row.broker]);
      wantedMult.set(name, (wantedMult.get(name) ?? new Set<number>()).add(row.multiplier ?? 1));
    }
  }
  const out: PlatformCheck = {
    label,
    expected: wantedCount.size,
    good: [],
    problems: [],
    extra: [],
    notes: [],
  };
  if (live.brokersLoggedIn < 1) {
    out.problems.push(
      `no broker logged in on AlgoTest (Broker Login ${live.brokersLoggedIn}/${live.brokersTotal})`,
    );
  }
  const liveRows = new Map(live.rows.map((r) => [r.name, r]));
  const brokerUnread = new Set<string>();
  const multUnread: string[] = [];
  for (const [name, brokers] of wantedCount) {
    const row = liveRows.get(name);
    const mult = multipliers?.get(name);
    if (!row) {
      out.problems.push(`${name}: not in AlgoTest`);
      continue;
    }
    if (row.deployed === 0) {
      out.problems.push(`${name}: not deployed`);
      continue;
    }
    if (row.deployed !== brokers.length) {
      out.problems.push(`${name}: deployed ${row.deployed} times, expected ${brokers.length}`);
      continue;
    }
    // A pick two rows hold is one saved strategy with one multiplier: rows that disagree on it
    // cannot both be right.
    const asked = [...(wantedMult.get(name) ?? [1])];
    if (asked.length > 1) {
      out.problems.push(`${name}: the rows ask for different multipliers (${asked.join(', ')})`);
      continue;
    }
    const expected = asked[0] ?? 1;
    if (mult !== undefined && mult !== expected) {
      out.problems.push(`${name}: multiplier ${mult}, not ${expected}`);
      continue;
    }
    if (mult === undefined) multUnread.push(name);
    const cards = deployedOn.filter((d) => d.name === name);
    const missing = brokers.filter((b) => !cards.some((c) => c.broker === b));
    if (cards.length && cards.every((c) => c.broker !== null) && missing.length) {
      out.problems.push(`${name}: not deployed on ${missing.join(', ')}`);
      continue;
    }
    if (!cards.length || cards.some((c) => c.broker === null)) brokerUnread.add(name);
    out.good.push(name);
  }
  if (multipliers === null) out.notes.push('multipliers could not be read: deploy counts only');
  else if (multUnread.length) out.notes.push(`multiplier not read for ${multUnread.join(', ')}`);
  if (brokerUnread.size) {
    out.notes.push(
      `which broker /live deployed it on was not read for ${[...brokerUnread].join(', ')}`,
    );
  }
  for (const row of live.rows) {
    if (row.deployed < 1 || wantedCount.has(row.name)) continue;
    if (isTool(row.name)) out.extra.push(`${row.name} (${row.deployed} Deployed)`);
    else out.notes.push(`also deployed (not the tool's): ${row.name}`);
  }
  return out;
}

/** One algo from Quantiply's `GET /algos/day-wise`, with the fields the checks need. */
export interface QListed {
  id: string;
  name: string;
  day: string;
  enabled: boolean;
  status: string;
  multiplier: number | null;
  /** `HH:MM:SS`, or null */
  startTime: string | null;
  endTime: string | null;
}

export function parseDayWiseListed(json: unknown): QListed[] {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('day-wise list: no data array');
  const out: QListed[] = [];
  const time = (v: unknown) => (typeof v === 'string' && /^\d\d:\d\d(:\d\d)?$/.test(v) ? v : null);
  for (const day of data as { day?: string; algos?: unknown }[]) {
    if (!Array.isArray(day.algos)) continue;
    for (const a of day.algos as Record<string, unknown>[]) {
      if (typeof a._id !== 'string' || typeof a.name !== 'string') continue;
      out.push({
        id: a._id,
        name: a.name,
        day: typeof a.day === 'string' ? a.day : String(day.day),
        enabled: a.enabled === true,
        status: typeof a.status === 'string' ? a.status : 'UNKNOWN',
        multiplier: typeof a.multiplier === 'number' ? a.multiplier : null,
        startTime: time(a.startTime),
        endTime: time(a.endTime),
      });
    }
  }
  return out;
}

/** Each leg's `quantity` (lots) of a full algo (`GET /algos/:id`) or a create body. */
export function legLots(algo: unknown): number[] {
  const conf = ((algo as { configurations?: unknown }).configurations ?? {}) as {
    legs?: { quantity?: unknown }[];
  };
  return (conf.legs ?? []).map((l) => Number(l.quantity));
}

/**
 * Quantiply's list for today's weekday against the day's picks: each pick enabled once, at
 * the account row's multiplier (1 unless the owner set it) and with the export's lots on every leg (`lots` by algo id, from `GET /algos/:id`;
 * absent = not read, said in a note), and no tool algo enabled that is not a pick. The owner's
 * own enabled algos are a note, not a problem.
 */
export function checkQuantiply(
  label: string,
  picks: { name: string; lots: number[] }[],
  algos: QListed[],
  weekday: string,
  lots: Map<string, number[]>,
  /** the account row's platform multiplier (BL-140 Phase 4) */
  expectedMultiplier = 1,
): PlatformCheck {
  const out: PlatformCheck = {
    label,
    expected: picks.length,
    good: [],
    problems: [],
    extra: [],
    notes: [],
  };
  const today = algos.filter((a) => a.day === weekday);
  const wanted = new Set(picks.map((p) => p.name));
  for (const pick of picks) {
    const same = today.filter((a) => a.name === pick.name);
    const on = same.filter((a) => a.enabled);
    if (!same.length) {
      out.problems.push(`${pick.name}: not in Quantiply for ${weekday}`);
      continue;
    }
    if (!on.length) {
      out.problems.push(`${pick.name}: not enabled`);
      continue;
    }
    if (on.length > 1) {
      out.problems.push(`${pick.name}: enabled ${on.length} times`);
      continue;
    }
    const algo = on[0] as QListed;
    if (algo.multiplier !== null && algo.multiplier !== expectedMultiplier) {
      out.problems.push(`${pick.name}: multiplier ${algo.multiplier}, not ${expectedMultiplier}`);
      continue;
    }
    const got = lots.get(algo.id);
    if (got && got.join('/') !== pick.lots.join('/')) {
      out.problems.push(
        `${pick.name}: lots ${got.join('/')}, the export says ${pick.lots.join('/')}`,
      );
      continue;
    }
    if (!got) out.notes.push(`${pick.name}: lots not read`);
    if (algo.multiplier === null) out.notes.push(`${pick.name}: multiplier not read`);
    out.good.push(pick.name);
  }
  for (const a of today) {
    if (!a.enabled || wanted.has(a.name)) continue;
    if (isTool(a.name)) out.extra.push(`${a.name} (enabled)`);
    else out.notes.push(`also enabled for ${weekday} (not the tool's): ${a.name}`);
  }
  return out;
}

/**
 * BL-140 Phase 4: the line the 09:25 check adds when Settings › Automation has uploads and deploys
 * paused through today's session, so a pick that is not on the platform reads as expected, not as
 * a missed upload. Null when no pause covers today.
 */
export function pauseNote(pausedUntil: string | null): string | null {
  return pausedUntil
    ? `uploads and deploys are paused until ${pausedUntil} (Settings › Automation): missing picks are expected`
    : null;
}

/** The headline: "AlgoTest T1 3/3 · Quantiply Core 3/3 ✅", then what is missing or extra. */
export function deployMessage(
  day: string,
  at: string,
  checks: PlatformCheck[],
): { text: string; ok: boolean } {
  const ok = checks.every((c) => !c.error && !c.problems.length && !c.extra.length);
  const head = checks
    .map((c) => (c.error ? `${c.label} not read` : `${c.label} ${c.good.length}/${c.expected}`))
    .join(' · ');
  const lines = [`${head} ${ok ? '✅' : '⚠️'}`, `Deploy check ${day} ${at} (read-only)`];
  for (const c of checks) {
    if (c.error) lines.push(`❌ ${c.label}: ${c.error}`);
    for (const p of c.problems) lines.push(`❌ ${c.label}: ${p}`);
    for (const e of c.extra) lines.push(`➕ ${c.label} extra: ${e}`);
    for (const n of c.notes) lines.push(`· ${c.label}: ${n}`);
  }
  return { text: lines.join('\n'), ok };
}

// --- loss levels -----------------------------------------------------------------------------

export interface LossState {
  warned: boolean;
  alerted: boolean;
}

/** The levels `total` reaches that have not been sent today, deepest last. Each goes once a day. */
export function lossCrossings(total: number, state: LossState): Array<'warning' | 'alert'> {
  const out: Array<'warning' | 'alert'> = [];
  if (total <= LOSS_WARNING_INR && !state.warned && !state.alerted) out.push('warning');
  if (total <= LOSS_ALERT_INR && !state.alerted) out.push('alert');
  // past the alert level at the first reading: the alert alone says it
  return out.includes('alert') ? ['alert'] : out;
}

/** "Readable again" after this many readings in a row (hysteresis against a flapping feed). */
export const READABLE_AGAIN_AFTER = 3;
/** At most this many "cannot read" notices per platform a day; the last one says so. */
export const UNREADABLE_NOTICES_A_DAY = 3;

/** Per platform label: said unreadable (and not yet readable again), the readings in a row since, notices today. */
export interface MtmNoticeState {
  unreadable: Record<string, boolean>;
  readableRun: Record<string, number>;
  unreadableSaid: Record<string, number>;
}

export type MtmNotice = 'unreadable' | 'readable-again' | null;

/**
 * What to say about a platform's MTM after one reading (re-review of #276, C): "cannot read" the
 * first time it fails, then nothing until it has read `READABLE_AGAIN_AFTER` times in a row, then
 * "readable again", which re-arms the notice, so a later loss of the feed is announced too (at most
 * `UNREADABLE_NOTICES_A_DAY`). Updates only the run counter; `commitMtmNotice` records a notice once
 * Telegram took it.
 */
export function mtmNotice(s: MtmNoticeState, label: string, readable: boolean): MtmNotice {
  if (!readable) {
    s.readableRun[label] = 0;
    if (s.unreadable[label]) return null;
    return (s.unreadableSaid[label] ?? 0) < UNREADABLE_NOTICES_A_DAY ? 'unreadable' : null;
  }
  if (!s.unreadable[label]) return null;
  s.readableRun[label] = (s.readableRun[label] ?? 0) + 1;
  return (s.readableRun[label] ?? 0) >= READABLE_AGAIN_AFTER ? 'readable-again' : null;
}

export function commitMtmNotice(s: MtmNoticeState, label: string, notice: MtmNotice): void {
  if (notice === 'unreadable') {
    s.unreadable[label] = true;
    s.unreadableSaid[label] = (s.unreadableSaid[label] ?? 0) + 1;
  } else if (notice === 'readable-again') {
    s.unreadable[label] = false;
    s.readableRun[label] = 0;
  }
}

/** The text of a notice. */
export function mtmNoticeText(
  s: MtmNoticeState,
  label: string,
  notice: 'unreadable' | 'readable-again',
  at: string,
): string {
  if (notice === 'readable-again') {
    return `✅ Loss monitor ${at}: ${label}'s MTM reads again; the loss levels count it again`;
  }
  const n = (s.unreadableSaid[label] ?? 0) + 1;
  const tail =
    n >= UNREADABLE_NOTICES_A_DAY
      ? `said ${n} times today: not said again today`
      : 'said again only after it has read again';
  return `⚠️ Loss monitor ${at}: cannot read ${label}'s MTM; the loss levels count the other platform only until it can (${tail})`;
}

export interface MtmPart {
  /** `AlgoTest`, `Quantiply Angel One` */
  label: string;
  /** null = cannot be read now */
  inr: number | null;
}

export function lossMessage(
  level: 'warning' | 'alert',
  total: number,
  parts: MtmPart[],
  at: string,
): string {
  const head =
    level === 'alert'
      ? `🛑 LOSS ALERT ${at}: the tool's platforms are at ${inr(total)} today (alert level ${inr(LOSS_ALERT_INR)})`
      : `⚠️ Loss warning ${at}: the tool's platforms are at ${inr(total)} today (warning level ${inr(LOSS_WARNING_INR)})`;
  const lines = parts.map((p) => `${p.label}: ${p.inr === null ? 'cannot read' : inr(p.inr)}`);
  const partial = parts.some((p) => p.inr === null)
    ? ['(a platform cannot be read: the real figure may be lower)']
    : [];
  return [
    head,
    ...lines,
    ...partial,
    'AlgoTest + Quantiply only, open + booked; trades placed elsewhere are not counted.',
    'Alert only: nothing was squared off.',
  ].join('\n');
}

// --- Quantiply's live MTM (its web app's socket) ---------------------------------------------

/**
 * Quantiply's web app gets each algo's live MTM over its socket.io connection as a CSV string,
 * `<algo id>,,,,<pnl>,<error flags>,,<waiting>,<waitingWT>` (read from the app's bundle,
 * main.c34824e5.js, 2026-10-20: the reducer of SUBSCRIBE_LITE_POSITION_UPDATES does
 * `data.split(",")` and takes the 5th field as `pnl`, the MTM column). The monitor keeps the
 * app open on /algos and reads those frames as they arrive; it never sends one.
 */
export function pnlFromSocketFrame(payload: string): Array<{ id: string; pnl: number }> {
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  const body = payload.replace(/^\d+/, '');
  try {
    walk(JSON.parse(body));
  } catch {
    strings.push(payload);
  }
  const out: Array<{ id: string; pnl: number }> = [];
  for (const s of strings) {
    const parts = s.split(',');
    const id = parts[0] ?? '';
    const pnl = parts[4] ?? '';
    if (/^[0-9a-f]{24}$/i.test(id) && parts.length >= 5 && /^-?\d+(\.\d+)?$/.test(pnl.trim())) {
      out.push({ id, pnl: Number(pnl) });
    }
  }
  return out;
}

/** An algo's last MTM figure and when its frame arrived (ms). */
export interface PnlSeen {
  pnl: number;
  at: number;
}

/** A running algo's figure older than this is stale (the socket may be gone). */
export const PNL_STALE_MS = 3 * 60_000;

const secondsOf = (hms: string) => {
  const [h = '0', m = '0', s = '0'] = hms.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

/**
 * Quantiply's day MTM, or which algos make it unreadable. An algo of today's weekday counts if
 * it is enabled or its status is anything but NOT_RUNNING (whatever Quantiply calls running).
 * - Not started yet (NOT_RUNNING, before its start + 2 min): 0, no figure expected.
 * - Finished (TRADE_CLOSED, or NOT_RUNNING past its end): its last figure, of any age; none = unread.
 * - Otherwise (started or trading): a figure no older than `PNL_STALE_MS`, else unread.
 */
export function quantiplyReading(
  algos: QListed[],
  weekday: string,
  pnl: Record<string, PnlSeen>,
  nowMs: number,
  istSeconds: number,
): { inr: number | null; unread: string[] } {
  let total = 0;
  const unread: string[] = [];
  for (const a of algos) {
    if (a.day !== weekday || (!a.enabled && a.status === 'NOT_RUNNING')) continue;
    const seen = pnl[a.id];
    const startAt = a.startTime ? secondsOf(a.startTime) + 120 : 0;
    const endAt = a.endTime ? secondsOf(a.endTime) : Number.POSITIVE_INFINITY;
    const waiting = a.status === 'NOT_RUNNING' && istSeconds < startAt;
    const finished =
      a.status === 'TRADE_CLOSED' || (a.status === 'NOT_RUNNING' && istSeconds >= endAt);
    if (waiting && !seen) continue;
    if (finished) {
      if (seen) total += seen.pnl;
      else unread.push(a.name);
      continue;
    }
    if (!seen || nowMs - seen.at > PNL_STALE_MS) unread.push(a.name);
    else total += seen.pnl;
  }
  return unread.length ? { inr: null, unread } : { inr: total, unread };
}
