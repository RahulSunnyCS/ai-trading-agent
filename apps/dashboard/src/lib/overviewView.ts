/**
 * The Overview's morning board (components/OverviewView.tsx): what each of its six cards says,
 * worked out from the responses of endpoints the other pages already read. No React and no
 * fetching, so every rule is unit-tested on its own.
 *
 * A figure that does not exist is never a zero: each one comes back as `null` with the reason
 * the card shows next to a dash.
 */

import type { KiteStatus } from '../components/KiteCard';
import type { FyersAuthStatus } from '../hooks/useFyersAuthStatus';
import type { MomentumLiveRules, MomentumWeekView } from '../types/momentum';
import type { RotationCheckState, RotationOverview, RotationSummary } from '../types/rotation';
import type { RotationLiveResponse } from '../types/rotationLive';
import type { PlanAccountState, RotationPlan } from '../types/rotationPlan';
import type { TradeBookDaysResponse, TradeBookSummary } from '../types/tradeBook';
import { type AngelStatus, REASON_LABEL, angelCardState } from './angelOne';
import { formatDayShort, formatIstTime, formatPct, formatRelative } from './format';
import type { TokenState } from './market';
import { type SchedulerJob, type SchedulerRun, runStatus } from './scheduler';

/** How a line reads at a glance; the card draws it as a dot. */
export type LineTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export interface StatusLine {
  label: string;
  text: string;
  tone: LineTone;
  /** The longer explanation, for a tooltip. */
  detail?: string | undefined;
}

const CHECK_TONE: Record<RotationCheckState, LineTone> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  info: 'info',
};

// ---------------------------------------------------------------------------
// Rotation today
// ---------------------------------------------------------------------------

/** The list the owner follows with real money (Adaptive Classic), and its live book. */
export const ADAPTIVE_LIST = 'C';
export const ADAPTIVE_BOOK = 'core';

/** Today's entry, as the Rotation page's health strip states it ("due 09:16", "09:16:28 on time"). */
export function entryLine(overview: RotationOverview | null): StatusLine | null {
  const check = overview?.health?.checks?.find((c) => c.id === 'entry');
  if (!check) return null;
  return {
    label: check.label,
    text: check.value,
    tone: CHECK_TONE[check.state] ?? 'neutral',
    detail: check.detail || undefined,
  };
}

export interface PaperDay {
  day: string;
  /** Rupees at the summary's lots a strategy (the page asks for one). */
  value: number;
}

/** The newest scored day of a list in the forward read-out, or null before the first one. */
export function latestPaperDay(
  summary: RotationSummary | null,
  list: string = ADAPTIVE_LIST,
): PaperDay | null {
  const rows = summary?.days ?? [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const value = row?.[`${list}_total`];
    if (row && typeof value === 'number' && Number.isFinite(value)) return { day: row.day, value };
  }
  return null;
}

export interface LiveResult {
  /** Live per lot after costs, summed over the book's accounts; null when there is none. */
  value: number | null;
  /** The same trades on paper, on the same basis (per lot, after the same costs). */
  paper: number | null;
  /** Platform + broker accounts the figure covers. */
  accounts: number;
  /**
   * Why there is no value (not captured, no live trades, the capture failed), or, with a value,
   * why it may be incomplete (an account was not read).
   */
  reason: string | null;
}

/**
 * A book's live result on a day from the live capture (the Today page's Live vs paper card),
 * with the paper result of the same trades beside it. Both are per lot after the same costs, so
 * they compare with each other, not with the read-out's gross figure. A day not captured, or with
 * no trade of that book, is a reason, never a zero.
 */
export function liveForDay(
  live: RotationLiveResponse | null,
  day: string,
  book: string = ADAPTIVE_BOOK,
): LiveResult {
  const none = (reason: string): LiveResult => ({ value: null, paper: null, accounts: 0, reason });
  if (!live || !Array.isArray(live.days)) return none('live results unavailable');
  const row = live.days.find((d) => d.day === day);
  if (!row || !row.captured) return none('live not captured');
  const failed = Array.isArray(row.failed_sections) && row.failed_sections.length > 0;
  const groups = row.groups.filter((g) => g.book === book);
  if (groups.length === 0) return none(failed ? 'capture failed for an account' : 'no live trades');
  return {
    value: groups.reduce((sum, g) => sum + g.live, 0),
    paper: groups.reduce((sum, g) => sum + g.paper, 0),
    accounts: groups.length,
    reason: failed ? 'an account was not read' : null,
  };
}

