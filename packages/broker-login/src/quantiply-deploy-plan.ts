import {
  FINISHED,
  type QAlgo,
  type QLedgerRow,
  SESSION_OVER_MINUTES,
  ownedIds,
  weekdayOf,
} from './quantiply-plan.js';

/**
 * What the Quantiply deployer (BL-139 Phase 4, `quantiply-deploy.ts`) does, decided without a
 * network. Enabling a Quantiply algo deploys it on the owner's real account for its weekday, every
 * week, until it is disabled. So:
 *
 * - Only algos the uploader created (its ledger, `ownedIds`) for the session (the ledger row's
 *   `day`) are ever enabled or disabled. Never an algo the owner made.
 * - Enable: an owned algo of the session that is one of the session's picks (the export's
 *   manifest), listed by Quantiply on the session's weekday, not enabled, finished, with the
 *   content the export holds (ledger sha and a fresh read-back), and either no broker (set to the
 *   account's own) or the account's own broker. For today's session, never within
 *   `ENABLE_LEAD_SECONDS` of its start: TOO LATE, for that algo only.
 * - An owned algo of the session that is no longer a pick (09:16 changed it) and is enabled is
 *   disabled again, if it has not started.
 * - Disable: after the session, every owned algo of the session that is enabled and finished,
 *   plus any owned algo of an earlier session still enabled (it would run again next week).
 * - Afterwards the list is read again (`verifyToggles`): exactly the intended ids changed.
 */

/** Never enable an algo for today this close to its start (seconds). */
export const ENABLE_LEAD_SECONDS = 90;

export type DeployMode = 'enable' | 'disable' | 'check';

/** What `GET /algos/:id` says that matters here, plus the read-back against the export. */
export interface AlgoDetail {
  id: string;
  day: string;
  enabled: boolean;
  status: string;
  /** `configurations.startTime`, `HH:MM:SS`; null when missing */
  startTime: string | null;
  /** the broker account id, '' when none is set */
  broker: string;
  /** read-back differences against the export's body; null when there is no body to compare */
  diffs: string[] | null;
}

export function parseDetail(raw: Record<string, unknown>): Omit<AlgoDetail, 'diffs'> {
  const conf = (raw.configurations ?? {}) as Record<string, unknown>;
  const start = conf.startTime;
  return {
    id: String(raw._id ?? ''),
    day: String(raw.day ?? ''),
    enabled: raw.enabled === true,
    status: typeof raw.status === 'string' ? raw.status : 'UNKNOWN',
    startTime: typeof start === 'string' && /^\d\d:\d\d(:\d\d)?$/.test(start) ? start : null,
    broker: typeof raw.broker === 'string' ? raw.broker : '',
  };
}

/** One broker account as `GET /brokers` lists it. */
export interface QBroker {
  id: string;
  clientId: string;
  status: string;
}

export function parseBrokers(json: unknown): QBroker[] {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('brokers list: no data array');
  return (data as Record<string, unknown>[]).map((b) => ({
    id: String(b.id ?? b._id ?? ''),
    clientId: String(b.clientId ?? ''),
    status: typeof b.status === 'string' ? b.status : '',
  }));
}

/**
 * The account's own broker id: the one listed broker whose client code is the account's (the
 * `.env` login). Anything but exactly one enabled match is refused; never a guess.
 */
export function pickBroker(
  brokers: QBroker[],
  clientCode: string,
): { id: string } | { error: string } {
  const want = clientCode.trim().toUpperCase();
  const same = brokers.filter((b) => b.id && b.clientId.trim().toUpperCase() === want);
  if (same.length !== 1) {
    return { error: `${same.length} broker accounts with the login's client code on Quantiply` };
  }
  if (same[0]?.status === 'disabled')
    return { error: 'the broker account is disabled on Quantiply' };
  return { id: same[0]?.id ?? '' };
}

/** IST seconds since midnight. */
export function istSeconds(now: Date = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
}

