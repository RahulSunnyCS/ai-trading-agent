import {
  FINISHED,
  type QAlgo,
  type QLedgerRow,
  type QManifest,
  SESSION_OVER_MINUTES,
  ownedIds,
  weekdayOf,
} from './quantiply-plan.js';

/**
 * What the Quantiply deployer (BL-139 Phase 4, `quantiply-deploy.ts`) does, decided without a
 * network. Enabling a Quantiply algo deploys it on the owner's real account for its weekday, every
 * week, until it is disabled. So:
 *
 * - Only algos the uploader created (its ledger, `ownedIds`) for the session are ever enabled or
 *   disabled: the ledger row's `day` is the session, or the uploader kept an earlier copy on the
 *   session's weekday with the pick's content (`ownedForSession`). Never an algo the owner made.
 * - Enable: an owned algo of the session that is one of the session's picks (the export's
 *   manifest), listed by Quantiply on the session's weekday, not enabled, finished, with the
 *   content the export holds (ledger sha and a fresh read-back), and either no broker (set to the
 *   account's own) or the account's own broker. For today's session, never within
 *   `ENABLE_LEAD_SECONDS` of its start: TOO LATE, for that algo only. Never one this session's
 *   deploy ledger already shows switched on or off (the owner may have switched it off since).
 * - An owned algo of the session that is ENABLED but no longer a pick (09:16 changed it), or that
 *   fails any check above, is switched off again if it has not started; otherwise it is reported
 *   as ENABLED for the owner. A check never reports an enabled algo as merely "not enabled".
 * - Disable: every owned algo of the session that is enabled and finished, plus any owned algo of
 *   an earlier session still enabled (it would run again next week). Today's only once today's
 *   session is over, unless it is the emergency stop.
 * - Afterwards the list is read again (`verifyToggles`): exactly the intended ids changed, and no
 *   other algo of the tool's.
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
  /** the broker account id; '' when none is set; `UNKNOWN_BROKER` when set but not readable */
  broker: string;
  /** read-back differences against the export's body; null when there is no body to compare */
  diffs: string[] | null;
}

/** A broker that is set but in a shape this tool does not know: never equal to an account id. */
export const UNKNOWN_BROKER = '(set, unrecognised)';

/** `broker` as `GET /algos/:id` gives it: unset, an id, or set but unrecognised. */
export function parseBroker(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const id = o._id ?? o.id;
    if (typeof id === 'string' && id) return id;
  }
  return UNKNOWN_BROKER;
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
    broker: parseBroker(raw.broker),
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
 * `.env` login). No match or several matches (disabled accounts counted too) are refused, and so
 * is a single match that is disabled; never a guess.
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

/** An enabled algo to switch off, and why. `alert`: the owner should hear of it. */
export interface OffTarget extends Target {
  why: string;
  alert: boolean;
}

export interface EnablePlan {
  /** the whole run is refused (nothing is changed) */
  refused: string | null;
  enable: Target[];
  /** owned picks of the session already enabled */
  already: string[];
  /** today's session, too close to its start: not enabled */
  tooLate: string[];
  /** ENABLED owned algos of the session to switch off: no longer a pick, or a check failed */
  disable: OffTarget[];
  /** ENABLED and no longer a pick or failing a check, but maybe started: left for the owner */
  enabledLive: string[];
  /** switched on or off already this session (deploy ledger) and now off: left off */
  leftOff: string[];
  /** this session's enable call failed (deploy ledger) and the algo is off: left off, alerted */
  enableFailed: string[];
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
  /** the deploy ledger's last enable or disable row for this session, by algo id */
  toggled?: Map<string, DeployLedgerRow>;
}

/** One row of `deploy-ledger*.jsonl`. */
export interface DeployLedgerRow {
  at: string;
  session: string;
  mode: string;
  /** `sqoff`: the stop button's square-off & terminate (BL-143), `mode: 'stop'` */
  action: 'enable' | 'disable' | 'broker' | 'sqoff';
  id: string;
  name: string;
  ok: boolean;
  detail?: string;
}