export interface ReadoutProgress {
  /** Forward days scored so far. */
  day: number;
  /** The registered read-out length (60). */
  of: number;
  /** The list's total since the first day, at the summary's lots. */
  sinceFirst: number | null;
  firstDay: string | null;
}

export function readoutProgress(
  summary: RotationSummary | null,
  list: string = ADAPTIVE_LIST,
): ReadoutProgress | null {
  if (!summary || typeof summary.n_days !== 'number') return null;
  const stats = summary.lists?.[list as keyof RotationSummary['lists']];
  // The read-out's registered length, which /summary carries beside n_days (60).
  const of = (summary as { readout_days?: unknown }).readout_days;
  return {
    day: summary.n_days,
    of: typeof of === 'number' ? of : 60,
    sinceFirst: stats && Number.isFinite(stats.total) ? stats.total : null,
    firstDay: summary.first_day,
  };
}

/** The Data card: the Rotation page's health checks, less today's entry (the Rotation card's). */
export function dataLines(overview: RotationOverview | null): StatusLine[] | null {
  const checks = overview?.health?.checks;
  if (!Array.isArray(checks)) return null;
  return checks
    .filter((check) => check.id !== 'entry')
    .map((check) => ({
      label: check.label,
      text: check.value,
      tone: CHECK_TONE[check.state] ?? 'neutral',
      detail: check.detail || undefined,
    }));
}

// ---------------------------------------------------------------------------
// Momentum this week
// ---------------------------------------------------------------------------

export interface MomentumWeekSummary {
  name: string;
  /** "Friday 3 of 4 trades on Fri 30 Oct", or null when the week view does not say. */
  nextTrade: string | null;
}

/** The headline favourite and which of its sleeves trades next. Null when there is no headline. */
export function momentumHeadline(week: MomentumWeekView | null): MomentumWeekSummary | null {
  const card = week?.favourites?.find((c) => c.headline);
  if (!card) return null;
  const edge = card.edge;
  let nextTrade: string | null = null;
  if (edge?.on) {
    const when = formatDayShort(edge.on, { weekday: true });
    const prefix = `${card.name} · `;
    const sleeve = edge.sleeve?.startsWith(prefix) ? edge.sleeve.slice(prefix.length) : edge.sleeve;
    nextTrade = sleeve ? `${sleeve} trades on ${when}` : `Trades on ${when}`;
  }
  return { name: card.name, nextTrade };
}

/** The live-money rules' state from the latest check, and the drawdown against its cut line. */
export function rulesLine(rules: MomentumLiveRules | null): StatusLine {
  const report = rules?.report ?? null;
  if (!report) return { label: 'Rules', text: 'not checked yet', tone: 'neutral' };
  const { drawdown, cut_half_at: cut } = report.numbers ?? {};
  const dd =
    typeof drawdown === 'number' && typeof cut === 'number'
      ? ` · drawdown ${formatPct(drawdown)} of ${formatPct(-Math.abs(cut), 0)}`
      : '';
  if (report.breached)
    return { label: 'Rules', text: `breached${dd}`, tone: 'bad', detail: report.title };
  if (report.findings?.some((f) => f.needs_you)) {
    return { label: 'Rules', text: `need you${dd}`, tone: 'warn', detail: report.title };
  }
  if (report.stale) {
    return {
      label: 'Rules',
      text: `last check is behind${dd}`,
      tone: 'warn',
      detail: `The check covers an older week than ${report.stale}.`,
    };
  }
  return { label: 'Rules', text: `all clear${dd}`, tone: 'ok', detail: report.title };
}

const IST_OFFSET_MS = 330 * 60_000;

/** Friday before 14:15 IST, when the Momentum orders need today's Kite login. */
export function beforeFridayOrders(now: number): boolean {
  const ist = new Date(now + IST_OFFSET_MS);
  return ist.getUTCDay() === 5 && ist.getUTCHours() * 60 + ist.getUTCMinutes() < 14 * 60 + 15;
}

/**
 * Kite (the Momentum money's broker): logged in today or not. Its token dies at 06:00 each day
 * and only Friday's 14:15 orders need it, so a missing login warns only on a Friday morning.
 */