export function startSeconds(startTime: string): number {
  const [h = 0, m = 0, s = 0] = startTime.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** Calendar days from `from` to `to` (both `YYYY-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The session a run is for when `--day` is not given, and why. Enable: today while its session
 * is still to come (a trading day before 15:30 IST), else the next trading day. Disable and
 * check: today.
 */
export function defaultSession(
  mode: DeployMode,
  today: string,
  nowSeconds: number,
  isTradingDay: (day: string) => boolean,
): { day: string; why: string } {
  if (mode !== 'enable') return { day: today, why: 'today' };
  if (nowSeconds < SESSION_OVER_MINUTES * 60 && isTradingDay(today)) {
    return { day: today, why: 'today (before 15:30 IST)' };
  }
  for (let n = 1; n <= 14; n += 1) {
    const day = addDays(today, n);
    if (isTradingDay(day)) {
      return {
        day,
        why: `the next session (${isTradingDay(today) ? 'after 15:30 IST' : 'today is not a trading day'})`,
      };
    }
  }
  throw new Error(`no trading day in the 14 days after ${today}`);
}

export interface Target {
  id: string;
  name: string;
  startTime: string | null;
  /** set the account's broker before enabling (the upload leaves it unset) */
  setBroker: boolean;
}

export interface EnablePlan {
  /** the whole run is refused (nothing is changed) */
  refused: string | null;
  enable: Target[];
  /** owned picks of the session already enabled */
  already: string[];
  /** today's session, too close to its start: not enabled */
  tooLate: string[];
  /** owned algos of the session that are no longer picks, enabled, not started: disabled */
  dropped: Target[];
  /** the same, but maybe started or too close: left for the owner */
  droppedLive: string[];
  /** owned algos of the session that are no longer picks and are not enabled: left alone */
  notPicked: string[];
  /** picks with no owned algo for the session on Quantiply */
  missing: string[];
  /** picks with more than one owned algo on the weekday: none enabled */
  duplicates: string[];
  /** owned algos on another weekday than the session's (Quantiply's `day` or the ledger's) */
  wrongDay: string[];
  /** content differs from the export (ledger sha, a recorded read-back mismatch, or now) */
  differs: string[];
  /** a broker other than the account's own is set */
  brokerDiffers: string[];
  /** status not finished, or the algo could not be read */
  unexpected: string[];
}

export interface EnableInput {
  session: string;
  today: string;
  nowSeconds: number;
  /** the session's picks: name -> sha256 of the export's body file */
  picks: Map<string, string>;
  ledger: QLedgerRow[];
  algos: QAlgo[];
  details: Map<string, AlgoDetail>;
  brokerId: string;
}

/** Why a run for `session` must not change anything (enable), or null. */
export function refuseEnable(session: string, today: string, nowSeconds: number): string | null {
  const ahead = daysBetween(today, session);
  if (ahead < 0) return `${session} is in the past`;
  // Quantiply runs an enabled algo on the next occurrence of its weekday: 7 days ahead or more
  // would run on an earlier one (today's included).
  if (ahead > 6)
    return `${session} is ${ahead} days ahead: its ${weekdayOf(session)} algos would run on an earlier ${weekdayOf(session)}`;
  if (ahead === 0 && nowSeconds >= SESSION_OVER_MINUTES * 60) return `today's session is over`;
  return null;
}

/** Owned algos whose ledger create row is for `session`: id -> that row. */
export function ownedForSession(ledger: QLedgerRow[], session: string): Map<string, QLedgerRow> {
  const out = new Map<string, QLedgerRow>();
  for (const [id, row] of ownedIds(ledger)) if (row.day === session) out.set(id, row);
  return out;
}

function late(start: string | null, input: { session: string; today: string; nowSeconds: number }) {
  if (input.session !== input.today) return false;
  if (!start) return true;
  return startSeconds(start) - input.nowSeconds < ENABLE_LEAD_SECONDS;
}

export function planEnable(input: EnableInput): EnablePlan {
  const out: EnablePlan = {
    refused: refuseEnable(input.session, input.today, input.nowSeconds),
    enable: [],
    already: [],
    tooLate: [],
    dropped: [],
    droppedLive: [],
    notPicked: [],
    missing: [],
    duplicates: [],
    wrongDay: [],
    differs: [],
    brokerDiffers: [],
    unexpected: [],
  };
  if (out.refused) return out;
  const weekday = weekdayOf(input.session);
  const listed = new Map(input.algos.map((a) => [a.id, a]));
  const mine = ownedForSession(input.ledger, input.session);
  const byName = new Map<string, string[]>();
  for (const [id, row] of mine) {
    const a = listed.get(id);
    if (!a) continue; // deleted on Quantiply since: nothing to enable
    if (a.day !== weekday || row.weekday !== weekday) {
      out.wrongDay.push(`${a.name} (${a.day})`);
      continue;
    }
    byName.set(a.name, [...(byName.get(a.name) ?? []), id]);
  }

  for (const [name, ids] of byName) {
    if (!input.picks.has(name)) {
      for (const id of ids) {
        const a = listed.get(id) as QAlgo;
        if (!a.enabled) {
          out.notPicked.push(name);
          continue;
        }
        const d = input.details.get(id);
        const start = d?.startTime ?? null;
        if (a.status === 'NOT_RUNNING' && !late(start, input)) {
          out.dropped.push({ id, name, startTime: start, setBroker: false });
        } else out.droppedLive.push(name);
      }
      continue;
    }
    if (ids.length > 1) {
      out.duplicates.push(name);
      continue;
    }
    const id = ids[0] as string;
    const a = listed.get(id) as QAlgo;
    const row = mine.get(id) as QLedgerRow;
    const d = input.details.get(id);
    if (row.sha !== input.picks.get(name)) {
      out.differs.push(
        `${name} (${row.sha.startsWith('mismatch:') ? 'its read-back differed at upload' : 'not the export it was made from'})`,
      );
      continue;
    }
    if (!d) {
      out.unexpected.push(`${name} (not read)`);
      continue;
    }
    if (d.diffs === null || d.diffs.length) {
      out.differs.push(`${name} (now: ${d.diffs?.slice(0, 3).join(', ') || 'no export body'})`);
      continue;
    }
    if (d.day !== weekday) {
      out.wrongDay.push(`${name} (${d.day})`);
      continue;
    }
    if (d.broker && d.broker !== input.brokerId) {
      out.brokerDiffers.push(name);
      continue;
    }
    if (a.enabled || d.enabled) {
      out.already.push(name);
      continue;
    }
    if (!FINISHED.has(a.status)) {
      out.unexpected.push(`${name} (${a.status})`);
      continue;
    }
    if (!d.startTime) {
      out.unexpected.push(`${name} (no start time)`);
      continue;
    }
    if (late(d.startTime, input)) {
      out.tooLate.push(`${name} (${d.startTime})`);
      continue;
    }
    out.enable.push({ id, name, startTime: d.startTime, setBroker: !d.broker });
  }
  for (const name of input.picks.keys()) if (!byName.has(name)) out.missing.push(name);
  return out;
}

export interface DisablePlan {
  disable: Target[];
  /** enabled, but maybe running: left for the owner */
  live: string[];
  /** owned algos of the session already disabled */
  off: string[];
}

/**
 * Disable: owned algos of `session`, and of any earlier session, that Quantiply lists enabled.
 * Only finished ones (`NOT_RUNNING`, `TRADE_CLOSED`); anything else may hold a position.
 */
export function planDisable(
  session: string,
  today: string,
  ledger: QLedgerRow[],
  algos: QAlgo[],
): DisablePlan {
  const out: DisablePlan = { disable: [], live: [], off: [] };
  const listed = new Map(algos.map((a) => [a.id, a]));
  for (const [id, row] of ownedIds(ledger)) {
    if (row.day !== session && row.day >= today) continue;
    const a = listed.get(id);
    if (!a) continue;
    const label = row.day === session ? a.name : `${a.name} (${row.day})`;
    if (!a.enabled) {
      if (row.day === session) out.off.push(label);
      continue;
    }
    if (FINISHED.has(a.status))
      out.disable.push({ id, name: label, startTime: null, setBroker: false });
    else out.live.push(`${label} (${a.status})`);
  }
  return out;
}

/**
 * Check (read-only): owned algos still enabled that should not be, as of now: those of an
 * earlier session, and today's once today's session is over. They would run again next week.
 */
export function staleEnabled(
  today: string,
  nowSeconds: number,
  ledger: QLedgerRow[],
  algos: QAlgo[],
): string[] {
  const listed = new Map(algos.map((a) => [a.id, a]));
  const over = nowSeconds >= SESSION_OVER_MINUTES * 60;
  const out: string[] = [];
  for (const [id, row] of ownedIds(ledger)) {
    const a = listed.get(id);
    if (!a?.enabled) continue;
    if (row.day < today || (row.day === today && over))
      out.push(`${a.name} (${row.day}, ${a.day})`);
  }
  return out;
}

/**
 * After the calls: compare a fresh list with the one before. `intended`: id -> the `enabled` a
 * successful call set. `uncertain`: ids whose call failed (state unknown). Every intended id
 * must show its new state; every other algo must show the state it had; an uncertain one is
 * reported with what it shows. Any line returned means stop and alert.
 */
export function verifyToggles(
  before: QAlgo[],
  after: QAlgo[],
  intended: Map<string, boolean>,
  uncertain: Set<string> = new Set(),
): string[] {
  const now = new Map(after.map((a) => [a.id, a]));
  const was = new Map(before.map((a) => [a.id, a]));
  const state = (on: boolean) => (on ? 'ENABLED' : 'disabled');
  const problems: string[] = [];
  for (const [id, want] of intended) {
    const a = now.get(id);
    const name = a?.name ?? was.get(id)?.name ?? id;
    if (!a) problems.push(`${name}: no longer listed`);
    else if (a.enabled !== want)
      problems.push(`${name} (${a.day}) is ${state(a.enabled)}, expected ${state(want)}`);
  }
  for (const id of uncertain) {
    const a = now.get(id);
    const name = a?.name ?? was.get(id)?.name ?? id;
    problems.push(
      `${name}: the call failed; Quantiply now shows it ${a ? state(a.enabled) : 'not listed'}`,
    );
  }
  for (const b of before) {
    if (intended.has(b.id) || uncertain.has(b.id)) continue;
    const a = now.get(b.id);
    if (a && a.enabled !== b.enabled) {
      problems.push(`${b.name} (${b.day}) changed to ${state(a.enabled)}, not by this run`);
    }
  }
  for (const a of after) {
    if (!was.has(a.id) && a.enabled)
      problems.push(`${a.name} (${a.day}) appeared ENABLED, not by this run`);
  }
  return problems;
}

/** Human lines for an enable plan; `attention` when the owner should look. */
export function summaryEnable(p: EnablePlan): { lines: string[]; attention: boolean } {
  const lines: string[] = [];
  if (p.refused) return { lines: [`refused: ${p.refused}`], attention: true };
  const t = (x: Target) =>
    `${x.name}${x.startTime ? ` (${x.startTime})` : ''}${x.setBroker ? ' + set broker' : ''}`;
  if (p.enable.length) lines.push(`enable: ${p.enable.map(t).join(', ')}`);
  if (p.already.length) lines.push(`already enabled: ${p.already.join(', ')}`);
  if (p.dropped.length) lines.push(`disable, no longer a pick: ${p.dropped.map(t).join(', ')}`);
  if (p.notPicked.length) lines.push(`not a pick, left disabled: ${p.notPicked.join(', ')}`);
  if (p.tooLate.length) lines.push(`TOO LATE, not enabled: ${p.tooLate.join(', ')}`);
  if (p.droppedLive.length)
    lines.push(
      `⚠️ ENABLED, no longer a pick, may have started: check by hand: ${p.droppedLive.join(', ')}`,
    );
  if (p.missing.length)
    lines.push(`NOT ON QUANTIPLY (not uploaded), not enabled: ${p.missing.join(', ')}`);
  if (p.duplicates.length)
    lines.push(`MORE THAN ONE COPY, none enabled: ${p.duplicates.join(', ')}`);
  if (p.wrongDay.length) lines.push(`WRONG WEEKDAY, not enabled: ${p.wrongDay.join(', ')}`);
  if (p.differs.length) lines.push(`CONTENT DIFFERS, not enabled: ${p.differs.join(', ')}`);
  if (p.brokerDiffers.length)
    lines.push(`ANOTHER BROKER ACCOUNT SET, not enabled: ${p.brokerDiffers.join(', ')}`);
  if (p.unexpected.length) lines.push(`UNEXPECTED, not enabled: ${p.unexpected.join(', ')}`);
  if (!lines.length) lines.push('nothing to enable');
  const attention =
    p.tooLate.length +
      p.droppedLive.length +
      p.missing.length +
      p.duplicates.length +
      p.wrongDay.length +
      p.differs.length +
      p.brokerDiffers.length +
      p.unexpected.length >
    0;
  return { lines, attention };
}

export function summaryDisable(p: DisablePlan): { lines: string[]; attention: boolean } {
  const lines: string[] = [];
  if (p.disable.length) lines.push(`disable: ${p.disable.map((t) => t.name).join(', ')}`);
  if (p.off.length) lines.push(`already disabled: ${p.off.join(', ')}`);
  if (p.live.length) lines.push(`⚠️ ENABLED and may be running, NOT disabled: ${p.live.join(', ')}`);
  if (!lines.length) lines.push('nothing to disable');
  return { lines, attention: p.live.length > 0 };
}