export function parseDeployLedger(text: string): DeployLedgerRow[] {
  const rows: DeployLedgerRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as DeployLedgerRow | null;
      // only rows it can read: `null`, a number or a row without id or session is skipped. The
      // deploy ledger never blocks the disable safety net.
      if (
        row &&
        typeof row === 'object' &&
        typeof row.id === 'string' &&
        typeof row.session === 'string'
      )
        rows.push(row);
    } catch {
      // a torn last line is skipped
    }
  }
  return rows;
}

/**
 * Ids this tool switched on or off for `session`, each with its last such row. A failed call
 * counts too: its state was unknown, so the owner has been told and decides.
 */
export function toggledIds(rows: DeployLedgerRow[], session: string): Map<string, DeployLedgerRow> {
  const out = new Map<string, DeployLedgerRow>();
  for (const r of rows) {
    // a stop's square-off counts too (BL-143): a squared-off algo is never switched back on
    if (
      r.session === session &&
      (r.action === 'enable' || r.action === 'disable' || r.action === 'sqoff')
    )
      out.set(r.id, r);
  }
  return out;
}

/**
 * The session each algo was last switched on for (a successful enable row). A kept copy's ledger
 * `day` is an earlier week's; this says which session it is enabled for now.
 */
export function enabledSessions(rows: DeployLedgerRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.action !== 'enable' || !r.ok) continue;
    if (r.session > (out.get(r.id) ?? '')) out.set(r.id, r.session);
  }
  return out;
}