export function kiteLine(kite: KiteStatus | null, now: number): StatusLine {
  if (!kite) return { label: 'Kite', text: 'status unavailable', tone: 'neutral' };
  if (!kite.configured) return { label: 'Kite', text: 'not configured', tone: 'neutral' };
  if (kite.connected) {
    return {
      label: 'Kite',
      text: kite.expiresAt ? `logged in until ${formatIstTime(kite.expiresAt)}` : 'logged in today',
      tone: 'ok',
    };
  }
  if (kite.holdingsSource === 'kite' && beforeFridayOrders(now)) {
    return { label: 'Kite', text: 'not logged in today · log in before 14:15', tone: 'warn' };
  }
  return kite.holdingsSource === 'kite'
    ? {
        label: 'Kite',
        text: 'not logged in today · needed for the Fri 14:15 orders',
        tone: 'neutral',
      }
    : { label: 'Kite', text: 'not logged in today', tone: 'neutral' };
}

// ---------------------------------------------------------------------------
// Trade book
// ---------------------------------------------------------------------------

export interface TradeBookOverview {
  lastNoteDay: string | null;
  latest: { day: string; net: number } | null;
  /** The month of `today`; null when no note of that month is in yet. */
  monthToDate: { month: string; net: number; sessions: number } | null;
  fyNet: number | null;
  /** Percent of capital (already in percent units). */
  fyPct: number | null;
}

/**
 * The current financial year's F&O book: the newest day with a note, this month so far and the
 * year so far. `days` are the year's rows; a row with no note (`profit` null) counts nowhere.
 */