/** The session an owned algo belongs to: its ledger day, or a later session it was enabled for. */
function sessionOf(id: string, row: QLedgerRow, enabledFor?: Map<string, string>): string {
  const later = enabledFor?.get(id);
  return later && later > row.day ? later : row.day;
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

/**
 * Owned algos for `session`: id -> the ledger's create row. That row's `day` is the session, or
 * (with `picks`) it is an earlier copy on the session's weekday with a pick's exact content, which
 * the uploader's evening kept rather than made again.
 */
export function ownedForSession(
  ledger: QLedgerRow[],
  session: string,
  picks?: Map<string, string>,
): Map<string, QLedgerRow> {
  const weekday = weekdayOf(session);
  const out = new Map<string, QLedgerRow>();
  for (const [id, row] of ownedIds(ledger)) {
    const kept = row.day < session && row.weekday === weekday && picks?.get(row.name) === row.sha;
    if (row.day === session || kept) out.set(id, row);
  }
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
    disable: [],
    enabledLive: [],
    leftOff: [],
    enableFailed: [],
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
  const toggled = input.toggled ?? new Map<string, DeployLedgerRow>();
  const listed = new Map(input.algos.map((a) => [a.id, a]));
  const mine = ownedForSession(input.ledger, input.session, input.picks);
  const isOn = (id: string) =>
    listed.get(id)?.enabled === true || input.details.get(id)?.enabled === true;

  /** An enabled algo that must not stay on: off if it has not started, else the owner's. */
  const switchOff = (id: string, name: string, why: string, alert: boolean) => {
    const a = listed.get(id) as QAlgo;
    const start = input.details.get(id)?.startTime ?? null;
    if (a.status === 'NOT_RUNNING' && !late(start, input)) {
      out.disable.push({ id, name, startTime: start, setBroker: false, why, alert });
    } else out.enabledLive.push(`${name} (ENABLED and ${why}, ${a.status})`);
  };
  /** A failed check: on an enabled algo it is never just "not enabled". */
  const reject = (id: string, name: string, why: string, list: string[], label = name) => {
    if (isOn(id)) switchOff(id, name, why, true);
    else list.push(label);
  };

  const seen = new Set<string>(); // names of every owned algo of the session that is listed
  const byName = new Map<string, string[]>();
  for (const [id, row] of mine) {
    const a = listed.get(id);
    if (!a) continue; // deleted on Quantiply since: nothing to enable
    seen.add(a.name);
    if (a.day !== weekday || row.weekday !== weekday) {
      reject(id, a.name, `on ${a.day}, not ${weekday}`, out.wrongDay, `${a.name} (${a.day})`);
      continue;
    }
    byName.set(a.name, [...(byName.get(a.name) ?? []), id]);
  }

  for (const [name, ids] of byName) {
    if (!input.picks.has(name)) {
      for (const id of ids) {
        if (isOn(id)) switchOff(id, name, 'no longer a pick', false);
        else out.notPicked.push(name);
      }
      continue;
    }
    if (ids.length > 1) {
      out.duplicates.push(name);
      for (const id of ids) if (isOn(id)) switchOff(id, name, 'one of several copies', true);
      continue;
    }
    const id = ids[0] as string;
    const a = listed.get(id) as QAlgo;
    const row = mine.get(id) as QLedgerRow;
    const d = input.details.get(id);
    const last = toggled.get(id);
    if (last && !isOn(id)) {
      if (last.action === 'enable' && !last.ok) out.enableFailed.push(name);
      else out.leftOff.push(name);
      continue;
    }
    if (row.sha !== input.picks.get(name)) {
      const why = row.sha.startsWith('mismatch:')
        ? 'its read-back differed at upload'
        : 'not the export it was made from';
      reject(id, name, `content differs: ${why}`, out.differs, `${name} (${why})`);
      continue;
    }
    if (!d) {
      reject(id, name, 'not read', out.unexpected, `${name} (not read)`);
      continue;
    }
    if (d.diffs === null || d.diffs.length) {
      const why = `now: ${d.diffs?.slice(0, 3).join(', ') || 'no export body'}`;
      reject(id, name, `content differs: ${why}`, out.differs, `${name} (${why})`);
      continue;
    }
    if (d.day !== weekday) {
      reject(id, name, `on ${d.day}, not ${weekday}`, out.wrongDay, `${name} (${d.day})`);
      continue;
    }
    if (d.broker && d.broker !== input.brokerId) {
      reject(id, name, 'another broker account', out.brokerDiffers);
      continue;
    }
    if (isOn(id)) {
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
  for (const name of input.picks.keys()) if (!seen.has(name)) out.missing.push(name);
  return out;
}

export interface DisablePlan {
  disable: Target[];
  /** enabled, but maybe running: left for the owner */
  live: string[];
  /** owned algos of the session already disabled */
  off: string[];
  /** enabled on today's weekday while today's session is not over: left on (no `emergency`) */
  notYet: string[];
}

/**
 * Disable: owned algos of `session`, and of any earlier session, that Quantiply lists enabled.
 * Only finished ones (`NOT_RUNNING`, `TRADE_CLOSED`); anything else may hold a position. An algo
 * on today's weekday is left on until today's session is over (15:30 IST), unless `emergency`:
 * the owner's emergency stop, which switches off pending entries too.
 */
export function planDisable(
  session: string,
  today: string,
  ledger: QLedgerRow[],
  algos: QAlgo[],
  opts: { nowSeconds?: number; emergency?: boolean; enabledFor?: Map<string, string> } = {},
): DisablePlan {
  const out: DisablePlan = { disable: [], live: [], off: [], notYet: [] };
  const listed = new Map(algos.map((a) => [a.id, a]));
  const todayWeekday = weekdayOf(today);
  const over = (opts.nowSeconds ?? 0) >= SESSION_OVER_MINUTES * 60;
  for (const [id, row] of ownedIds(ledger)) {
    // a kept copy enabled for a later session belongs to that session, like a fresh copy
    const day = sessionOf(id, row, opts.enabledFor);
    if (day !== session && day >= today) continue;
    const a = listed.get(id);
    if (!a) continue;
    const label = day === session ? a.name : `${a.name} (${day})`;
    if (!a.enabled) {
      if (day === session) out.off.push(label);
      continue;
    }
    if (a.day === todayWeekday && !over && !opts.emergency) out.notYet.push(label);
    else if (FINISHED.has(a.status))
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
  enabledFor?: Map<string, string>,
): string[] {
  const listed = new Map(algos.map((a) => [a.id, a]));
  const over = nowSeconds >= SESSION_OVER_MINUTES * 60;
  const out: string[] = [];
  for (const [id, row] of ownedIds(ledger)) {
    const a = listed.get(id);
    if (!a?.enabled) continue;
    const day = sessionOf(id, row, enabledFor);
    if (day < today || (day === today && over)) out.push(`${a.name} (${day}, ${a.day})`);
  }
  return out;
}

/**
 * After the calls: compare a fresh list with the one before. `intended`: id -> the `enabled` a
 * successful call set. `uncertain`: ids whose call failed (state unknown). `owned`: the tool's
 * algos. Every intended id must show its new state, every other algo of the tool's the state it
 * had, and an uncertain one is reported with what it shows: those are `problems` (stop, alert).
 * A change on an algo the tool does not own is the owner's: a `note` only.
 */
export function verifyToggles(
  before: QAlgo[],
  after: QAlgo[],
  intended: Map<string, boolean>,
  uncertain: Set<string>,
  owned: Set<string>,
): { problems: string[]; notes: string[] } {
  const now = new Map(after.map((a) => [a.id, a]));
  const was = new Map(before.map((a) => [a.id, a]));
  const state = (on: boolean) => (on ? 'ENABLED' : 'disabled');
  const problems: string[] = [];
  const notes: string[] = [];
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
    if (!a || a.enabled === b.enabled) continue;
    const line = `${b.name} (${b.day}) changed to ${state(a.enabled)}, not by this run`;
    (owned.has(b.id) ? problems : notes).push(line);
  }
  for (const a of after) {
    if (!was.has(a.id) && a.enabled) notes.push(`${a.name} (${a.day}) appeared ENABLED`);
  }
  return { problems, notes };
}

/** Human lines for an enable plan; `attention` when the owner should look. */
export function summaryEnable(p: EnablePlan): { lines: string[]; attention: boolean } {
  const lines: string[] = [];
  if (p.refused) return { lines: [`refused: ${p.refused}`], attention: true };
  const t = (x: Target) =>
    `${x.name}${x.startTime ? ` (${x.startTime})` : ''}${x.setBroker ? ' + set broker' : ''}`;
  if (p.enable.length) lines.push(`enable: ${p.enable.map(t).join(', ')}`);
  if (p.already.length) lines.push(`already enabled: ${p.already.join(', ')}`);
  const routine = p.disable.filter((x) => !x.alert);
  const bad = p.disable.filter((x) => x.alert);
  if (routine.length) lines.push(`disable, no longer a pick: ${routine.map(t).join(', ')}`);
  if (bad.length)
    lines.push(`⚠️ disable, ENABLED and ${bad.map((x) => `${x.why}: ${x.name}`).join('; ')}`);
  if (p.leftOff.length)
    lines.push(`switched off since it was switched on, left off: ${p.leftOff.join(', ')}`);
  if (p.enableFailed.length)
    lines.push(
      `⚠️ ENABLE FAILED earlier this session, left off (enable it by hand if wanted): ${p.enableFailed.join(', ')}`,
    );
  if (p.notPicked.length) lines.push(`not a pick, left disabled: ${p.notPicked.join(', ')}`);
  if (p.tooLate.length) lines.push(`TOO LATE, not enabled: ${p.tooLate.join(', ')}`);
  if (p.enabledLive.length)
    lines.push(`⚠️ may have started, NOT switched off, check by hand: ${p.enabledLive.join(', ')}`);
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
    bad.length +
      p.enableFailed.length +
      p.tooLate.length +
      p.enabledLive.length +
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
  if (p.notYet.length) {
    lines.push(
      `today's session is not over, left ENABLED (the emergency stop switches them off): ${p.notYet.join(', ')}`,
    );
  }
  if (p.live.length) lines.push(`⚠️ ENABLED and may be running, NOT disabled: ${p.live.join(', ')}`);
  if (!lines.length) lines.push('nothing to disable');
  return { lines, attention: p.live.length > 0 };
}

/** Quantiply's weekday keys, as `GET /brokers` gives each account's clientwise settings. */
export const QUANTIPLY_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

/** The trailing options the clientwise dialog can add; the app sends at most one of them. */
const CLIENTWISE_TRAILS = ['trailingStoploss', 'lockProfit', 'trailProfit', 'lockTrailProfit'];

/** One weekday's clientwise stop-loss and target, as saved: `stoploss` is negative (−8000). */
export interface ClientwiseDay {
  stoploss: number | null;
  target: number | null;
  raw: Record<string, unknown>;
}

/**
 * BL-172: the account's clientwise settings per weekday from `GET /brokers` (`configurations`
 * keyed `MON`…`SUN`, docs/algotest-execution.md "Clientwise stop-loss and target"), for the one
 * broker `brokerId` (the account's own, from `pickBroker`).
 */
export function parseClientwise(json: unknown, brokerId: string): Record<string, ClientwiseDay> {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('brokers list: no data array');
  const broker = (data as Record<string, unknown>[]).find(
    (b) => String(b.id ?? b._id ?? '') === brokerId,
  );
  if (!broker) throw new Error('the account is not in the brokers list');
  const configs = (broker.configurations ?? {}) as Record<string, unknown>;
  const out: Record<string, ClientwiseDay> = {};
  for (const day of QUANTIPLY_WEEKDAYS) {
    const raw = (configs[day] ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    out[day] = { stoploss: num(raw.stoploss), target: num(raw.target), raw };
  }
  return out;
}

/** Every weekday's clientwise stop-loss is −`rupees`. */
export function clientwiseHolds(days: Record<string, ClientwiseDay>, rupees: number): boolean {
  return QUANTIPLY_WEEKDAYS.every((d) => days[d]?.stoploss === -Math.abs(rupees));
}

/** The stop-loss as it reads now, in words: one figure, none, or "differs by weekday". */
export function clientwiseNow(days: Record<string, ClientwiseDay>): string {
  const values = new Set(QUANTIPLY_WEEKDAYS.map((d) => days[d]?.stoploss ?? null));
  if (values.size > 1) return 'differs by weekday';
  const [only] = [...values];
  return only === null || only === undefined || only === 0
    ? 'none'
    : `₹${Math.abs(only).toLocaleString('en-IN')}`;
}

/**
 * The body of `POST /brokers/<id>/config` that sets the stop-loss to `rupees` and keeps what the
 * owner set besides it: Monday's target (0 when none) and its trailing option with the interval,
 * as the web app's dialog would send them (it reads Monday too). Null when every weekday already
 * holds the figure: nothing to send.
 */
export function clientwiseBody(
  days: Record<string, ClientwiseDay>,
  rupees: number,
): Record<string, unknown> | null {
  if (clientwiseHolds(days, rupees)) return null;
  const mon = days.MON?.raw ?? {};
  const body: Record<string, unknown> = {
    stoploss: -Math.abs(rupees),
    target: typeof mon.target === 'number' ? mon.target : 0,
  };
  const trail = CLIENTWISE_TRAILS.find(
    (k) => mon[k] && typeof mon[k] === 'object' && Object.keys(mon[k] as object).length,
  );
  if (trail) {
    body[trail] = mon[trail];
    if (mon.trailingInterval !== undefined) body.trailingInterval = mon.trailingInterval;
  }
  return body;
}

/** Whether any weekday's clientwise stop-loss is tighter than −`rupees` (or unset). */
export function clientwiseBelow(days: Record<string, ClientwiseDay>, rupees: number): boolean {
  return QUANTIPLY_WEEKDAYS.some((d) => {
    const v = days[d]?.stoploss;
    return v === null || v === undefined || v === 0 || Math.abs(v) < Math.abs(rupees);
  });
}

/** BL-183: what a doubled pick with no MTM SL of its own adds to the book stop, per extra lot. */
export const NO_STOP_EXTRA_INR = 4000;

/**
 * BL-183: how far the account's book stop (the clientwise MTM SL) rises for a session whose export
 * trades a pick at more than 1 lot (the picked Dir on a non-expiry day): each such pick's own MTM SL
 * per lot times its extra lots (₹4,000 a lot when it has none, the owner's rule). 0 when the export
 * doubles nothing. Read from the bodies the uploader sent, whose stop is already the doubled one.
 */
export function bookStopExtra(
  manifest: QManifest,
  body: Map<string, Record<string, unknown>>,
): number {
  if (!manifest.dir_boost) return 0;
  let extra = 0;
  for (const s of manifest.strategies) {
    const lots = s.lots ?? 1;
    if (s.addon || lots <= 1) continue;
    const cfg = body.get(s.name)?.configurations as { stoploss?: { value?: unknown } } | undefined;
    const v = cfg?.stoploss?.value;
    const perLot = typeof v === 'number' && v < 0 ? Math.abs(v) / lots : NO_STOP_EXTRA_INR;
    extra += perLot * (lots - 1);
  }
  return Math.round(extra);
}