export function tradeBookOverview(
  summary: TradeBookSummary | null,
  days: TradeBookDaysResponse | null,
  today: string,
): TradeBookOverview | null {
  if (!summary?.summary) return null;
  const rows = (days?.days ?? []).filter(
    (row): row is typeof row & { profit: number } => typeof row.profit === 'number',
  );
  const last = rows.at(-1);
  const month = today.slice(0, 7);
  const inMonth = rows.filter((row) => row.day.startsWith(month));
  return {
    lastNoteDay: summary.last_note_day,
    latest: last ? { day: last.day, net: last.profit } : null,
    monthToDate: inMonth.length
      ? { month, net: inMonth.reduce((sum, row) => sum + row.profit, 0), sessions: inMonth.length }
      : null,
    fyNet: summary.summary.sessions > 0 ? summary.summary.net : null,
    fyPct: summary.summary.profit_pct,
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const JOBS_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface JobsOverview {
  /** Jobs whose latest run failed in the window, newest first. */
  failed: SchedulerJob[];
  /**
   * Jobs whose latest run failed before the window and that have not run since (a Friday job
   * that failed is still failing on Sunday), newest first.
   */
  failedEarlier: SchedulerJob[];
  succeeded: number;
  running: number;
  /** Jobs with no run in the window whose latest run did not fail (or that never ran). */
  quiet: number;
}

function runTime(run: SchedulerRun): number {
  return Date.parse(run.ended_at ?? run.started_at);
}

function newestFirst(a: SchedulerJob, b: SchedulerJob): number {
  return runTime(b.lastRun as SchedulerRun) - runTime(a.lastRun as SchedulerRun);
}

/** The scheduler's jobs split by how their latest run went in the last 24 hours. */
export function jobsOverview(jobs: readonly SchedulerJob[], now: number): JobsOverview {
  const since = now - JOBS_WINDOW_MS;
  const out: JobsOverview = { failed: [], failedEarlier: [], succeeded: 0, running: 0, quiet: 0 };
  for (const job of jobs) {
    const run = job.lastRun;
    const status = runStatus(run);
    const recent = run !== null && runTime(run) >= since;
    if (status === 'running') out.running += 1;
    else if (status === 'failed') (recent ? out.failed : out.failedEarlier).push(job);
    else if (recent) out.succeeded += 1;
    else out.quiet += 1;
  }
  out.failed.sort(newestFirst);
  out.failedEarlier.sort(newestFirst);
  return out;
}

const GENERIC_ERROR = /^exit -?\d+$/;
const MAX_REASON = 140;

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > MAX_REASON ? `${one.slice(0, MAX_REASON - 1)}…` : one;
}

/**
 * One line on why a run failed. The run's own error when it says something ("missed: the
 * scheduler was not running…"); for a bare "exit 1", the last error line of its log (a line
 * starting "❌" or "!"), else the log's last line of output; else the error as it is.
 */
export function failureReason(run: SchedulerRun | null, logText: string | null): string {
  const error = run?.error?.trim() ?? '';
  if (error && !GENERIC_ERROR.test(error)) return clip(error);
  const lines = (logText ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('===') && !line.startsWith('$ '));
  const marked = [...lines].reverse().find((line) => /^(❌|!|✗|Error\b)/.test(line));
  const pick = marked ?? lines.at(-1);
  if (pick) return clip(pick.replace(/^(❌|!|✗)\s*/, ''));
  return error || 'failed';
}

// ---------------------------------------------------------------------------
// Logins
// ---------------------------------------------------------------------------

export function fyersLine(
  status: FyersAuthStatus | null,
  state: TokenState,
  error: string | null,
): StatusLine {
  if (!status) {
    return { label: 'Fyers', text: error ? 'status unavailable' : 'checking', tone: 'neutral' };
  }
  if (!status.configured) return { label: 'Fyers', text: 'not configured', tone: 'neutral' };
  const until = status.expiresAt ? formatIstTime(status.expiresAt) : null;
  switch (state) {
    case 'valid':
      return { label: 'Fyers', text: until ? `valid until ${until}` : 'valid', tone: 'ok' };
    case 'expiring':
      return {
        label: 'Fyers',
        text: until ? `expires at ${until}` : 'expiring soon',
        tone: 'warn',
      };
    case 'expired':
      return { label: 'Fyers', text: 'expired · log in again', tone: 'bad' };
    default:
      return { label: 'Fyers', text: 'no token · log in', tone: 'bad' };
  }
}

export function angelLine(status: AngelStatus | null, now: number): StatusLine {
  const check = status?.last_check ?? null;
  const state = angelCardState(status, check);
  const when = check ? ` · ${formatRelative(check.checked_at, now)}` : '';
  switch (state) {
    case 'unknown':
      return { label: 'Angel One', text: 'status unavailable', tone: 'neutral' };
    case 'not_configured':
      return { label: 'Angel One', text: 'not configured', tone: 'neutral' };
    case 'untested':
      return { label: 'Angel One', text: 'not tested yet', tone: 'neutral' };
    case 'working':
      return { label: 'Angel One', text: `login works${when}`, tone: 'ok' };
    default:
      return {
        label: 'Angel One',
        text: `${check ? REASON_LABEL[check.reason] : 'login failed'}${when}`,
        tone: 'bad',
        detail: check?.message,
      };
  }
}

/** The 08:02 morning broker login (scheduler job `broker-login`): its latest run. */
export function brokerLoginLine(job: SchedulerJob | null, now: number): StatusLine {
  const label = 'Morning login';
  if (!job) return { label, text: 'job not found', tone: 'neutral' };
  const run = job.lastRun;
  const status = runStatus(run);
  if (!run || !status) return { label, text: 'not run yet', tone: 'neutral' };
  const when = formatRelative(run.ended_at ?? run.started_at, now);
  if (status === 'running') return { label, text: 'running now', tone: 'info' };
  if (status === 'completed') return { label, text: `done ${when}`, tone: 'ok' };
  return {
    label,
    text: `failed ${when}`,
    tone: 'bad',
    detail: run.error ?? undefined,
  };
}

/**
 * The next session's tentative picks against what each uploading account holds
 * (`/legwise/rotation/plan`): "Wed 28 Oct · uploaded 3/3 Quantiply · Angel One, 3/3 Quantiply ·
 * Shoonya". Warns when any pick is missing on an account; null with no tentative list or no
 * account uploading. A ledger that cannot be read is said, never counted as nothing uploaded.
 */
export function nextSessionLine(plan: RotationPlan | null): StatusLine | null {
  const s = plan?.sessions.find((x) => x.kind === 'tentative');
  if (!plan || !s || plan.accounts.length === 0) return null;
  const parts: string[] = [];
  let missing = false;
  let unknown = false;
  for (const a of plan.accounts) {
    const picks = s.books[a.book] ?? [];
    if (picks.length === 0) continue;
    if ('error' in a.state) {
      unknown = true;
      parts.push(`${a.label} not known`);
      continue;
    }
    const st = (a.state as Record<string, PlanAccountState>)[s.day];
    const have = picks.filter((p) => st?.uploaded.includes(p.name)).length;
    if (have < picks.length) missing = true;
    parts.push(`${have}/${picks.length} ${a.label}`);
  }
  if (parts.length === 0) return null;
  return {
    label: `${formatDayShort(s.day, { weekday: true })} (tentative)`,
    text: `uploaded ${parts.join(', ')}`,
    tone: missing ? 'warn' : unknown ? 'neutral' : 'ok',
    detail:
      'The 16:00 message’s list for the next session against the uploaders’ ledgers; the 09:16 entry confirms it and the morning top-up uploads any change.',
  };
}
